/**
 * refreshOverview on the real schema: it reads the event again, and stores the message
 * it posts or that the thread is gone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DiscordClientError,
  DiscordErrorCode,
  type DiscordClient,
  type DiscordFailure,
} from "../../src/discord/client.ts";
import type { EventRow } from "../../src/db/types.ts";
import { refreshOverview } from "../../src/events/overview.ts";
import type { DateOnly } from "../../src/lib/dates.ts";
import { fakeId } from "../support/ids.ts";
import { handlerDb, type HandlerDb } from "./handler-db.ts";

const GUILD = fakeId();
const FORUM = fakeId();
const THREAD = fakeId();
const OVERVIEW = fakeId();
const CREATOR = fakeId();
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

/** The stored event's post fields, or undefined once it is deleted. */
async function stored(w: HandlerDb) {
  const result = await w.pg.query<{
    overview_message_id: string | null;
    thread_status: string;
  }>(
    `SELECT overview_message_id, thread_status::text AS thread_status
     FROM public.events WHERE id = $1 AND deleted_at IS NULL`,
    [EVENT_ID],
  );
  return result.rows[0];
}

/** Changes the stored event, as another request would. */
async function change(w: HandlerDb, sql: string) {
  await w.pg.query(`UPDATE public.events SET ${sql} WHERE id = $1`, [EVENT_ID]);
}

