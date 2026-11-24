/**
 * What the database's triggers did around a write, now done by the bot's own writes: the
 * old row kept in `row_versions`, `updated_at` moved on a change and only then, a deleted
 * row kept deleted, a closed event kept closed, and nothing added or changed under a
 * closed or deleted parent. These run on a database that still has the triggers, where
 * each history row must come out once, and on one that has none
 * (`BOT_TEST_NO_TRIGGERS=1`), where the bot's row is the only one.
 */

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  closeEvent,
  createEvent,
  setEventOverviewMessage,
  softDeleteEvent,
} from "../../src/db/events.ts";
import {
  assignEventStep,
  completeEventStep,
  unassignEventStep,
} from "../../src/db/event-steps.ts";
import {
  applyConfigChange,
  saveSetupDraft,
} from "../../src/db/guild-config.ts";
import { updateRecorded } from "../../src/db/history.ts";
import { transact } from "../../src/db/internal.ts";
import { createTask, markOwnTaskDone } from "../../src/db/tasks.ts";
import { events, guildConfig, tasks } from "../../src/db/schema.ts";
import type { DateOnly } from "../../src/lib/dates.ts";
import { botClient, must } from "./bot-writes.ts";
import { insertEvent, insertGuild, insertTask } from "./fixtures.ts";
import {
  HOOK_TIMEOUT_MS,
  NO_TRIGGERS,
  createMigratedDb,
  dropTriggers,
  fakeId,
} from "./harness.ts";

let db: PGlite;
beforeAll(async () => {
  db = await createMigratedDb();
}, HOOK_TIMEOUT_MS);
afterAll(() => db.close());

const bot = () => botClient(db);

interface History {
  source_table: string;
  operation: string;
  row_id: string;
  old_row: Record<string, unknown>;
  xid: string | null;
}

const historyOf = async (table: string, rowId: string): Promise<History[]> =>
  (
    await db.query<History>(
      `SELECT source_table, operation, row_id, old_row, xid
       FROM discord_bot.row_versions WHERE source_table = $1 AND row_id = $2 ORDER BY id`,
      [table, rowId],
    )
  ).rows;

