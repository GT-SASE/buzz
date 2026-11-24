/**
 * Each SQLSTATE the bot's own errors are mapped from (src/db/errors.ts), raised by the
 * TypeScript write that used to get it from a database function, and arriving as the
 * category the callers handle.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  assignEventStep,
  completeEventStep,
} from "../../src/db/event-steps.ts";
import { applyConfigChange } from "../../src/db/guild-config.ts";
import { claimReminder } from "../../src/db/reminders.ts";
import { createTask } from "../../src/db/tasks.ts";
import type { DbErrorCategory } from "../../src/db/errors.ts";
import type { DateOnly } from "../../src/lib/dates.ts";
import { botClient, must } from "./bot-writes.ts";
import { insertEvent, insertGuild, insertTask } from "./fixtures.ts";
import { HOOK_TIMEOUT_MS, createMigratedDb, fakeId } from "./harness.ts";

let db: PGlite;
beforeAll(async () => {
  db = await createMigratedDb();
}, HOOK_TIMEOUT_MS);
afterAll(() => db.close());

const bot = () => botClient(db);
const failed = (category: DbErrorCategory, code: string) => ({
  ok: false as const,
  error: { category, code },
});
const NEW_TASK = {
  assigneeId: "",
  description: "Book the room",
  dueDate: "2030-01-10" as DateOnly,
};

describe("the SQLSTATEs of the bot's own errors", () => {
  it("CF409: a stale config version", async () => {
    const guild = await insertGuild(db);
    expect(
      await applyConfigChange(bot(), {
        guildId: guild.guildId,
        actorId: fakeId(),
        expectedVersion: 1,
        remindersEnabled: false,
        addChannelIds: [],
        removeChannelIds: [],
        timezone: null,
      }),
    ).toEqual(failed("stale_version", "CF409"));
  });

  it("CF410: a step on a closed event", async () => {
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    await db.query(
      "UPDATE discord_bot.events SET status = 'closed' WHERE id = $1",
      [eventId],
    );
    expect(
      await completeEventStep(bot(), {
        eventId,
        guildId: guild.guildId,
        kind: "budget_sheet",
        actorId: fakeId(),
      }),
    ).toEqual(failed("parent_unavailable", "CF410"));
  });

  it("CF412: a reminder for a task that changed since it was read", async () => {
    const guild = await insertGuild(db);
    const taskId = await insertTask(db, guild, await insertEvent(db, guild));
    expect(
      await claimReminder(bot(), {
        taskId,
        kind: "due_day",
        dueDate: "2030-01-10" as DateOnly,
        asRead: {
          assigneeId: fakeId(),
          updatedAt: "2020-01-01T00:00:00+00:00",
        },
      }),
    ).toEqual(failed("task_changed", "CF412"));
  });

  it("CF425: Engage picture added while Engage post is open", async () => {
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    expect(
      await completeEventStep(bot(), {
        eventId,
        guildId: guild.guildId,
        kind: "engage_picture",
        actorId: fakeId(),
      }),
    ).toEqual(failed("step_not_ready", "CF425"));
  });

  it("CF429: an event's hundred-and-first task", async () => {
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    for (let index = 0; index < 100; index += 1) {
      await insertTask(db, guild, eventId);
    }
    expect(
      await createTask(bot(), {
        ...NEW_TASK,
        guildId: guild.guildId,
        eventId,
        assigneeId: fakeId(),
        actorId: fakeId(),
      }),
    ).toEqual(failed("event_task_limit", "CF429"));
  });

  it("CF430: an officer's fifty-first task in a day", async () => {
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    const officer = fakeId();
    for (let index = 0; index < 50; index += 1) {
      must(
        await createTask(bot(), {
          ...NEW_TASK,
          guildId: guild.guildId,
          eventId,
          assigneeId: fakeId(),
          actorId: officer,
        }),
      );
    }
    expect(
      await createTask(bot(), {
        ...NEW_TASK,
        guildId: guild.guildId,
        eventId: await insertEvent(db, guild),
        assigneeId: fakeId(),
        actorId: officer,
      }),
    ).toEqual(failed("actor_task_limit", "CF430"));
  });

  it("CF431: an eleventh person on a step", async () => {
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    for (let index = 0; index < 10; index += 1) {
      const userId = fakeId();
      must(
        await assignEventStep(bot(), {
          eventId,
          guildId: guild.guildId,
          kind: "budget_sheet",
          userId,
          actorId: userId,
        }),
      );
    }
    const userId = fakeId();
    expect(
      await assignEventStep(bot(), {
        eventId,
        guildId: guild.guildId,
        kind: "budget_sheet",
        userId,
        actorId: userId,
      }),
    ).toEqual(failed("step_assignee_limit", "CF431"));
  });
});
