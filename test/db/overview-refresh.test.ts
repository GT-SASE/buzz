/**
 * refreshOverview on the real schema: it reads the event again, and stores the message
 * it posts or that the thread is gone.
 */

import { beforeEach, describe, expect, it, spyOn } from "bun:test";
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
const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ACTIVE = { overview_message_id: OVERVIEW, thread_status: "active" };

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
    created_by: fakeId(),
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
  let row: EventRow | null;
  let w: HandlerDb;

  async function context() {
    w = await handlerDb({ events: row === null ? [] : [row] });
    const discord = {
      reopenThread: (target) => {
        reopened.push(target);
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
        sent.push({ target, body: body.payload as Record<string, unknown> });
        return Promise.resolve({ id: OVERVIEW });
      },
    } as Partial<DiscordClient> as DiscordClient;
    return { db: w.db, discord };
  }

  async function refresh(): Promise<boolean> {
    return refreshOverview(await context(), eventRow());
  }

  beforeEach(() => {
    spyOn(console, "error").mockImplementation(() => undefined);
    sent = [];
    edited = [];
    editFails = undefined;
    duringEdit = undefined;
    reopened = [];
    row = eventRow();
  });

  it("edits the stored message from the row read again, with no pings", async () => {
    row = eventRow({ status: "closed" });

    expect(await refresh()).toBe(true);

    expect(edited).toHaveLength(1);
    expect(edited[0]?.messageId).toBe(OVERVIEW);
    expect(edited[0]?.body.content).toContain("Status: Closed");
    expect(edited[0]?.body.allowed_mentions).toEqual({ parse: [], users: [] });
    expect(sent).toEqual([]);
  });

  it("posts a new overview when none is stored, and stores it", async () => {
    row = eventRow({ overview_message_id: null });

    expect(await refresh()).toBe(true);

    expect(sent[0]?.target).toEqual({
      kind: "thread",
      guildId: GUILD,
      threadId: THREAD,
    });
    expect(await stored(w)).toEqual(ACTIVE);
  });

  it("draws the closed state again when /event close lands during a slow edit", async () => {
    duringEdit = () => change(w, "status = 'closed'");

    expect(await refresh()).toBe(true);

    expect(edited.map((edit) => edit.body.content)).toEqual([
      expect.stringContaining("Status: Active"),
      expect.stringContaining("Status: Closed"),
    ]);
  });

  it("reopens an archived post and edits again, posting nothing", async () => {
    editFails = {
      kind: "api",
      status: 400,
      code: DiscordErrorCode.ThreadArchived,
    };

    expect(await refresh()).toBe(true);

    expect(reopened).toEqual([
      { kind: "thread", guildId: GUILD, threadId: THREAD },
    ]);
    expect(edited).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("reports failure without posting again when Discord refuses", async () => {
    editFails = {
      kind: "channel_unavailable",
      channelId: THREAD,
      status: 403,
      code: DiscordErrorCode.MissingAccess,
    };

    expect(await refresh()).toBe(false);

    expect(sent).toEqual([]);
    expect(await stored(w)).toEqual(ACTIVE);
  });

  it("marks the thread missing only when Discord says it is gone", async () => {
    editFails = {
      kind: "channel_unavailable",
      channelId: THREAD,
      status: 404,
      code: DiscordErrorCode.UnknownChannel,
    };

    expect(await refresh()).toBe(false);

    expect(await stored(w)).toEqual({
      overview_message_id: OVERVIEW,
      thread_status: "missing",
    });
  });

  it.each<[string, EventRow | null]>([
    ["deleted since it was read", null],
    ["pending", eventRow({ thread_id: null, thread_status: "pending" })],
  ])("sends nothing for an event that is %s", async (_label, current) => {
    row = current;

    expect(await refresh()).toBe(false);

    expect(sent).toEqual([]);
    expect(edited).toEqual([]);
  });

  it("does not reject when the database fails", async () => {
    const failing = await context();
    w.fail("tasks");

    expect(await refreshOverview(failing, eventRow())).toBe(false);
    expect(sent).toEqual([]);
  });
});
