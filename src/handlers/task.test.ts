/**
 * What needs a failing database or a row the schema could not hold, which the tests on
 * the real schema in test/db/task-commands.test.ts cannot arrange.
 */

import { describe, expect, it, vi } from "vitest";
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
} from "../../test/support/interactions.ts";
import {
  mockPostgrest,
  testSnowflake,
  type MockResponse,
  type RecordedRequest,
} from "../../test/support/mock-postgrest.ts";
import { COMMANDS, ROUTER } from "./registry.ts";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const FAILED = { status: 503, body: { code: "XX000", message: "canary text" } };
const SUBCOMMAND = 1;

function database(
  answerTasks: (request: RecordedRequest) => MockResponse,
  config: unknown[] = [configRow()],
) {
  return mockPostgrest((request) => {
    const path = request.target.split("?")[0] ?? "";
    if (path.endsWith("/guild_config")) {
      return { body: config };
    }
    if (path.endsWith("/rpc/claim_interaction")) {
      return { body: true };
    }
    return answerTasks(request);
  });
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

describe("the commands as registered", () => {
  function optionNames(command: string, sub?: string): string[] {
    const definition = COMMANDS.find((item) => item.name === command);
    const { options = [] } = (definition ?? {}) as {
      options?: { name: string; options?: { name: string }[] }[];
    };
    return sub === undefined
      ? options.map((option) => option.name)
      : (options
          .find((option) => option.name === sub)
          ?.options?.map((option) => option.name) ?? []);
  }

  it("gives /mytasks no options, so it can only mean the caller", () => {
    expect(optionNames("mytasks")).toEqual([]);
  });

  it("offers only the options each subcommand needs", () => {
    expect(optionNames("task").sort()).toEqual([
      "assign",
      "delete",
      "done",
      "edit",
    ]);
    expect(optionNames("task", "assign")).toEqual([
      "person",
      "description",
      "due",
      "event",
    ]);
    expect(optionNames("task", "edit")).toEqual([
      "task",
      "description",
      "due",
      "person",
    ]);
    expect(optionNames("task", "delete")).toEqual(["task"]);
    expect(optionNames("task", "done")).toEqual(["task"]);
  });
});

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
    const { db } = database(() => ({ body: [] }), []);
    const { discord, edits } = fakeDiscord();

    const ran = await run(ROUTER, payload, dependenciesFor(db, discord));

    expect(ran.deferred).toBe(false);
    expect(ran.reply.data?.content).toBe(
      "You can't do that, or it doesn't exist.",
    );
    expect(edits).toEqual([]);
  });

  it("offers nothing in a picker", async () => {
    const { db, requests } = database(() => ({ body: [] }), []);
    const { discord } = fakeDiscord();

    const ran = await run(
      ROUTER,
      donePicker({ member: member() }),
      dependenciesFor(db, discord),
    );

    expect(ran.reply.data?.choices).toEqual([]);
    expect(requests.map((request) => request.target)).toEqual([
      expect.stringContaining("/guild_config"),
    ]);
  });
});

describe("a failing database", () => {
  it("answers a click with the fixed text, repeating nothing from the database", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { db } = database(() => FAILED);
    const { discord, edits } = fakeDiscord();

    await run(
      ROUTER,
      componentPayload(`task.done:${TASK_ID}`, {
        member: member(),
        message: { id: testSnowflake(), flags: 0 },
      }),
      dependenciesFor(db, discord),
    );

    expect(edits).toHaveLength(1);
    expect(edits[0]?.content).not.toContain("canary");
    expect(edits[0]?.content).not.toContain("doesn't exist");
    vi.restoreAllMocks();
  });

  it("reads nothing before answering beyond the guild's config", async () => {
    const { db, requests } = database(() => FAILED);
    const { discord } = fakeDiscord();
    const { interaction, verified } = verify(doneCommand({ member: member() }));

    const outcome = await ROUTER.handle(
      interaction,
      verified,
      dependenciesFor(db, discord),
    );

    expect(outcome.after).toBeDefined();
    expect(requests.map((request) => request.target)).toEqual([
      expect.stringContaining("/guild_config"),
    ]);
  });

  it("answers /mytasks with the fixed text, repeating nothing from the database", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { db } = database(() => FAILED);
    const { discord, edits } = fakeDiscord();

    await run(
      ROUTER,
      commandPayload("mytasks", { member: member() }),
      dependenciesFor(db, discord),
    );

    expect(edits[0]?.content).toContain("Something went wrong");
    expect(edits[0]?.content).not.toContain("canary");
    vi.restoreAllMocks();
  });

  it("offers nothing in a picker", async () => {
    const { db } = database(() => FAILED);
    const { discord } = fakeDiscord();

    const ran = await run(
      ROUTER,
      donePicker({ member: member({ roles: [OFFICER_ROLE] }) }),
      dependenciesFor(db, discord),
    );

    expect(ran.reply.data?.choices).toEqual([]);
  });
});

describe("/mytasks with a row that fails its checks", () => {
  it("counts it as hidden and logs nothing from the row", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { db } = database(() => ({
      body: [
        {
          id: TASK_ID,
          event_id: TASK_ID,
          description: "Fine",
          due_date: "2040-01-01",
          events: { name: "Meeting" },
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          event_id: TASK_ID,
          description: "canary row",
          due_date: "not a date",
          events: { name: "Meeting" },
        },
      ],
    }));
    const { discord, edits } = fakeDiscord();

    await run(
      ROUTER,
      commandPayload("mytasks", { member: member() }),
      dependenciesFor(db, discord),
    );

    expect(edits[0]?.content).toContain("Fine");
    expect(edits[0]?.content).toContain("...and 1 more.");
    expect(edits[0]?.content).not.toContain("canary");
    expect(JSON.stringify(log.mock.calls)).not.toContain("canary");
    vi.restoreAllMocks();
  });
});
