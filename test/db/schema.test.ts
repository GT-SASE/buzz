import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertFinishedJobRun } from "../support/job-runs-fixture.ts";
import {
  insertEvent,
  insertGuild,
  insertTask,
  type GuildFixture,
  withoutQuotas,
} from "./fixtures.ts";
import {
  MIGRATION_OWNER,
  createMigratedDb,
  errorCodeOf,
  fakeId,
  queryAs,
} from "./harness.ts";

const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const INVALID_PARAMETER = "22023";

describe("schema constraints", () => {
  let db: PGlite;
  let guild: GuildFixture;

  beforeAll(async () => {
    db = await createMigratedDb();
    guild = await insertGuild(db);
  });

  afterAll(async () => {
    await db.close();
  });

  const insertConfig = (
    guildId: string,
    officerRoleId: string,
    adminRoleId: string,
  ) =>
    queryAs(
      db,
      MIGRATION_OWNER,
      `INSERT INTO public.guild_config (guild_id, officer_role_id, admin_role_id) VALUES ($1, $2, $3)`,
      [guildId, officerRoleId, adminRoleId],
    );

  it("rejects the guild ID (@everyone) as the officer role", async () => {
    const guildId = fakeId();
    expect(await errorCodeOf(insertConfig(guildId, guildId, fakeId()))).toBe(
      CHECK_VIOLATION,
    );
  });

  it("rejects the guild ID (@everyone) as the admin role", async () => {
    const guildId = fakeId();
    expect(await errorCodeOf(insertConfig(guildId, fakeId(), guildId))).toBe(
      CHECK_VIOLATION,
    );
  });

  it("rejects the guild ID (@everyone) when updating a role", async () => {
    const code = await errorCodeOf(
      queryAs(
        db,
        MIGRATION_OWNER,
        `UPDATE public.guild_config SET admin_role_id = guild_id WHERE guild_id = $1`,
        [guild.guildId],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it("applies the defaults for a new guild", async () => {
    const guildId = fakeId();
    await insertConfig(guildId, fakeId(), fakeId());
    const { rows } = await db.query(
      `SELECT timezone, reminders_enabled, version FROM public.guild_config WHERE guild_id = $1`,
      [guildId],
    );
    expect(rows).toEqual([
      { timezone: "America/New_York", reminders_enabled: true, version: 1 },
    ]);
  });

  it("rejects values that are not Discord IDs", async () => {
    expect(
      await errorCodeOf(insertConfig("not-a-snowflake", fakeId(), fakeId())),
    ).toBe(CHECK_VIOLATION);
  });

  describe("timezone", () => {
    const insertWithTimezone = (timezone: string) =>
      queryAs(
        db,
        MIGRATION_OWNER,
        `INSERT INTO public.guild_config (guild_id, officer_role_id, admin_role_id, timezone)
         VALUES ($1, $2, $3, $4)`,
        [fakeId(), fakeId(), fakeId(), timezone],
      );

    it("rejects an unknown timezone on insert", async () => {
      expect(await errorCodeOf(insertWithTimezone("Mars/Phobos"))).toBe(
        INVALID_PARAMETER,
      );
    });

    it("accepts a real timezone on insert", async () => {
      expect(
        await errorCodeOf(insertWithTimezone("Europe/London")),
      ).toBeUndefined();
    });

    it("rejects an unknown timezone on update", async () => {
      const code = await errorCodeOf(
        queryAs(
          db,
          MIGRATION_OWNER,
          `UPDATE public.guild_config SET timezone = 'Mars/Phobos' WHERE guild_id = $1`,
          [guild.guildId],
        ),
      );
      expect(code).toBe(INVALID_PARAMETER);
    });
  });

  it("rejects the same channel managed twice in a guild", async () => {
    const code = await errorCodeOf(
      queryAs(
        db,
        MIGRATION_OWNER,
        `INSERT INTO public.managed_channels (guild_id, channel_id) VALUES ($1, $2)`,
        [guild.guildId, guild.channelId],
      ),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it("rejects an event on another guild's channel", async () => {
    const other = await insertGuild(db);
    const code = await errorCodeOf(
      queryAs(
        db,
        "bot_app",
        `INSERT INTO public.events (guild_id, channel_id, name, event_date, created_by)
         VALUES ($1, $2, 'Social', '2030-02-01', $3)`,
        [guild.guildId, other.channelId, fakeId()],
      ),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("rejects a task on another guild's event", async () => {
    const other = await insertGuild(db);
    const eventId = await insertEvent(db, other);
    expect(await errorCodeOf(insertTask(db, guild, eventId))).toBe(
      FOREIGN_KEY_VIOLATION,
    );
  });

  describe("thread ownership", () => {
    const link = (eventId: string, threadId: string) =>
      queryAs(
        db,
        "bot_app",
        `UPDATE public.events SET thread_id = $2, thread_status = 'active' WHERE id = $1`,
        [eventId, threadId],
      );

    it("rejects two live events on the same thread", async () => {
      const threadId = fakeId();
      await link(await insertEvent(db, guild), threadId);
      expect(
        await errorCodeOf(link(await insertEvent(db, guild), threadId)),
      ).toBe(UNIQUE_VIOLATION);
    });

    const softDelete = (eventId: string) =>
      queryAs(db, "bot_app", `SELECT public.soft_delete_event($1, $2)`, [
        eventId,
        guild.guildId,
      ]);

    it("lets a new event adopt the thread of a soft-deleted event", async () => {
      const threadId = fakeId();
      const oldEvent = await insertEvent(db, guild);
      await link(oldEvent, threadId);
      await softDelete(oldEvent);
      expect(
        await errorCodeOf(link(await insertEvent(db, guild), threadId)),
      ).toBeUndefined();
    });

    it("rejects undeleting an event whose thread has been adopted", async () => {
      const threadId = fakeId();
      const oldEvent = await insertEvent(db, guild);
      await link(oldEvent, threadId);
      await softDelete(oldEvent);
      await link(await insertEvent(db, guild), threadId);
      const code = await errorCodeOf(
        queryAs(
          db,
          MIGRATION_OWNER,
          `UPDATE public.events SET deleted_at = NULL WHERE id = $1`,
          [oldEvent],
        ),
      );
      expect(code).toBe(UNIQUE_VIOLATION);
    });

    it("allows any number of events with no thread yet", async () => {
      await insertEvent(db, guild);
      expect(await errorCodeOf(insertEvent(db, guild))).toBeUndefined();
    });
  });

  it("rejects an event marked active with no thread", async () => {
    const eventId = await insertEvent(db, guild);
    const code = await errorCodeOf(
      queryAs(
        db,
        "bot_app",
        `UPDATE public.events SET thread_status = 'active' WHERE id = $1`,
        [eventId],
      ),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it("keeps completed_at in step with task status", async () => {
    const taskId = await insertTask(db, guild, await insertEvent(db, guild));
    const update = (set: string) =>
      queryAs(db, "bot_app", `UPDATE public.tasks SET ${set} WHERE id = $1`, [
        taskId,
      ]);
    expect(await errorCodeOf(update(`status = 'done'`))).toBe(CHECK_VIOLATION);
    expect(await errorCodeOf(update(`completed_at = now()`))).toBe(
      CHECK_VIOLATION,
    );
    expect(
      await errorCodeOf(update(`status = 'done', completed_at = now()`)),
    ).toBeUndefined();
  });

  describe("task due date range", () => {
    let eventId: string;

    beforeAll(async () => {
      eventId = await insertEvent(db, guild);
    });

    const insertDue = (dueDate: string) =>
      queryAs(
        db,
        "bot_app",
        `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
         VALUES ($1, $2, $3, 'Dated', $4::date, $3)`,
        [eventId, guild.guildId, fakeId(), dueDate],
      );

    it.each([
      "infinity",
      "-infinity",
      "0044-03-15 BC",
      "1999-12-31",
      "10000-01-01",
    ])("rejects %s", async (date) => {
      expect(await errorCodeOf(insertDue(date))).toBe(CHECK_VIOLATION);
    });

    it.each(["2000-01-01", "9999-12-31"])("accepts %s", async (date) => {
      expect(await errorCodeOf(insertDue(date))).toBeUndefined();
    });

    it("rejects moving a task to infinity", async () => {
      const taskId = await insertTask(db, guild, eventId);
      const code = await errorCodeOf(
        queryAs(
          db,
          MIGRATION_OWNER,
          `UPDATE public.tasks SET due_date = 'infinity' WHERE id = $1`,
          [taskId],
        ),
      );
      expect(code).toBe(CHECK_VIOLATION);
    });
  });

  describe("size limits, in code points", () => {
    // Four bytes each in UTF-8 and two code units in JavaScript, but one code point.
    const emoji = (count: number) => "\u{1F389}".repeat(count);

    const insertJobRun = (results: string, error: string | null) =>
      insertFinishedJobRun(db, {
        jobName: "sized",
        status: "failed",
        results,
        error,
      });

    it("a job error can hold 4000 code points, not 4001", async () => {
      expect(
        await errorCodeOf(insertJobRun("{}", emoji(4000))),
      ).toBeUndefined();
      expect(await errorCodeOf(insertJobRun("{}", emoji(4001)))).toBe(
        CHECK_VIOLATION,
      );
    });

    it("job results can hold 16000 code points, not 16001", async () => {
      // {"a": "..."} has 9 code points around the value.
      const sized = (total: number) => JSON.stringify({ a: emoji(total - 9) });
      expect(
        await errorCodeOf(insertJobRun(sized(16000), null)),
      ).toBeUndefined();
      expect(await errorCodeOf(insertJobRun(sized(16001), null))).toBe(
        CHECK_VIOLATION,
      );
    });

    // The reason no column has a NUL check: Postgres refuses these before any CHECK runs.
    it.each([
      ["text", `SELECT chr(0)`, "54000"],
      ["jsonb", `SELECT '{"a": "\\u0000"}'::jsonb`, "22P05"],
    ])("%s cannot hold a NUL character", async (_type, sql, code) => {
      expect(await errorCodeOf(db.query(sql))).toBe(code);
    });
  });

  describe("other date ranges", () => {
    it.each(["infinity", "-infinity", "0044-03-15 BC", "1999-12-31"])(
      "events.event_date rejects %s",
      async (date) => {
        const code = await errorCodeOf(
          queryAs(
            db,
            "bot_app",
            `INSERT INTO public.events (guild_id, channel_id, name, event_date, created_by)
           VALUES ($1, $2, 'Dated', $3::date, $4)`,
            [guild.guildId, guild.channelId, date, fakeId()],
          ),
        );
        expect(code).toBe(CHECK_VIOLATION);
      },
    );

    it("events.event_date cannot be moved to infinity", async () => {
      const eventId = await insertEvent(db, guild);
      const code = await errorCodeOf(
        queryAs(
          db,
          "bot_app",
          `UPDATE public.events SET event_date = 'infinity' WHERE id = $1`,
          [eventId],
        ),
      );
      expect(code).toBe(CHECK_VIOLATION);
    });

    it.each(["infinity", "-infinity", "0044-03-15 BC", "1999-12-31"])(
      "reminder_log.due_date rejects %s, even for the owner",
      async (date) => {
        const taskId = await insertTask(
          db,
          guild,
          await insertEvent(db, guild),
        );
        const code = await errorCodeOf(
          queryAs(
            db,
            MIGRATION_OWNER,
            `INSERT INTO public.reminder_log (task_id, kind, due_date) VALUES ($1, 'due_day', $2::date)`,
            [taskId, date],
          ),
        );
        expect(code).toBe(CHECK_VIOLATION);
      },
    );
  });

  it("refreshes updated_at when bot_app updates a row, without EXECUTE on the trigger function", async () => {
    const eventId = await insertEvent(db, guild);
    const taskId = await insertTask(db, guild, eventId);
    await db.exec(
      `UPDATE public.tasks SET updated_at = '2000-01-01' WHERE id = '${taskId}'`,
    );
    await queryAs(
      db,
      "bot_app",
      `UPDATE public.tasks SET status = 'done', completed_at = now() WHERE id = $1`,
      [taskId],
    );
    const { rows } = await db.query<{ refreshed: boolean }>(
      `SELECT updated_at > '2000-01-02' AS refreshed FROM public.tasks WHERE id = $1`,
      [taskId],
    );
    expect(rows).toEqual([{ refreshed: true }]);
  });

  describe("reminder_log", () => {
    const insertLog = (taskId: string, kind: string, dueDate = "2030-01-10") =>
      queryAs(
        db,
        MIGRATION_OWNER,
        `INSERT INTO public.reminder_log (task_id, kind, due_date) VALUES ($1, $2, $3)`,
        [taskId, kind, dueDate],
      );

    it("rejects a second row for the same task, kind and due date", async () => {
      const taskId = await insertTask(db, guild, await insertEvent(db, guild));
      await insertLog(taskId, "one_day");
      expect(await errorCodeOf(insertLog(taskId, "one_day"))).toBe(
        UNIQUE_VIOLATION,
      );
    });

    it("allows other kinds and other due dates for the same task", async () => {
      const taskId = await insertTask(db, guild, await insertEvent(db, guild));
      await insertLog(taskId, "one_day");
      expect(await errorCodeOf(insertLog(taskId, "due_day"))).toBeUndefined();
      expect(
        await errorCodeOf(insertLog(taskId, "one_day", "2030-02-02")),
      ).toBeUndefined();
    });

    it("requires sent_at and allows message_id only once sent", async () => {
      const taskId = await insertTask(db, guild, await insertEvent(db, guild));
      await insertLog(taskId, "three_days");
      const update = (set: string, params: unknown[] = []) =>
        queryAs(
          db,
          MIGRATION_OWNER,
          `UPDATE public.reminder_log SET ${set} WHERE task_id = $1`,
          [taskId, ...params],
        );
      expect(await errorCodeOf(update(`state = 'sent'`))).toBe(CHECK_VIOLATION);
      expect(await errorCodeOf(update(`message_id = $2`, [fakeId()]))).toBe(
        CHECK_VIOLATION,
      );
      expect(
        await errorCodeOf(
          update(`state = 'sent', sent_at = now(), message_id = $2`, [
            fakeId(),
          ]),
        ),
      ).toBeUndefined();
    });
  });

  describe("reminder planner query", () => {
    // The shape the reminder run depends on, with every join that can stop a send.
    const plannerQuery = (lastDueDate: string) => `
      SELECT t.id
      FROM public.tasks t
      JOIN public.events e ON e.id = t.event_id AND e.guild_id = t.guild_id
      JOIN public.managed_channels c ON c.guild_id = e.guild_id AND c.channel_id = e.channel_id
      JOIN public.guild_config g ON g.guild_id = t.guild_id
      WHERE t.status = 'open'
        AND t.deleted_at IS NULL
        AND t.due_date <= '${lastDueDate}'
        AND e.status = 'active'
        AND e.deleted_at IS NULL
        AND c.status = 'active'
        AND g.reminders_enabled
        AND NOT EXISTS (
          SELECT 1 FROM public.reminder_log r
          WHERE r.task_id = t.id AND r.kind = 'one_day' AND r.due_date = t.due_date
        )`;

    const plannedIds = async (): Promise<string[]> => {
      const rows = await queryAs<{ id: string }>(
        db,
        "bot_app",
        plannerQuery("2030-01-10"),
      );
      return rows.map((row) => row.id);
    };

    /** A guild of its own with one eligible task, for each test to disqualify a different way. */
    async function setUp() {
      const own = await insertGuild(db);
      const eventId = await insertEvent(db, own);
      const taskId = await insertTask(db, own, eventId);
      expect(await plannedIds()).toContain(taskId);
      return { own, eventId, taskId };
    }

    it("skips a task with reminders off for its guild", async () => {
      const { own, taskId } = await setUp();
      await queryAs(
        db,
        MIGRATION_OWNER,
        `UPDATE public.guild_config SET reminders_enabled = false WHERE guild_id = $1`,
        [own.guildId],
      );
      expect(await plannedIds()).not.toContain(taskId);
    });

    it("skips a task in a removed channel", async () => {
      const { own, taskId } = await setUp();
      await queryAs(
        db,
        MIGRATION_OWNER,
        `UPDATE public.managed_channels SET status = 'removed' WHERE guild_id = $1`,
        [own.guildId],
      );
      expect(await plannedIds()).not.toContain(taskId);
    });

    it.each([
      ["a closed event", `status = 'closed'`],
      ["a deleted event", `deleted_at = now()`],
    ])("skips a task under %s", async (_name, set) => {
      const { eventId, taskId } = await setUp();
      await queryAs(
        db,
        MIGRATION_OWNER,
        `UPDATE public.events SET ${set} WHERE id = $1`,
        [eventId],
      );
      expect(await plannedIds()).not.toContain(taskId);
    });

    it("skips a task already logged for this kind and date, until its date moves", async () => {
      const { taskId } = await setUp();
      await queryAs(
        db,
        "bot_app",
        `SELECT public.claim_reminder($1, 'one_day', '2030-01-10')`,
        [taskId],
      );
      expect(await plannedIds()).not.toContain(taskId);

      await queryAs(
        db,
        MIGRATION_OWNER,
        `UPDATE public.tasks SET due_date = '2030-01-09' WHERE id = $1`,
        [taskId],
      );
      expect(await plannedIds()).toContain(taskId);
    });

    describe("with realistic volume", () => {
      const assigneeId = fakeId();
      const otherAssigneeBase = fakeId();

      beforeAll(async () => {
        // The planner ignores indexes on tiny tables, so plans need realistic volume.
        const eventId = await insertEvent(db, guild);
        // Far more than the quotas allow, so they are off for this one insert.
        await withoutQuotas(db, () =>
          db.query(
            `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
           SELECT $1::uuid, $2::text,
                  CASE WHEN n % 100 = 0 THEN $3::text ELSE ($4::bigint + n % 100)::text END,
                  'Volume row', date '2030-01-01' + (n % 700), $3::text
           FROM generate_series(1, 5000) AS n`,
            [eventId, guild.guildId, assigneeId, otherAssigneeBase],
          ),
        );
        await db.query(
          `INSERT INTO public.reminder_log (task_id, kind, due_date, state, sent_at)
           SELECT id, 'three_days', due_date, 'sent', now() FROM public.tasks
           ON CONFLICT DO NOTHING`,
        );
        await db.exec(
          "ANALYZE public.tasks; ANALYZE public.reminder_log; ANALYZE public.events;",
        );
      });

      async function planFor(sql: string): Promise<string> {
        const { rows } = await db.query<{ "QUERY PLAN": string }>(
          `EXPLAIN ${sql}`,
        );
        return rows.map((row) => row["QUERY PLAN"]).join("\n");
      }

      it("the full planner query uses the due date index", async () => {
        expect(await planFor(plannerQuery("2030-01-03"))).toContain(
          "tasks_open_by_due_date_idx",
        );
      });

      it("the /mytasks query uses its index", async () => {
        const plan = await planFor(
          `SELECT id FROM public.tasks
           WHERE guild_id = '${guild.guildId}' AND assignee_id = '${assigneeId}'
             AND status = 'open' AND deleted_at IS NULL
           ORDER BY due_date`,
        );
        expect(plan).toContain("tasks_open_by_assignee_idx");
      });

      it("the officers' task picker walks an index and stops at 25", async () => {
        const plan = await planFor(
          `SELECT id FROM public.tasks
           WHERE guild_id = '${guild.guildId}' AND status = 'open' AND deleted_at IS NULL
             AND description ILIKE '%volume%'
           ORDER BY due_date, id LIMIT 25`,
        );
        expect(plan).toContain("tasks_open_by_due_date_idx");
      });

      it("a member's task picker uses their index", async () => {
        const plan = await planFor(
          `SELECT id FROM public.tasks
           WHERE guild_id = '${guild.guildId}' AND assignee_id = '${assigneeId}'
             AND status = 'open' AND deleted_at IS NULL
             AND description ILIKE '%volume%'
           ORDER BY due_date, id LIMIT 25`,
        );
        expect(plan).toContain("tasks_open_by_assignee_idx");
      });

      it("the per-officer task count uses its index", async () => {
        const plan = await planFor(
          `SELECT count(*) FROM public.tasks
           WHERE guild_id = '${guild.guildId}' AND created_by = '${fakeId()}'
             AND created_at > now() - interval '24 hours'`,
        );
        expect(plan).toContain("tasks_by_creator_idx");
      });

      it("the stale claim query uses its index", async () => {
        const plan = await planFor(
          `SELECT task_id FROM public.reminder_log
           WHERE state = 'claimed' AND claimed_at < '2030-01-10'`,
        );
        expect(plan).toContain("reminder_log_open_claims_idx");
      });
    });
  });
});
