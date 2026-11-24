import { describe, expect, it } from "bun:test";
import {
  assignEventStep,
  claimEventReminder,
  completeEventStep,
} from "../../src/db/event-steps.ts";
import {
  applyConfigChange,
  applyRoleBindings,
} from "../../src/db/guild-config.ts";
import { claimInteraction } from "../../src/db/interaction-claims.ts";
import { claimReminder } from "../../src/db/reminders.ts";
import { todayInZone, type DateOnly } from "../../src/lib/dates.ts";
import { insertEvent, insertGuild, insertTask } from "../db/fixtures.ts";
import { fakeId } from "../db/harness.ts";
import { raceDatabase } from "./race.ts";

/**
 * The bot's write code against itself: many instances of the same write, each on its own
 * connection from the bot's pool, sent at the same moment. The database functions that
 * once did these writes took their locks in SQL; here the locks, the version checks and
 * the conflict clauses are in TypeScript, and these tests are what shows they hold.
 */
const db = raceDatabase();
const ATTEMPTS = 8;

const outcomes = (results: { ok: boolean }[]) =>
  results.filter((result) => result.ok).length;

describe("the same write from several instances at once", () => {
  it("a retried interaction is claimed by exactly one of them", async () => {
    const interactionId = fakeId();
    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, () =>
        claimInteraction(db.db, { interactionId }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.value).length).toBe(
      1,
    );
  });

  it("a task reminder is claimed by exactly one of them", async () => {
    const guild = await insertGuild(db.connection);
    const taskId = await insertTask(
      db.connection,
      guild,
      await insertEvent(db.connection, guild),
    );
    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, () =>
        claimReminder(db.db, {
          taskId,
          kind: "one_day",
          dueDate: "2030-01-10" as DateOnly,
        }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      results.filter((result) => result.ok && result.value !== null).length,
    ).toBe(1);
  });

  it("an event's step reminder is claimed by exactly one of them", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const reminderDate = todayInZone(new Date(), "America/New_York");
    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, () =>
        claimEventReminder(db.db, {
          eventId,
          kind: "daily_steps",
          reminderDate,
        }),
      ),
    );
    expect(
      results.filter((result) => result.ok && result.value !== null).length,
    ).toBe(1);
  });

  it("a step is completed by exactly one of them, and the rest are told it was done", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, () =>
        completeEventStep(db.db, {
          eventId,
          guildId: guild.guildId,
          kind: "budget_sheet",
          actorId: fakeId(),
        }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.value).length).toBe(
      1,
    );
  });

  it("a step takes at most ten people, whoever arrives together", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const results = await Promise.all(
      Array.from({ length: 16 }, () => {
        const userId = fakeId();
        return assignEventStep(db.db, {
          eventId,
          guildId: guild.guildId,
          kind: "budget_sheet",
          userId,
          actorId: userId,
        });
      }),
    );
    expect(outcomes(results)).toBe(10);
    expect(
      results
        .filter((result) => !result.ok)
        .every((result) => result.error.category === "step_assignee_limit"),
    ).toBe(true);
    const { rows } = await db.observer.query(
      "SELECT count(*)::int AS n FROM discord_bot.event_step_assignees WHERE event_id = $1 AND removed_at IS NULL",
      [eventId],
    );
    expect(rows).toEqual([{ n: 10 }]);
  });

  it("two saves of the same config version leave one winner and one audit row each for it", async () => {
    // insertGuild leaves the guild at version 2 with two audit rows.
    const guild = await insertGuild(db.connection);
    const save = (remindersEnabled: boolean) =>
      applyConfigChange(db.db, {
        guildId: guild.guildId,
        actorId: fakeId(),
        expectedVersion: 2,
        remindersEnabled,
        addChannelIds: [],
        removeChannelIds: [],
        timezone: null,
      });
    const results = await Promise.all([save(false), save(true), save(false)]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results
        .filter((result) => !result.ok)
        .every((result) => result.error.category === "stale_version"),
    ).toBe(true);
    const { rows } = await db.observer.query(
      "SELECT version FROM discord_bot.guild_config WHERE guild_id = $1",
      [guild.guildId],
    );
    expect(rows).toEqual([{ version: 3 }]);
    const audit = await db.observer.query(
      "SELECT count(*)::int AS n FROM discord_bot.config_audit WHERE guild_id = $1",
      [guild.guildId],
    );
    expect(audit.rows).toEqual([{ n: 3 }]);
  });

  it("two first setups of one server leave one config row", async () => {
    const guildId = fakeId();
    const setup = () =>
      applyRoleBindings(db.db, {
        guildId,
        actorId: fakeId(),
        expectedVersion: 0,
        officerRoleId: fakeId(),
        adminRoleId: fakeId(),
        eboardRoleId: null,
        eventsCommitteeRoleId: null,
        treasuryRoleId: null,
        marketingRoleId: null,
      });
    const results = await Promise.all([setup(), setup(), setup()]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results
        .filter((result) => !result.ok)
        .every((result) => result.error.category === "stale_version"),
    ).toBe(true);
    const { rows } = await db.observer.query(
      "SELECT count(*)::int AS n FROM discord_bot.config_audit WHERE guild_id = $1",
      [guildId],
    );
    expect(rows).toEqual([{ n: 1 }]);
  });
});