describe("refreshOverview", () => {
  let sent: { body: Record<string, unknown>; target: unknown }[];
  let edited: { body: Record<string, unknown>; messageId: string }[];
  let editFails: DiscordFailure | undefined;
  let duringEdit: (() => Promise<void>) | undefined;
  let reopened: unknown[];
  let reopenFails: DiscordFailure | undefined;
  let sendFails: DiscordFailure | undefined;
  let row: EventRow | null;
  let w: HandlerDb;

  async function context() {
    w = await handlerDb({ events: row === null ? [] : [row] });
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
      editMessage: async (_target, messageId, body) => {
        if (editFails !== undefined) {
          throw new DiscordClientError("edit message", editFails);
        }
        await duringEdit?.();
        duringEdit = undefined;
        edited.push({
          messageId,
          body: body.payload as Record<string, unknown>,
        });
        return { id: messageId };
      },
      sendMessage: (target, body) => {
        if (sendFails !== undefined) {
          return Promise.reject(
            new DiscordClientError("send message", sendFails),
          );
        }
        sent.push({ target, body: body.payload as Record<string, unknown> });
        return Promise.resolve({ id: OVERVIEW });
      },
    } as Partial<DiscordClient> as DiscordClient;
    return { db: w.db, discord };
  }

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    sent = [];
    edited = [];
    editFails = undefined;
    duringEdit = undefined;
    reopened = [];
    reopenFails = undefined;
    sendFails = undefined;
    row = eventRow();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("edits the stored message, in the stored thread, with no pings", async () => {
    await expect(refreshOverview(await context(), eventRow())).resolves.toBe(
      true,
    );

    expect(edited).toHaveLength(1);
    expect(edited[0]?.messageId).toBe(OVERVIEW);
    expect(edited[0]?.body.allowed_mentions).toEqual({ parse: [], users: [] });
    expect(sent).toEqual([]);
  });

  it("reads the row again instead of trusting the caller's copy", async () => {
    row = eventRow({ status: "closed" });

    await refreshOverview(await context(), eventRow({ status: "active" }));

    expect(edited[0]?.body.content).toContain("Status: Closed");
  });

  it("posts a new overview when none is stored, and stores it", async () => {
    row = eventRow({ overview_message_id: null });

    await expect(refreshOverview(await context(), eventRow())).resolves.toBe(
      true,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toEqual({
      kind: "thread",
      guildId: GUILD,
      threadId: THREAD,
    });
    expect(await stored(w)).toEqual({
      overview_message_id: OVERVIEW,
      thread_status: "active",
    });
  });

  it("posts a new overview when the old message was removed", async () => {
    editFails = {
      kind: "api",
      status: 404,
      code: DiscordErrorCode.UnknownMessage,
    };

    await expect(refreshOverview(await context(), eventRow())).resolves.toBe(
      true,
    );

    expect(sent).toHaveLength(1);
  });

  describe("when /event close lands during a slow edit", () => {
    it("draws the closed state again, so closed wins", async () => {
      duringEdit = () => change(w, "status = 'closed'");

      await expect(refreshOverview(await context(), eventRow())).resolves.toBe(
        true,
      );

      expect(edited.map((edit) => edit.body.content)).toEqual([
        expect.stringContaining("Status: Active"),
        expect.stringContaining("Status: Closed"),
      ]);
    });

    it("edits once when the event is still active", async () => {
      await expect(refreshOverview(await context(), eventRow())).resolves.toBe(
        true,
      );

      expect(edited).toHaveLength(1);
    });

    it("edits once when the event was already closed", async () => {
      row = eventRow({ status: "closed" });

      await expect(refreshOverview(await context(), eventRow())).resolves.toBe(
        true,
      );

      expect(edited).toHaveLength(1);
    });

    it("leaves the post alone when the event was deleted meanwhile", async () => {
      duringEdit = () => change(w, "deleted_at = now()");

      await expect(refreshOverview(await context(), eventRow())).resolves.toBe(
        true,
      );

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

      await expect(refreshOverview(await context(), eventRow())).resolves.toBe(
        true,
      );

      expect(reopened).toEqual([
        { kind: "thread", guildId: GUILD, threadId: THREAD },
      ]);
      expect(edited).toHaveLength(1);
      expect(sent).toEqual([]);
    });

    it("reports failure when the post can't be reopened", async () => {
      editFails = ARCHIVED;
      reopenFails = { kind: "api", status: 403, code: 160005 };

      await expect(refreshOverview(await context(), eventRow())).resolves.toBe(
        false,
      );

      expect(edited).toEqual([]);
      expect(sent).toEqual([]);
    });

    it("does not reopen a post for any other refusal", async () => {
      editFails = { kind: "api", status: 400, code: 200000 };

      await expect(refreshOverview(await context(), eventRow())).resolves.toBe(
        false,
      );

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

    await expect(refreshOverview(await context(), eventRow())).resolves.toBe(
      false,
    );

    expect(sent).toEqual([]);
    expect(await stored(w)).toEqual({
      overview_message_id: OVERVIEW,
      thread_status: "active",
    });
  });

  it("marks the thread missing only when Discord says it is gone", async () => {
    editFails = {
      kind: "channel_unavailable",
      channelId: THREAD,
      status: 404,
      code: DiscordErrorCode.UnknownChannel,
    };

    await expect(refreshOverview(await context(), eventRow())).resolves.toBe(
      false,
    );

    expect(await stored(w)).toEqual({
      overview_message_id: OVERVIEW,
      thread_status: "missing",
    });
  });

  it.each<[string, EventRow | null]>([
    ["deleted since it was read", null],
    ["pending", eventRow({ thread_id: null, thread_status: "pending" })],
    ["missing its thread", eventRow({ thread_status: "missing" })],
  ])("sends nothing for an event that is %s", async (_label, current) => {
    row = current;

    await expect(refreshOverview(await context(), eventRow())).resolves.toBe(
      false,
    );

    expect(sent).toEqual([]);
    expect(edited).toEqual([]);
  });

  it.each(["events", "tasks"])(
    "does not reject or quote the row when %s fails",
    async (path) => {
      const failing = await context();
      w.fail(path);

      await expect(refreshOverview(failing, eventRow())).resolves.toBe(false);

      expect(sent).toEqual([]);
    },
  );

  it("does not reject when an unexpected error is thrown", async () => {
    const { db } = await context();
    const discord = {
      editMessage: () => Promise.reject(new Error("thrown text")),
    } as Partial<DiscordClient> as DiscordClient;

    await expect(refreshOverview({ db, discord }, eventRow())).resolves.toBe(
      false,
    );
  });
});
