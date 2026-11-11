import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  HOSTILE_TEXT,
  hasLiveSyntax,
  INVISIBLE_TEXT,
} from "../../test/support/hostile-text.ts";
import {
  mockPostgrest,
  testSnowflake,
  type RecordedRequest,
} from "../../test/support/mock-postgrest.ts";
import { DiscordClientError, DiscordErrorCode } from "../discord/client.ts";
import type { DiscordClient, DiscordFailure } from "../discord/client.ts";
import { safe, safeTextValue } from "../discord/safe-text.ts";
import type { EventRow, TaskRow } from "../db/types.ts";
import type { DateOnly } from "../lib/dates.ts";
import { fitLines, refreshOverview, renderOverview } from "./overview.ts";

const GUILD = testSnowflake();
const FORUM = testSnowflake();
const THREAD = testSnowflake();
const OVERVIEW = testSnowflake();
const CREATOR = testSnowflake();
const ASSIGNEE = testSnowflake();
const EVENT_ID = "11111111-1111-4111-8111-111111111111";

function eventRow(fields: Partial<EventRow> = {}): EventRow {
  return {
    id: EVENT_ID,
    guild_id: GUILD,
    channel_id: FORUM,
    name: "Fall Social",
    event_date: "2099-01-15" as DateOnly,
    thread_id: THREAD,
    overview_message_id: OVERVIEW,
    status: "active",
    thread_status: "active",
    created_by: CREATOR,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00+00:00",
    ...fields,
  };
}

let nextTask = 0;

function taskRow(fields: Partial<TaskRow> = {}): TaskRow {
  nextTask += 1;
  return {
    id: `22222222-2222-4222-8222-${String(nextTask).padStart(12, "0")}`,
    event_id: EVENT_ID,
    guild_id: GUILD,
    assignee_id: ASSIGNEE,
    description: "Book the room",
    due_date: "2099-01-10" as DateOnly,
    status: "open",
    completed_at: null,
    created_by: CREATOR,
    deleted_at: null,
    updated_at: "2026-01-01T00:00:00+00:00",
    ...fields,
  };
}

function textOf(event: EventRow, tasks: TaskRow[], truncated = false): string {
  return safeTextValue(
    renderOverview(event, { rows: tasks, truncated }).content,
  );
}

