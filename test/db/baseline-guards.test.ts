/** Guards in the baseline that the bot's role cannot step around. */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { todayInZone } from "../../src/lib/dates.ts";
import { insertEvent, insertGuild, insertTask } from "./fixtures.ts";
import {
  BOT_APP,
  INSUFFICIENT_PRIVILEGE,
  MIGRATION_OWNER,
  createMigratedDb,
  errorCodeOf,
  fakeId,
  queryAs,
} from "./harness.ts";

describe("the baseline's guards", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  const column = async (table: string, name: string, id: string) => {
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT ${name} FROM public.${table} WHERE id = $1`,
      [id],
    );
    return rows[0]?.[name];
  };

  it.each([
    ["undeleted", "NULL"],
    ["given another deletion time", "now() - interval '1 day'"],
  ])(
    "a deleted task cannot be %s by the bot, only by the owner",
    async (_label, value) => {
      const guild = await insertGuild(db);
      const taskId = await insertTask(db, guild, await insertEvent(db, guild));
      const sql = `UPDATE public.tasks SET deleted_at = ${value} WHERE id = $1`;
      await queryAs(
        db,
        BOT_APP,
        "UPDATE public.tasks SET deleted_at = now() WHERE id = $1",
        [taskId],
      );
      expect(await errorCodeOf(queryAs(db, BOT_APP, sql, [taskId]))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      await queryAs(db, MIGRATION_OWNER, sql, [taskId]);
    },
  );

  it("a closed event cannot be reopened by the bot, only by the owner", async () => {
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    const reopen = "UPDATE public.events SET status = 'active' WHERE id = $1";
    await queryAs(
      db,
      BOT_APP,
      "UPDATE public.events SET status = 'closed' WHERE id = $1",
      [eventId],
    );
    expect(await errorCodeOf(queryAs(db, BOT_APP, reopen, [eventId]))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );

    // Other columns, and a repeated close, are still allowed.
    await queryAs(
      db,
      BOT_APP,
      "UPDATE public.events SET status = 'closed', name = 'Renamed' WHERE id = $1",
      [eventId],
    );
    expect(await column("events", "status", eventId)).toBe("closed");

    await queryAs(db, MIGRATION_OWNER, reopen, [eventId]);
    expect(await column("events", "status", eventId)).toBe("active");
  });

  it("counts a task edit against the officer's limit only when the person changes", async () => {
    const guild = await insertGuild(db);
    const taskId = await insertTask(db, guild, await insertEvent(db, guild));
    const actor = fakeId();
    const edit = async (assignee?: string) => {
      const { rows } = await db.query<{ assignee_id: string; v: string }>(
        "SELECT assignee_id, updated_at::text AS v FROM public.tasks WHERE id = $1",
        [taskId],
      );
      await queryAs(
        db,
        BOT_APP,
        `SELECT public.edit_task($1, $2, $3, 'Book the room', '2030-01-10', $4, $5)`,
        [
          taskId,
          guild.guildId,
          rows[0]?.v,
          assignee ?? rows[0]?.assignee_id,
          actor,
        ],
      );
      const counted = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM public.task_reassignments WHERE actor_id = $1",
        [actor],
      );
      return counted.rows[0]?.n;
    };

    expect(await edit()).toBe(0);
    expect(await edit(fakeId())).toBe(1);
  });

  it("refuses a step's hand-off on a closed event as parent_unavailable", async () => {
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    await queryAs(
      db,
      BOT_APP,
      "SELECT public.complete_event_step($1, $2, 'budget_sheet', $3)",
      [eventId, guild.guildId, fakeId()],
    );
    await queryAs(
      db,
      BOT_APP,
      "UPDATE public.events SET status = 'closed' WHERE id = $1",
      [eventId],
    );
    expect(
      await errorCodeOf(
        queryAs(
          db,
          BOT_APP,
          "SELECT public.claim_step_handoff($1, $2, 'budget_sheet')",
          [eventId, guild.guildId],
        ),
      ),
    ).toBe("CF410");
  });

  describe("event reminder claims", () => {
    const claim = async (eventId: string, kind: string, date: string) => {
      const rows = await queryAs<{ token: string | null }>(
        db,
        BOT_APP,
        "SELECT public.claim_event_reminder($1, $2::public.event_reminder_kind, $3) AS token",
        [eventId, kind, date],
      );
      return rows[0]?.token ?? null;
    };

    it("sets up Food pickup and its reminders without waiting for the budget", async () => {
      const guild = await insertGuild(db);
      const eventId = await insertEvent(db, guild);
      const actor = fakeId();
      await queryAs(
        db,
        BOT_APP,
        "SELECT public.assign_event_step($1, $2, 'food_pickup', $3, $3)",
        [eventId, guild.guildId, actor],
      );
      const done = await queryAs<{ done: boolean }>(
        db,
        BOT_APP,
        "SELECT public.set_event_pickup_time($1, $2, '17:30', $3) AS done",
        [eventId, guild.guildId, actor],
      );
      expect(done).toEqual([{ done: true }]);

      // The fixture's event is on 2030-01-15, and a reminder is claimed for today.
      const today = todayInZone(new Date(), "America/New_York");
      expect(await claim(eventId, "pickup_before", today)).not.toBeNull();
      expect(await claim(eventId, "pickup_day", today)).not.toBeNull();
    });

    it("claims a day's step reminder only for today or yesterday, never a day to come", async () => {
      const guild = await insertGuild(db);
      const eventId = await insertEvent(db, guild);
      const daysAgo = async (days: number) => {
        const { rows } = await db.query<{ d: string }>(
          `SELECT ((now() AT TIME ZONE 'America/New_York')::date - $1::int)::text AS d`,
          [days],
        );
        return claim(eventId, "daily_steps", rows[0]?.d ?? "");
      };
      expect(await daysAgo(2)).toBeNull();
      // The event is years away, so only the bound on today refuses this.
      expect(await daysAgo(-1)).toBeNull();
      expect(await daysAgo(0)).not.toBeNull();
      expect(await daysAgo(1)).not.toBeNull();
    });
  });
});
