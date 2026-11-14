/** Guards in the baseline that the bot's role cannot step around. */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

  describe("a deleted task", () => {
    async function deletedTask(): Promise<string> {
      const guild = await insertGuild(db);
      const taskId = await insertTask(db, guild, await insertEvent(db, guild));
      await queryAs(
        db,
        BOT_APP,
        "UPDATE public.tasks SET deleted_at = now() WHERE id = $1",
        [taskId],
      );
      return taskId;
    }

    it.each([
      ["undeleted", "NULL"],
      ["given another deletion time", "now() - interval '1 day'"],
    ])("cannot be %s by the bot", async (_label, value) => {
      const taskId = await deletedTask();
      expect(
        await errorCodeOf(
          queryAs(
            db,
            BOT_APP,
            `UPDATE public.tasks SET deleted_at = ${value} WHERE id = $1`,
            [taskId],
          ),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("can be brought back by the tables' owner, by hand", async () => {
      const taskId = await deletedTask();
      await queryAs(
        db,
        MIGRATION_OWNER,
        "UPDATE public.tasks SET deleted_at = NULL WHERE id = $1",
        [taskId],
      );
      const { rows } = await db.query(
        "SELECT deleted_at FROM public.tasks WHERE id = $1",
        [taskId],
      );
      expect(rows).toEqual([{ deleted_at: null }]);
    });
  });

  describe("a closed event", () => {
    async function closedEvent(): Promise<string> {
      const guild = await insertGuild(db);
      const eventId = await insertEvent(db, guild);
      await queryAs(
        db,
        BOT_APP,
        "UPDATE public.events SET status = 'closed' WHERE id = $1",
        [eventId],
      );
      return eventId;
    }

    const status = async (eventId: string): Promise<unknown> => {
      const { rows } = await db.query<{ status: string }>(
        "SELECT status FROM public.events WHERE id = $1",
        [eventId],
      );
      return rows[0]?.status;
    };

    it("cannot be reopened by the bot", async () => {
      const eventId = await closedEvent();
      expect(
        await errorCodeOf(
          queryAs(
            db,
            BOT_APP,
            "UPDATE public.events SET status = 'active' WHERE id = $1",
            [eventId],
          ),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await status(eventId)).toBe("closed");
    });

    it("can still have its other columns, and a repeated close, written by the bot", async () => {
      const eventId = await closedEvent();
      await queryAs(
        db,
        BOT_APP,
        "UPDATE public.events SET status = 'closed', name = 'Renamed' WHERE id = $1",
        [eventId],
      );
      expect(await status(eventId)).toBe("closed");
    });

    it("can be reopened by the tables' owner, by hand", async () => {
      const eventId = await closedEvent();
      await queryAs(
        db,
        MIGRATION_OWNER,
        "UPDATE public.events SET status = 'active' WHERE id = $1",
        [eventId],
      );
      expect(await status(eventId)).toBe("active");
    });
  });

  describe("a change of person", () => {
    it("counts against the officer's limit only when the person changes", async () => {
      const guild = await insertGuild(db);
      const taskId = await insertTask(db, guild, await insertEvent(db, guild));
      const actor = fakeId();
      const edit = async (assignee: string | null) => {
        const { rows } = await db.query<{
          assignee_id: string;
          updated_at: string;
        }>(
          "SELECT assignee_id, updated_at::text FROM public.tasks WHERE id = $1",
          [taskId],
        );
        const [task] = rows;
        await queryAs(
          db,
          BOT_APP,
          `SELECT public.edit_task($1, $2, $3, 'Book the room', '2030-01-10', $4, $5)`,
          [
            taskId,
            guild.guildId,
            task?.updated_at,
            assignee ?? task?.assignee_id,
            actor,
          ],
        );
      };
      const counted = async () => {
        const { rows } = await db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM public.task_reassignments WHERE actor_id = $1",
          [actor],
        );
        return rows[0]?.count;
      };

      await edit(null);
      expect(await counted()).toBe(0);
      await edit(fakeId());
      expect(await counted()).toBe(1);
    });
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

    const claim = async (kind: string, date: string) => {
      const rows = await queryAs<{ token: string | null }>(
        db,
        BOT_APP,
        "SELECT public.claim_event_reminder($1, $2::public.event_reminder_kind, $3) AS token",
        [eventId, kind, date],
      );
      return rows[0]?.token ?? null;
    };
    // The fixture's event is on 2030-01-15, and a reminder is claimed for today.
    const today = todayInZone(new Date(), "America/New_York");
    expect(await claim("pickup_two_days", today)).not.toBeNull();
    expect(await claim("pickup_day", today)).not.toBeNull();
  });

  it("claims a day's step reminder only for today or yesterday, never a day to come", async () => {
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    const claim = async (daysAgo: number) => {
      const rows = await queryAs<{ token: string | null }>(
        db,
        BOT_APP,
        `SELECT public.claim_event_reminder(
           $1, 'daily_steps',
           ((now() AT TIME ZONE 'America/New_York')::date - $2::int)
         ) AS token`,
        [eventId, daysAgo],
      );
      return rows[0]?.token ?? null;
    };
    expect(await claim(3)).toBeNull();
    expect(await claim(2)).toBeNull();
    // The event is years away, so only the bound on today refuses these.
    expect(await claim(-1)).toBeNull();
    expect(await claim(-30)).toBeNull();
    expect(await claim(0)).not.toBeNull();
    expect(await claim(1)).not.toBeNull();
  });
});