describe("renderOverview", () => {
  it("shows the event, its creator and each task's state and date", () => {
    const text = textOf(eventRow(), [
      taskRow(),
      taskRow({ status: "done", description: "Order food" }),
    ]);

    expect(text).toContain("**Fall Social**");
    expect(text).toContain(String.raw`Date: 2099\-01\-15`);
    expect(text).toContain("Status: Active");
    expect(text).toContain(`Created by <@${CREATOR}>`);
    expect(text).toContain("Tasks: 1 open, 1 done");
    expect(text).toContain(
      String.raw`☐ <@${ASSIGNEE}> Book the room (due 2099\-01\-10)`,
    );
    expect(text).toContain(`✅ <@${ASSIGNEE}> Order food`);
  });

  it("says when an event has no tasks and when it is closed", () => {
    const text = textOf(eventRow({ status: "closed" }), []);

    expect(text).toContain("Status: Closed");
    expect(text).toContain("No tasks yet.");
  });

  it("never pings, whoever is shown", () => {
    const input = renderOverview(eventRow(), {
      rows: [taskRow()],
      truncated: false,
    });

    expect(input.mentionUserIds).toEqual([]);
  });

  it("puts open tasks ahead of done ones", () => {
    const text = textOf(eventRow(), [
      taskRow({ status: "done", description: "Finished" }),
      taskRow({ description: "Still open" }),
    ]);

    expect(text.indexOf("Still open")).toBeLessThan(text.indexOf("Finished"));
  });

  it.each(HOSTILE_TEXT)("keeps a hostile name inert: %s", (_label, name) => {
    const [title = ""] = textOf(eventRow({ name }), []).split("\n");

    expect(hasLiveSyntax(title.slice(2, -2))).toBe(false);
  });

  it.each(HOSTILE_TEXT)("keeps a hostile task inert: %s", (_label, text) => {
    const rendered = textOf(eventRow(), [
      taskRow({ assignee_id: ASSIGNEE, description: text }),
    ]).split("\n");

    // A forged line stays on the task's own line.
    expect(rendered).toHaveLength(6);
    expect(
      hasLiveSyntax(rendered[5]?.replace(`<@${ASSIGNEE}>`, "") ?? "x"),
    ).toBe(false);
  });

  it.each(INVISIBLE_TEXT)("draws an event whose name is %s", (_label, name) => {
    expect(textOf(eventRow({ name }), [])).toContain("(no visible name)");
  });

  it.each(INVISIBLE_TEXT)(
    "does not let a task of %s stop the others",
    (_label, description) => {
      const text = textOf(eventRow(), [
        taskRow({ description }),
        taskRow({ description: "Book the room" }),
      ]);

      expect(text).toContain("Book the room");
    },
  );

  it("cuts a long description to one short line", () => {
    const text = textOf(eventRow(), [
      taskRow({ description: "x".repeat(1000) }),
    ]);

    expect(text.split("\n").at(-1)?.length).toBeLessThan(300);
    expect(text).toContain("…");
  });

  it("stays within the limit and counts what it hid", () => {
    const tasks = Array.from({ length: 100 }, (_, index) =>
      taskRow({ description: `${String(index)} ${"*".repeat(990)}` }),
    );

    const text = textOf(eventRow(), tasks);
    const shown = text.split("\n").filter((line) => line.startsWith("☐"));

    expect(text.length).toBeLessThanOrEqual(2000);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(100);
    expect(text).toContain(
      `…and ${String(100 - shown.length)} more not shown.`,
    );
  });

  it("stays within the limit at the longest possible name", () => {
    const text = textOf(
      eventRow({ name: "*".repeat(100) }),
      Array.from({ length: 100 }, () => taskRow()),
    );

    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain("more not shown.");
  });

  it("says so when the database held more tasks than were read", () => {
    const tasks = Array.from({ length: 100 }, () => taskRow());

    const text = textOf(eventRow(), tasks, true);

    expect(text).toContain("Tasks: 100 open, 0 done, and more");
    expect(text).toMatch(/…and more than [0-9]+ other tasks not shown\./u);
  });

  it("hides nothing and adds no closing line when all fits", () => {
    const text = textOf(eventRow(), [taskRow()]);

    expect(text).not.toContain("not shown");
  });

  it("keeps a note whatever else is cut", () => {
    const input = renderOverview(
      eventRow(),
      {
        rows: Array.from({ length: 100 }, () => taskRow()),
        truncated: false,
      },
      [safe`A note for the reader`],
    );

    expect(safeTextValue(input.content)).toContain("A note for the reader");
  });
});

describe("fitLines", () => {
  const more = (count: number) => (count === 0 ? undefined : safe`hidden`);

  it("refuses plain strings at compile time", () => {
    // @ts-expect-error a stored string has to pass the render boundary first
    expect(() => fitLines(["plain"], [], more)).toThrow();
  });

  it("uses the whole limit when the closing line is not needed", () => {
    const text = fitLines([safe`aaaa`], [safe`bbbb`], more, 9);

    expect(safeTextValue(text)).toBe("aaaa\nbbbb");
  });

  it("makes room for the closing line", () => {
    const text = fitLines([safe`aaaa`], [safe`bbbb`], more, 8);

    expect(safeTextValue(text)).toBe("aaaa\nhidden");
  });
});

