/**
 * The officer quota counts new tasks and reassignments together, and each trigger has its
 * own 24-hour clause for each. access-layer.test.ts covers a kind ageing out against the
 * same kind, and these cover the two crossed cases: without them, old rows of the other
 * kind could count forever and lock an officer out for good.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { reassignAs } from "./task-edits.ts";
import type { DbClient } from "../../src/db/client.ts";
import { createTask } from "../../src/db/tasks.ts";
import { parseIsoDate } from "../../src/lib/dates.ts";
import { openBackend, type Backend } from "./backend.ts";
import { insertEvent, insertGuild, type GuildFixture } from "./fixtures.ts";
import { fakeId, type Connection } from "./harness.ts";

/** The limits the database's triggers enforce. */
const OFFICER_DAILY_LIMIT = 50;

const DUE = parseIsoDate("2030-01-10");
const ACTOR_LIMIT = {
  ok: false,
  error: { category: "actor_task_limit", code: "CF430" },
};

let backend: Backend;
let pg: Connection;
let db: DbClient;
let guild: GuildFixture;

beforeAll(async () => {
  backend = await openBackend();
  pg = backend.connection;
  db = backend.db;
  guild = await insertGuild(pg);
});

afterAll(() => backend.close());

function newTask(eventId: string, actorId: string) {
  if (DUE === null) throw new Error("bad test date");
  return createTask(db, {
    guildId: guild.guildId,
    eventId,
    assigneeId: fakeId(),
    actorId,
    description: "Print the signs",
    dueDate: DUE,
  });
}

function reassign(taskId: string, actorId: string) {
  return reassignAs(db, { guildId: guild.guildId, actorId, taskId });
}

async function taskIdOn(eventId: string): Promise<string> {
  const created = await newTask(eventId, fakeId());
  if (!created.ok) throw new Error("expected a task");
  return created.value.id;
}

it("stops counting old reassignments toward a new task", async () => {
  const actorId = fakeId();
  const eventId = await insertEvent(pg, guild);
  const taskId = await taskIdOn(eventId);
  for (let i = 0; i < OFFICER_DAILY_LIMIT; i += 1) {
    expect((await reassign(taskId, actorId)).ok).toBe(true);
  }
  expect(await newTask(eventId, actorId)).toEqual(ACTOR_LIMIT);

  await pg.query(
    `UPDATE public.task_reassignments SET created_at = now() - interval '25 hours'
     WHERE actor_id = $1`,
    [actorId],
  );

  expect((await newTask(eventId, actorId)).ok).toBe(true);
});

it("stops counting old tasks toward a reassignment", async () => {
  const actorId = fakeId();
  const eventId = await insertEvent(pg, guild);
  const taskId = await taskIdOn(eventId);
  for (let i = 0; i < OFFICER_DAILY_LIMIT; i += 1) {
    expect((await newTask(eventId, actorId)).ok).toBe(true);
  }
  expect(await reassign(taskId, actorId)).toEqual(ACTOR_LIMIT);

  await pg.query(
    `UPDATE public.tasks SET created_at = now() - interval '25 hours'
     WHERE created_by = $1`,
    [actorId],
  );

  expect((await reassign(taskId, actorId)).ok).toBe(true);
});
