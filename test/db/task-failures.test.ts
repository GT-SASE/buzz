/**
 * The task commands before /setup and with a failing database, which the tests in
 * task-done.test.ts and task-manage.test.ts do not arrange.
 */

import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ROUTER } from "../../src/handlers/registry.ts";
import {
  autocompletePayload,
  commandPayload,
  componentPayload,
  configRow,
  dependenciesFor,
  fakeDiscord,
  member,
  OFFICER_ROLE,
  run,
  verify,
} from "../support/interactions.ts";
import { fakeId } from "../support/ids.ts";
import { handlerDb } from "./handler-db.ts";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const SUBCOMMAND = 1;

/** Set up, with every statement on tasks failing. */
async function failingDb() {
  const w = await handlerDb({ config: configRow() });
  w.fail("tasks");
  return w;
}

function doneCommand(fields: Record<string, unknown>) {
  return commandPayload("task", fields, {
    options: [
      {
        name: "done",
        type: SUBCOMMAND,
        options: [{ name: "task", type: 3, value: TASK_ID }],
      },
    ],
  });
}

function assignCommand(fields: Record<string, unknown>) {
  return commandPayload("task", fields, {
    options: [{ name: "assign", type: SUBCOMMAND, options: [] }],
  });
}

function donePicker(fields: Record<string, unknown>) {
  const base = autocompletePayload("task", "room", fields);
  return {
    ...base,
    data: {
      ...(base.data as object),
      options: [
        {
          name: "done",
          type: SUBCOMMAND,
          options: [{ name: "task", type: 3, value: "room", focused: true }],
        },
      ],
    },
  };
}

describe("before setup", () => {
  it.each([
    ["/mytasks", commandPayload("mytasks", { member: member() })],
    ["/task done", doneCommand({ member: member() })],
    ["/task assign", assignCommand({ member: member() })],
    [
      "the button",
      componentPayload(`task.done:${TASK_ID}`, { member: member() }),
    ],
  ])("refuses %s, however the member is placed", async (_name, payload) => {
    const { db } = await handlerDb();
    const { discord, edits } = fakeDiscord();

    const ran = await run(ROUTER, payload, dependenciesFor(db, discord));

    expect(ran.deferred).toBe(false);
    expect(ran.reply.data?.content).toBe(
      "You can't do that, or it doesn't exist.",
    );
    expect(edits).toEqual([]);
  });

  it("offers nothing in a picker, after reading only the config", async () => {
    const w = await handlerDb();
    const { discord } = fakeDiscord();

    const ran = await run(
      ROUTER,
      donePicker({ member: member() }),
      dependenciesFor(w.db, discord),
    );

    expect(ran.reply.data?.choices).toEqual([]);
    expect(w.sent()).toBe(1);
  });
});

describe("a failing database", () => {
  beforeEach(() => {
    spyOn(console, "error").mockImplementation(() => undefined);
  });

  it.each([
    [
      "a click",
      componentPayload(`task.done:${TASK_ID}`, {
        member: member(),
        message: { id: fakeId(), flags: 0 },
      }),
    ],
    ["/mytasks", commandPayload("mytasks", { member: member() })],
  ])("answers %s with the fixed text", async (_name, payload) => {
    const { db } = await failingDb();
    const { discord, edits } = fakeDiscord();

    await run(ROUTER, payload, dependenciesFor(db, discord));

    expect(edits).toHaveLength(1);
    expect(edits[0]?.content).toContain("Something went wrong");
  });

  it("reads only the guild's config before answering", async () => {
    const w = await failingDb();
    const { discord } = fakeDiscord();
    const { interaction, verified } = verify(doneCommand({ member: member() }));

    const outcome = await ROUTER.handle(
      interaction,
      verified,
      dependenciesFor(w.db, discord),
    );

    expect(outcome.after).toBeDefined();
    expect(w.sent()).toBe(1);
  });

  it("offers nothing in a picker", async () => {
    const { db } = await failingDb();
    const { discord } = fakeDiscord();

    const ran = await run(
      ROUTER,
      donePicker({ member: member({ roles: [OFFICER_ROLE] }) }),
      dependenciesFor(db, discord),
    );

    expect(ran.reply.data?.choices).toEqual([]);
  });
});