const rowOf = async (table: string, where: string, params: unknown[]) =>
  (
    await db.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(t) AS row FROM discord_bot.${table} t WHERE ${where}`,
      params,
    )
  ).rows[0]?.row;

describe("one history row for each change, whoever writes it", () => {
  it("events", async () => {
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    const before = await rowOf("events", "id = $1", [eventId]);
    must(await closeEvent(bot(), { guildId: guild.guildId, eventId }));
    const history = await historyOf("events", eventId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ operation: "UPDATE", old_row: before });
    expect(history[0]?.xid).not.toBeNull();
  });

  it("tasks", async () => {
    const guild = await insertGuild(db);
    const taskId = await insertTask(db, guild, await insertEvent(db, guild));
    const before = await rowOf("tasks", "id = $1", [taskId]);
    const assigneeId = before?.assignee_id as string;
    must(
      await markOwnTaskDone(bot(), {
        guildId: guild.guildId,
        taskId,
        assigneeId,
        now: new Date(),
      }),
    );
    const history = await historyOf("tasks", taskId);
    expect(history).toHaveLength(1);
    expect(history[0]?.old_row).toEqual(before);
  });

  it("event_steps", async () => {
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    const before = await rowOf(
      "event_steps",
      "event_id = $1 AND kind = 'budget_sheet'",
      [eventId],
    );
    must(
      await completeEventStep(bot(), {
        eventId,
        guildId: guild.guildId,
        kind: "budget_sheet",
        actorId: fakeId(),
      }),
    );
    const history = await historyOf("event_steps", `${eventId}:budget_sheet`);
    expect(history).toHaveLength(1);
    expect(history[0]?.old_row).toEqual(before);
  });

  it("event_step_assignees", async () => {
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    const userId = fakeId();
    const input = {
      eventId,
      guildId: guild.guildId,
      kind: "budget_sheet" as const,
      userId,
      actorId: userId,
    };
    must(await assignEventStep(bot(), input));
    const before = await rowOf(
      "event_step_assignees",
      "event_id = $1 AND user_id = $2",
      [eventId, userId],
    );
    must(await unassignEventStep(bot(), input));
    const history = await historyOf("event_step_assignees", String(before?.id));
    expect(history).toHaveLength(1);
    expect(history[0]?.old_row).toEqual(before);
  });

  it("guild_config and managed_channels", async () => {
    const guild = await insertGuild(db);
    const configBefore = await rowOf("guild_config", "guild_id = $1", [
      guild.guildId,
    ]);
    const channelBefore = await rowOf(
      "managed_channels",
      "guild_id = $1 AND channel_id = $2",
      [guild.guildId, guild.channelId],
    );
    const kept = (await historyOf("guild_config", guild.guildId)).length;
    must(
      await applyConfigChange(bot(), {
        guildId: guild.guildId,
        actorId: fakeId(),
        expectedVersion: 2,
        remindersEnabled: false,
        addChannelIds: [],
        removeChannelIds: [guild.channelId],
        timezone: null,
      }),
    );
    const config = await historyOf("guild_config", guild.guildId);
    expect(config).toHaveLength(kept + 1);
    expect(config.at(-1)?.old_row).toEqual(configBefore);
    const channel = await historyOf(
      "managed_channels",
      `${guild.guildId}:${guild.channelId}`,
    );
    expect(channel).toHaveLength(1);
    expect(channel[0]?.old_row).toEqual(channelBefore);
  });

  it("setup_drafts", async () => {
    const guild = await insertGuild(db);
    const person = fakeId();
    const save = (role: string) =>
      saveSetupDraft(bot(), {
        guildId: guild.guildId,
        actorId: person,
        roles: {
          officerRoleId: role,
          adminRoleId: person,
          eboardRoleId: person,
          eventsCommitteeRoleId: person,
          treasuryRoleId: person,
          marketingRoleId: person,
        },
      });
    must(await save(fakeId()));
    expect(await historyOf("setup_drafts", guild.guildId)).toHaveLength(0);
    const before = await rowOf("setup_drafts", "guild_id = $1", [
      guild.guildId,
    ]);
    must(await save(fakeId()));
    const history = await historyOf("setup_drafts", guild.guildId);
    expect(history).toHaveLength(1);
    expect(history[0]?.old_row).toEqual(before);
  });

  it("several rows at once: one history row each, with the trigger or without", async () => {
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    const taskIds = [
      await insertTask(db, guild, eventId),
      await insertTask(db, guild, eventId),
      await insertTask(db, guild, eventId),
    ];
    expect(
      must(await softDeleteEvent(bot(), { guildId: guild.guildId, eventId })),
    ).toBe(3);
    for (const taskId of taskIds) {
      expect(await historyOf("tasks", taskId)).toHaveLength(1);
    }
    expect(await historyOf("events", eventId)).toHaveLength(1);
  });

  // While the triggers exist the bot skips what they kept; a row that goes A, B, A, X in one
  // transaction must still leave all three old versions and raise nothing.
  it.skipIf(NO_TRIGGERS)(
    "a row changed A to B, B to A and A to X in one transaction keeps three old versions",
    async () => {
      const guild = await insertGuild(db);
      const taskId = await insertTask(db, guild, await insertEvent(db, guild));
      const result = await transact(bot(), async (tx) => {
        for (const description of ["B", "A", "X"]) {
          await updateRecorded(
            tx,
            tasks,
            { description },
            eq(tasks.id, taskId),
            {
              id: tasks.id,
            },
          );
        }
      });
      expect(result.ok).toBe(true);
      const history = await historyOf("tasks", taskId);
      expect(history).toHaveLength(3);
      expect(history.map((row) => row.old_row.description)).toEqual([
        expect.not.stringMatching(/^(A|B|X)$/),
        "B",
        "A",
      ]);
    },
  );

  it("keeps nothing for a write that changes nothing, and leaves updated_at alone", async () => {
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    const message = fakeId();
    must(
      await setEventOverviewMessage(bot(), {
        guildId: guild.guildId,
        eventId,
        messageId: message,
      }),
    );
    const before = await rowOf("events", "id = $1", [eventId]);
    const rows = (await historyOf("events", eventId)).length;
    await new Promise((resolve) => setTimeout(resolve, 5));
    must(
      await setEventOverviewMessage(bot(), {
        guildId: guild.guildId,
        eventId,
        messageId: message,
      }),
    );
    expect(await historyOf("events", eventId)).toHaveLength(rows);
    expect(await rowOf("events", "id = $1", [eventId])).toEqual(before);
  });

  it("moves updated_at when something changes", async () => {
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    const before = await rowOf("events", "id = $1", [eventId]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    must(await closeEvent(bot(), { guildId: guild.guildId, eventId }));
    expect((await rowOf("events", "id = $1", [eventId]))?.updated_at).not.toBe(
      before?.updated_at,
    );
  });
});

describe.skipIf(NO_TRIGGERS)("with the trigger present", () => {
  it("writes the same history row the bot writes without it", async () => {
    const guild = await insertGuild(db);
    const first = await insertEvent(db, guild);
    must(await closeEvent(bot(), { guildId: guild.guildId, eventId: first }));
    const fromTrigger = (await historyOf("events", first))[0];

    const other = await createMigratedDb();
    try {
      await dropTriggers(other);
      const g = await insertGuild(other);
      const e = await insertEvent(other, g);
      must(
        await closeEvent(botClient(other), { guildId: g.guildId, eventId: e }),
      );
      const { rows } = await other.query<History>(
        `SELECT source_table, operation, row_id, old_row, xid FROM discord_bot.row_versions
         WHERE source_table = 'events' AND row_id = $1`,
        [e],
      );
      const fromBot = rows[0];
      expect(fromBot).toBeDefined();
      expect(Object.keys(fromBot ?? {}).sort()).toEqual(
        Object.keys(fromTrigger ?? {}).sort(),
      );
      expect(fromBot?.operation).toBe(fromTrigger?.operation);
      expect(Object.keys(fromBot?.old_row ?? {}).sort()).toEqual(
        Object.keys(fromTrigger?.old_row ?? {}).sort(),
      );
      expect(typeof fromBot?.xid).toBe(typeof fromTrigger?.xid);
      expect(fromBot?.xid).not.toBeNull();
    } finally {
      await other.close();
    }
  });
});

describe("what the triggers refused, the bot's writes refuse", () => {
  const refusal = (code: string) => ({
    ok: false,
    error: { code },
  });

  it("brings a deleted row back: 42501", async () => {
    const guild = await insertGuild(db);
    const taskId = await insertTask(db, guild, await insertEvent(db, guild));
    await db.query(
      "UPDATE discord_bot.tasks SET deleted_at = now() WHERE id = $1",
      [taskId],
    );
    const result = await transact(bot(), (tx) =>
      updateRecorded(tx, tasks, { deletedAt: null }, eq(tasks.id, taskId), {
        id: tasks.id,
      }),
    );
    expect(result).toMatchObject(refusal("42501"));
    const event = await insertEvent(db, guild);
    await db.query(
      "UPDATE discord_bot.events SET deleted_at = now() WHERE id = $1",
      [event],
    );
    expect(
      await transact(bot(), (tx) =>
        updateRecorded(tx, events, { deletedAt: null }, eq(events.id, event), {
          id: events.id,
        }),
      ),
    ).toMatchObject(refusal("42501"));
  });

  it("reopens a closed event: 42501", async () => {
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    await db.query(
      "UPDATE discord_bot.events SET status = 'closed' WHERE id = $1",
      [eventId],
    );
    expect(
      await transact(bot(), (tx) =>
        updateRecorded(
          tx,
          events,
          { status: "active" },
          eq(events.id, eventId),
          {
            id: events.id,
          },
        ),
      ),
    ).toMatchObject(refusal("42501"));
  });

  it("adds or changes a task under a closed or deleted event: CF410", async () => {
    const guild = await insertGuild(db);
    const newTask = (eventId: string) =>
      createTask(bot(), {
        guildId: guild.guildId,
        eventId,
        assigneeId: fakeId(),
        actorId: fakeId(),
        description: "Book the room",
        dueDate: "2030-01-10" as DateOnly,
      });
    const closed = await insertEvent(db, guild);
    const deleted = await insertEvent(db, guild);
    const open = await insertEvent(db, guild);
    const taskId = await insertTask(db, guild, open);
    await db.query(
      "UPDATE discord_bot.events SET status = 'closed' WHERE id = $1",
      [closed],
    );
    await db.query(
      "UPDATE discord_bot.events SET deleted_at = now() WHERE id = $1",
      [deleted],
    );
    expect(await newTask(closed)).toMatchObject(refusal("CF410"));
    expect(await newTask(deleted)).toMatchObject(refusal("CF410"));
    await db.query(
      "UPDATE discord_bot.events SET status = 'closed' WHERE id = $1",
      [open],
    );
    const assigneeId = (await rowOf("tasks", "id = $1", [taskId]))
      ?.assignee_id as string;
    expect(
      await markOwnTaskDone(bot(), {
        guildId: guild.guildId,
        taskId,
        assigneeId,
        now: new Date(),
      }),
    ).toMatchObject(refusal("CF410"));
  });

  it("adds an event under a removed channel: CF410, and not under an unavailable one", async () => {
    const guild = await insertGuild(db);
    const channels = [fakeId(), fakeId()];
    const channelId = (n: number) => channels[n - 1] ?? "";
    for (const [n, status] of [
      [1, "removed"],
      [2, "unavailable"],
    ] as const) {
      await db.query(
        "INSERT INTO discord_bot.managed_channels (guild_id, channel_id, status) VALUES ($1, $2, $3)",
        [guild.guildId, channelId(n), status],
      );
    }
    const make = (n: number) =>
      createEvent(bot(), {
        guildId: guild.guildId,
        channelId: channelId(n),
        actorId: fakeId(),
        name: "Social",
        eventDate: "2030-02-01" as DateOnly,
      });
    expect(await make(1)).toMatchObject(refusal("CF410"));
    expect((await make(2)).ok).toBe(true);
  });

  it("sets a time zone the server does not know: 22023", async () => {
    const guild = await insertGuild(db);
    expect(
      await transact(bot(), (tx) =>
        updateRecorded(
          tx,
          guildConfig,
          { timezone: "Mars/Phobos" },
          eq(guildConfig.guildId, guild.guildId),
          { guildId: guildConfig.guildId },
        ),
      ),
    ).toMatchObject(refusal("22023"));
  });
});

describe("a new event gets a step of every kind from the bot", () => {
  it("makes six, with no trigger to do it", async () => {
    if (NO_TRIGGERS) {
      await db.exec(
        "DROP TRIGGER IF EXISTS test_seed_steps ON discord_bot.events",
      );
    }
    const guild = await insertGuild(db);
    const event = must(
      await createEvent(bot(), {
        guildId: guild.guildId,
        channelId: guild.channelId,
        actorId: fakeId(),
        name: "Social",
        eventDate: "2030-02-01" as DateOnly,
      }),
    );
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM discord_bot.event_steps WHERE event_id = $1",
      [event.id],
    );
    expect(rows[0]?.n).toBe(6);
  });
});
