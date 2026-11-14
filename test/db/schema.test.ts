import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { insertFinishedJobRun } from "../support/job-runs-fixture.ts";
import {
  insertEvent,
  insertGuild,
  insertTask,
  type GuildFixture,
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

  const asOwner = (sql: string, params: unknown[] = []) =>
    queryAs(db, MIGRATION_OWNER, sql, params);
  const asBot = (sql: string, params: unknown[] = []) =>
    queryAs(db, "bot_app", sql, params);

  describe("guild_config", () => {
    const insertConfig = (
      guildId: string,
      officerRoleId: string,
      adminRoleId: string,
      timezone = "America/New_York",
    ) =>
      asOwner(
        `INSERT INTO public.guild_config (guild_id, officer_role_id, admin_role_id, timezone)
         VALUES ($1, $2, $3, $4)`,
        [guildId, officerRoleId, adminRoleId, timezone],
      );

    it("rejects the guild ID (@everyone) as either role, on insert or update", async () => {
      const guildId = fakeId();
      expect(await errorCodeOf(insertConfig(guildId, guildId, fakeId()))).toBe(
        CHECK_VIOLATION,
      );
      expect(await errorCodeOf(insertConfig(guildId, fakeId(), guildId))).toBe(
        CHECK_VIOLATION,
      );
      expect(
        await errorCodeOf(
          asOwner(
            `UPDATE public.guild_config SET admin_role_id = guild_id WHERE guild_id = $1`,
            [guild.guildId],
          ),
        ),
      ).toBe(CHECK_VIOLATION);
    });

    it("rejects values that are not Discord IDs", async () => {
      expect(
        await errorCodeOf(insertConfig("not-a-snowflake", fakeId(), fakeId())),
      ).toBe(CHECK_VIOLATION);
    });

    it("applies the defaults for a new guild", async () => {
      const guildId = fakeId();
      await asOwner(
        `INSERT INTO public.guild_config (guild_id, officer_role_id, admin_role_id) VALUES ($1, $2, $3)`,
        [guildId, fakeId(), fakeId()],
      );
      const { rows } = await db.query(
        `SELECT timezone, reminders_enabled, version FROM public.guild_config WHERE guild_id = $1`,
        [guildId],
      );
      expect(rows).toEqual([
        { timezone: "America/New_York", reminders_enabled: true, version: 1 },
      ]);
    });

    it("accepts a real timezone and rejects an unknown one, on insert or update", async () => {
      expect(
        await errorCodeOf(
          insertConfig(fakeId(), fakeId(), fakeId(), "Europe/London"),
        ),
      ).toBeUndefined();
      expect(
        await errorCodeOf(
          insertConfig(fakeId(), fakeId(), fakeId(), "Mars/Phobos"),
        ),
      ).toBe(INVALID_PARAMETER);
      expect(
        await errorCodeOf(
          asOwner(
            `UPDATE public.guild_config SET timezone = 'Mars/Phobos' WHERE guild_id = $1`,
            [guild.guildId],
          ),
        ),
      ).toBe(INVALID_PARAMETER);
    });
  });

  describe("guild scoping", () => {
    it("rejects the same channel managed twice in a guild", async () => {
      const code = await errorCodeOf(
        asOwner(
          `INSERT INTO public.managed_channels (guild_id, channel_id) VALUES ($1, $2)`,
          [guild.guildId, guild.channelId],
        ),
      );
      expect(code).toBe(UNIQUE_VIOLATION);
    });

    it("rejects an event on another guild's channel", async () => {
      const other = await insertGuild(db);
      const code = await errorCodeOf(
        asBot(
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
  });

  describe("thread ownership", () => {
    const link = (eventId: string, threadId: string) =>
      asBot(
        `UPDATE public.events SET thread_id = $2, thread_status = 'active' WHERE id = $1`,
        [eventId, threadId],
      );

    it("rejects two live events on the same thread, and an active event with none", async () => {
      const threadId = fakeId();
      await link(await insertEvent(db, guild), threadId);
      expect(
        await errorCodeOf(link(await insertEvent(db, guild), threadId)),
      ).toBe(UNIQUE_VIOLATION);
      const code = await errorCodeOf(
        asBot(
          `UPDATE public.events SET thread_status = 'active' WHERE id = $1`,
          [await insertEvent(db, guild)],
        ),
      );
      expect(code).toBe(CHECK_VIOLATION);
    });

    it("lets a new event adopt a deleted event's thread, and then refuses the undelete", async () => {
      const threadId = fakeId();
      const oldEvent = await insertEvent(db, guild);
      await link(oldEvent, threadId);
      await asBot(`SELECT public.soft_delete_event($1, $2)`, [
        oldEvent,
        guild.guildId,
      ]);
      expect(
        await errorCodeOf(link(await insertEvent(db, guild), threadId)),
      ).toBeUndefined();
      const code = await errorCodeOf(
        asOwner(`UPDATE public.events SET deleted_at = NULL WHERE id = $1`, [
          oldEvent,
        ]),
      );
      expect(code).toBe(UNIQUE_VIOLATION);
    });
  });

  it("keeps completed_at in step with task status", async () => {
    const taskId = await insertTask(db, guild, await insertEvent(db, guild));
    const update = (set: string) =>
      asBot(`UPDATE public.tasks SET ${set} WHERE id = $1`, [taskId]);
    expect(await errorCodeOf(update(`status = 'done'`))).toBe(CHECK_VIOLATION);
    expect(await errorCodeOf(update(`completed_at = now()`))).toBe(
      CHECK_VIOLATION,
    );
    expect(
      await errorCodeOf(update(`status = 'done', completed_at = now()`)),
    ).toBeUndefined();
  });

  describe("date ranges", () => {
    const insertDue = async (dueDate: string) =>
      asBot(
        `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
         VALUES ($1, $2, $3, 'Dated', $4::date, $3)`,
        [await insertEvent(db, guild), guild.guildId, fakeId(), dueDate],
      );

    it.each(["infinity", "0044-03-15 BC", "1999-12-31", "10000-01-01"])(
      "a task's due date rejects %s",
      async (date) => {
        expect(await errorCodeOf(insertDue(date))).toBe(CHECK_VIOLATION);
      },
    );

    it.each(["2000-01-01", "9999-12-31"])(
      "a task's due date accepts %s",
      async (date) => {
        expect(await errorCodeOf(insertDue(date))).toBeUndefined();
      },
    );

    it.each([
      ["a task's due date", "tasks", "due_date"],
      ["an event's date", "events", "event_date"],
    ])("%s cannot be moved to infinity", async (_name, table, col) => {
      const eventId = await insertEvent(db, guild);
      const id =
        table === "tasks" ? await insertTask(db, guild, eventId) : eventId;
      expect(
        await errorCodeOf(
          asOwner(
            `UPDATE public.${table} SET ${col} = 'infinity' WHERE id = $1`,
            [id],
          ),
        ),
      ).toBe(CHECK_VIOLATION);
    });

    it("rejects an out-of-range event date and reminder log date, even for the owner", async () => {
      expect(
        await errorCodeOf(
          asBot(
            `INSERT INTO public.events (guild_id, channel_id, name, event_date, created_by)
             VALUES ($1, $2, 'Dated', '-infinity', $3)`,
            [guild.guildId, guild.channelId, fakeId()],
          ),
        ),
      ).toBe(CHECK_VIOLATION);
      const taskId = await insertTask(db, guild, await insertEvent(db, guild));
      expect(
        await errorCodeOf(
          asOwner(
            `INSERT INTO public.reminder_log (task_id, kind, due_date) VALUES ($1, 'due_day', '1999-12-31')`,
            [taskId],
          ),
        ),
      ).toBe(CHECK_VIOLATION);
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

    it("a job error holds 4000 code points, and results 16000, but no more", async () => {
      // {"a": "..."} has 9 code points around the value.
      const sized = (total: number) => JSON.stringify({ a: emoji(total - 9) });
      expect(
        await errorCodeOf(insertJobRun("{}", emoji(4000))),
      ).toBeUndefined();
      expect(await errorCodeOf(insertJobRun("{}", emoji(4001)))).toBe(
        CHECK_VIOLATION,
      );
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

  it("refreshes updated_at when bot_app updates a row, without EXECUTE on the trigger function", async () => {
    const taskId = await insertTask(db, guild, await insertEvent(db, guild));
    await db.query(
      `UPDATE public.tasks SET updated_at = '2000-01-01' WHERE id = $1`,
      [taskId],
    );
    await asBot(
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
      asOwner(
        `INSERT INTO public.reminder_log (task_id, kind, due_date) VALUES ($1, $2, $3)`,
        [taskId, kind, dueDate],
      );

    it("keeps one row per task, kind and due date", async () => {
      const taskId = await insertTask(db, guild, await insertEvent(db, guild));
      await insertLog(taskId, "one_day");
      expect(await errorCodeOf(insertLog(taskId, "one_day"))).toBe(
        UNIQUE_VIOLATION,
      );
      expect(await errorCodeOf(insertLog(taskId, "due_day"))).toBeUndefined();
      expect(
        await errorCodeOf(insertLog(taskId, "one_day", "2030-02-02")),
      ).toBeUndefined();
    });

    it("requires sent_at and allows message_id only once sent", async () => {
      const taskId = await insertTask(db, guild, await insertEvent(db, guild));
      await insertLog(taskId, "three_days");
      const update = (set: string, params: unknown[] = []) =>
        asOwner(`UPDATE public.reminder_log SET ${set} WHERE task_id = $1`, [
          taskId,
          ...params,
        ]);
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
});
