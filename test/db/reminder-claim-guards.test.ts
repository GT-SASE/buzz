import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  FIXTURE_DUE_DATE as DUE,
  insertEvent,
  insertGuild,
  insertTask,
} from "./fixtures.ts";
import { MIGRATION_OWNER, createMigratedDb, queryAs } from "./harness.ts";

const turnOff = (version: number, on: boolean) =>
  `SELECT public.apply_config_change($1, ${String(version)}, $1, ${String(on)})`;

/** Each change, given the guild, must stop new claims and takeovers, with the task still open. */
const STOPPERS: [string, string, string][] = [
  ["reminders turned off", "bot_app", turnOff(2, false)],
  [
    "the channel removed",
    MIGRATION_OWNER,
    `UPDATE public.managed_channels SET status = 'removed' WHERE guild_id = $1`,
  ],
  [
    "the channel unavailable",
    "bot_app",
    `SELECT public.mark_channel_unavailable(guild_id, channel_id)
     FROM public.managed_channels WHERE guild_id = $1`,
  ],
  [
    "the event closed",
    "bot_app",
    `UPDATE public.events SET status = 'closed' WHERE guild_id = $1`,
  ],
  [
    "the event deleted with its task left live",
    MIGRATION_OWNER,
    `UPDATE public.events SET deleted_at = now() WHERE guild_id = $1`,
  ],
];

describe("reminder claims check the task's parents", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  const setUp = async () => {
    const own = await insertGuild(db);
    const eventId = await insertEvent(db, own);
    const taskId = await insertTask(db, own, eventId);
    const stop = (role: string, sql: string) =>
      queryAs(db, role, sql, [own.guildId]);
    return { taskId, stop };
  };

  const tokenOf = async (sql: string, params: unknown[]) => {
    const rows = await queryAs<{ token: string | null }>(
      db,
      "bot_app",
      sql,
      params,
    );
    return rows[0]?.token ?? null;
  };

  const claim = (taskId: string) =>
    tokenOf(`SELECT public.claim_reminder($1, 'due_day', '${DUE}') AS token`, [
      taskId,
    ]);

  const reclaim = (taskId: string, token: string) =>
    tokenOf(
      `SELECT public.reclaim_reminder($1, 'due_day', '${DUE}', $2, 120) AS token`,
      [taskId, token],
    );

  const age = (taskId: string) =>
    db.query(
      `UPDATE public.reminder_log SET claimed_at = now() - interval '2 hours' WHERE task_id = $1`,
      [taskId],
    );

  it("takes over a stale claim when nothing has stopped reminders", async () => {
    const { taskId } = await setUp();
    const token = await claim(taskId);
    expect(token).not.toBeNull();
    await age(taskId);
    expect(await reclaim(taskId, token ?? "")).not.toBeNull();
  });

  it.each(STOPPERS)(
    "refuses a new claim after %s",
    async (_name, role, sql) => {
      const { taskId, stop } = await setUp();
      await stop(role, sql);
      expect(await claim(taskId)).toBeNull();
      const { rows } = await db.query(
        `SELECT 1 FROM public.reminder_log WHERE task_id = $1`,
        [taskId],
      );
      expect(rows).toEqual([]);
    },
  );

  it.each(STOPPERS)("refuses a takeover after %s", async (_name, role, sql) => {
    const { taskId, stop } = await setUp();
    const token = await claim(taskId);
    await age(taskId);
    await stop(role, sql);
    expect(await reclaim(taskId, token ?? "")).toBeNull();
    const { rows } = await db.query<{ attempts: number; token: string | null }>(
      `SELECT attempts, claim_token AS token FROM public.reminder_log WHERE task_id = $1`,
      [taskId],
    );
    expect(rows).toEqual([{ attempts: 1, token }]);
  });

  it("is not stopped by another guild turning reminders off", async () => {
    const { taskId } = await setUp();
    const other = await insertGuild(db);
    await queryAs(db, "bot_app", turnOff(2, false), [other.guildId]);
    expect(await claim(taskId)).not.toBeNull();
  });
});