describe("refreshOverview", () => {
  let errors: MockInstance<typeof console.error>;
  let sent: { body: Record<string, unknown>; target: unknown }[];
  let edited: { body: Record<string, unknown>; messageId: string }[];
  let editFails: DiscordFailure | undefined;
  let duringEdit: (() => void) | undefined;
  let reopened: unknown[];
  let reopenFails: DiscordFailure | undefined;
  let sendFails: DiscordFailure | undefined;
  let row: EventRow | null;
  let requests: RecordedRequest[];
  let dbFails: string | undefined;

  function context() {
    const mock = mockPostgrest((request) => {
      const path = request.target.split("?")[0] ?? "";
      if (dbFails !== undefined && request.target.includes(dbFails)) {
        return { status: 500, body: { message: "canary row text" } };
      }
      if (request.method === "PATCH") {
        return { body: [{ ...eventRow(), ...(request.body as object) }] };
      }
      if (path.endsWith("/events")) {
        return { body: row === null ? [] : [row] };
      }
      return { body: [] };
    });
    requests = mock.requests;
    const discord = {
      reopenThread: (target) => {
        reopened.push(target);
        if (reopenFails !== undefined) {
          return Promise.reject(
            new DiscordClientError("reopen thread", reopenFails),
          );
        }
        editFails = undefined;
        return Promise.resolve();
      },
      editMessage: (_target, messageId, body) => {
        if (editFails !== undefined) {
          return Promise.reject(
            new DiscordClientError("edit message", editFails),
          );
        }
        duringEdit?.();
        duringEdit = undefined;
        edited.push({
          messageId,
          body: body.toJSON() as Record<string, unknown>,
        });
        return Promise.resolve({ id: messageId });
      },
      sendMessage: (target, body) => {
        if (sendFails !== undefined) {
          return Promise.reject(
            new DiscordClientError("send message", sendFails),
          );
        }
        sent.push({ target, body: body.toJSON() as Record<string, unknown> });
        return Promise.resolve({ id: OVERVIEW });
      },
    } as Partial<DiscordClient> as DiscordClient;
    return { db: mock.db, discord };
  }

  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sent = [];
    edited = [];
    editFails = undefined;
    duringEdit = undefined;
    reopened = [];
    reopenFails = undefined;
    sendFails = undefined;
    dbFails = undefined;
    row = eventRow();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("edits the stored message, in the stored thread, with no pings", async () => {
    await expect(refreshOverview(context(), eventRow())).resolves.toBe(true);

    expect(edited).toHaveLength(1);
    expect(edited[0]?.messageId).toBe(OVERVIEW);
    expect(edited[0]?.body.allowed_mentions).toEqual({ parse: [], users: [] });
    expect(sent).toEqual([]);
  });

  it("reads the row again instead of trusting the caller's copy", async () => {
    row = eventRow({ status: "closed" });

    await refreshOverview(context(), eventRow({ status: "active" }));

    expect(edited[0]?.body.content).toContain("Status: Closed");
  });

  it("posts a new overview when none is stored, and stores it", async () => {
    row = eventRow({ overview_message_id: null });

    await expect(refreshOverview(context(), eventRow())).resolves.toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toEqual({
      kind: "thread",
      guildId: GUILD,
      threadId: THREAD,
    });
    expect(
      requests.find((request) => request.method === "PATCH")?.body,
    ).toEqual({ overview_message_id: OVERVIEW });
  });

  it("posts a new overview when the old message was removed", async () => {
    editFails = {
      kind: "api",
      status: 404,
      code: DiscordErrorCode.UnknownMessage,
    };

    await expect(refreshOverview(context(), eventRow())).resolves.toBe(true);

    expect(sent).toHaveLength(1);
  });

  describe("when /event close lands during a slow edit", () => {
    it("draws the closed state again, so closed wins", async () => {
      duringEdit = () => {
        row = eventRow({ status: "closed" });
      };

      await expect(refreshOverview(context(), eventRow())).resolves.toBe(true);

      expect(edited.map((edit) => edit.body.content)).toEqual([
        expect.stringContaining("Status: Active"),
        expect.stringContaining("Status: Closed"),
      ]);
    });

    it("edits once when the event is still active", async () => {
      await expect(refreshOverview(context(), eventRow())).resolves.toBe(true);

      expect(edited).toHaveLength(1);
    });

    it("edits once when the event was already closed", async () => {
      row = eventRow({ status: "closed" });

      await expect(refreshOverview(context(), eventRow())).resolves.toBe(true);

      expect(edited).toHaveLength(1);
    });

    it("leaves the post alone when the event was deleted meanwhile", async () => {
      duringEdit = () => {
        row = null;
      };

      await expect(refreshOverview(context(), eventRow())).resolves.toBe(true);

      expect(edited).toHaveLength(1);
    });
  });

  describe("in an archived post", () => {
    const ARCHIVED: DiscordFailure = {
      kind: "api",
      status: 400,
      code: DiscordErrorCode.ThreadArchived,
    };

    it("reopens the post and edits again, posting nothing", async () => {
      editFails = ARCHIVED;

      await expect(refreshOverview(context(), eventRow())).resolves.toBe(true);

      expect(reopened).toEqual([
        { kind: "thread", guildId: GUILD, threadId: THREAD },
      ]);
      expect(edited).toHaveLength(1);
      expect(sent).toEqual([]);
    });

    it("reports failure when the post can't be reopened", async () => {
      editFails = ARCHIVED;
      reopenFails = { kind: "api", status: 403, code: 160005 };

      await expect(refreshOverview(context(), eventRow())).resolves.toBe(false);

      expect(edited).toEqual([]);
      expect(sent).toEqual([]);
    });

    it("does not reopen a post for any other refusal", async () => {
      editFails = { kind: "api", status: 400, code: 200000 };

      await expect(refreshOverview(context(), eventRow())).resolves.toBe(false);

      expect(reopened).toEqual([]);
    });
  });

  it.each<[string, DiscordFailure]>([
    [
      "rate limit",
      { kind: "rate_limited", retryAfterMs: 1, attempts: 3, scope: undefined },
    ],
    ["network", { kind: "network" }],
    ["server error", { kind: "api", status: 500, code: undefined }],
    ["removed forum", { kind: "unmanaged_target", channelId: FORUM }],
    [
      "missing access",
      {
        kind: "channel_unavailable",
        channelId: THREAD,
        status: 403,
        code: DiscordErrorCode.MissingAccess,
      },
    ],
  ])("reports failure without posting again: %s", async (_label, failure) => {
    editFails = failure;

    await expect(refreshOverview(context(), eventRow())).resolves.toBe(false);

    expect(sent).toEqual([]);
    expect(requests.filter((request) => request.method === "PATCH")).toEqual(
      [],
    );
  });

  it("marks the thread missing only when Discord says it is gone", async () => {
    editFails = {
      kind: "channel_unavailable",
      channelId: THREAD,
      status: 404,
      code: DiscordErrorCode.UnknownChannel,
    };

    await expect(refreshOverview(context(), eventRow())).resolves.toBe(false);

    expect(
      requests.find((request) => request.method === "PATCH")?.body,
    ).toEqual({ thread_status: "missing" });
  });

  it.each<[string, EventRow | null]>([
    ["deleted since it was read", null],
    ["pending", eventRow({ thread_id: null, thread_status: "pending" })],
    ["missing its thread", eventRow({ thread_status: "missing" })],
  ])("sends nothing for an event that is %s", async (_label, current) => {
    row = current;

    await expect(refreshOverview(context(), eventRow())).resolves.toBe(false);

    expect(sent).toEqual([]);
    expect(edited).toEqual([]);
  });

  it.each(["/events", "/tasks"])(
    "does not reject or quote the row when %s fails",
    async (path) => {
      dbFails = path;

      await expect(refreshOverview(context(), eventRow())).resolves.toBe(false);

      expect(sent).toEqual([]);
      expect(JSON.stringify(errors.mock.calls)).not.toContain("canary");
    },
  );

  it("does not reject when an unexpected error is thrown", async () => {
    const { db } = context();
    const discord = {
      editMessage: () => Promise.reject(new Error("canary thrown text")),
    } as Partial<DiscordClient> as DiscordClient;

    await expect(refreshOverview({ db, discord }, eventRow())).resolves.toBe(
      false,
    );

    expect(JSON.stringify(errors.mock.calls)).not.toContain("canary");
  });

  it("logs no names or IDs from the event", async () => {
    sendFails = { kind: "network" };
    row = eventRow({
      overview_message_id: null,
      name: "CanaryNameText",
    });

    await refreshOverview(context(), eventRow());

    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toContain("network");
    expect(logged).not.toContain("CanaryNameText");
    expect(logged).not.toContain(THREAD);
  });
});
