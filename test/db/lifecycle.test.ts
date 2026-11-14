import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  FIXTURE_DUE_DATE as DUE,
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
  present,
  queryAs,
} from "./harness.ts";

const PARENT_UNAVAILABLE = "CF410";

describe("task lifecycle", () => {
  let db: PGlite;
  let guild: GuildFixture;

  beforeAll(async () => {
    db = await createMigratedDb();
    guild = await insertGuild(db);
  });

  afterAll(async () => {
    await db.close();
  });

  describe("open parent guard", () => {
    const insertEventOn = (channelId: string) =>
      queryAs(
        db,
        "bot_app",
        `INSERT INTO public.events (guild_id, channel_id, name, event_date, created_by)
         VALUES ($1, $2, 'Social', '2030-02-01', $3)`,
        [guild.guildId, channelId, fakeId()],
      );

    const addChannel = async (status: string) => {
      const channelId = fakeId();
      await queryAs(
        db,
        MIGRATION_OWNER,
        `INSERT INTO public.managed_channels (guild_id, channel_id, status) VALUES ($1, $2, $3)`,
        [guild.guildId, channelId, status],
      );
      return channelId;
    };

    it.each([
      ["deleted", `SELECT public.soft_delete_event($1, $2)`],
      ["closed", `UPDATE public.events SET status = 'closed' WHERE id = $1`],
    ])("rejects a task on a %s event", async (_name, sql) => {
      const eventId = await insertEvent(db, guild);
      const params = sql.includes("$2") ? [eventId, guild.guildId] : [eventId];
      await queryAs(db, "bot_app", sql, params);
      expect(await errorCodeOf(insertTask(db, guild, eventId))).toBe(
        PARENT_UNAVAILABLE,
      );
    });

    it("rejects an event on a removed channel but allows an unavailable one", async () => {
      expect(
        await errorCodeOf(insertEventOn(await addChannel("removed"))),
      ).toBe(PARENT_UNAVAILABLE);
      expect(
        await errorCodeOf(insertEventOn(await addChannel("unavailable"))),
      ).toBeUndefined();
    });
  });

  describe("soft_delete_event", () => {
    const softDelete = async (eventId: string, guildId = guild.guildId) => {
      const rows = await queryAs<{ deleted: number | null }>(
        db,
        "bot_app",
        `SELECT public.soft_delete_event($1, $2) AS deleted`,
        [eventId, guildId],
      );
      return rows[0]?.deleted;
    };

    const liveCounts = async (eventId: string) => {
      const { rows } = await db.query(
        `SELECT
           (SELECT count(*)::int FROM public.events WHERE id = $1 AND deleted_at IS NULL) AS events,
           (SELECT count(*)::int FROM public.tasks WHERE event_id = $1 AND deleted_at IS NULL) AS tasks`,
        [eventId],
      );
      return rows[0];
    };

    it("deletes the event and its tasks once, leaving other events alone", async () => {
      const keptEvent = await insertEvent(db, guild);
      await insertTask(db, guild, keptEvent);
      const eventId = await insertEvent(db, guild);
      await insertTask(db, guild, eventId);
      await insertTask(db, guild, eventId);

      expect(await softDelete(eventId)).toBe(2);
      expect(await liveCounts(eventId)).toEqual({ events: 0, tasks: 0 });
      expect(await liveCounts(keptEvent)).toEqual({ events: 1, tasks: 1 });
      expect(await softDelete(eventId)).toBeNull();
    });

    it("does not touch another guild's event", async () => {
      const eventId = await insertEvent(db, guild);
      expect(await softDelete(eventId, fakeId())).toBeNull();
      expect(await liveCounts(eventId)).toEqual({ events: 1, tasks: 0 });
    });
  });

  describe("reminder claims", () => {
    const claim = async (taskId: string, dueDate = DUE) => {
      const rows = await queryAs<{ token: string | null }>(
        db,
        "bot_app",
        `SELECT public.claim_reminder($1, 'one_day', $2) AS token`,
        [taskId, dueDate],
      );
      return rows[0]?.token ?? null;
    };

    const reclaim = async (taskId: string, token: string) => {
      const rows = await queryAs<{ token: string | null }>(
        db,
        "bot_app",
        `SELECT public.reclaim_reminder($1, 'one_day', '${DUE}', $2, 120) AS token`,
        [taskId, token],
      );
      return rows[0]?.token ?? null;
    };

    const markSent = async (taskId: string, token: string) => {
      const rows = await queryAs<{ marked: boolean }>(
        db,
        "bot_app",
        `SELECT public.mark_reminder_sent($1, 'one_day', '${DUE}', $2, $3) AS marked`,
        [taskId, token, fakeId()],
      );
      return rows[0]?.marked;
    };

    const markSkipped = async (taskId: string, token: string) => {
      const rows = await queryAs<{ marked: boolean }>(
        db,
        "bot_app",
        `SELECT public.mark_reminder_skipped($1, 'one_day', '${DUE}', $2) AS marked`,
        [taskId, token],
      );
      return rows[0]?.marked;
    };

    const age = (taskId: string, interval: string) =>
      db.query(
        `UPDATE public.reminder_log SET claimed_at = now() - $2::interval WHERE task_id = $1`,
        [taskId, interval],
      );

    const logRow = async (taskId: string) => {
      const { rows } = await db.query<{ state: string; attempts: number }>(
        `SELECT state, attempts FROM public.reminder_log WHERE task_id = $1`,
        [taskId],
      );
      return rows[0];
    };

    const newTask = async () =>
      insertTask(db, guild, await insertEvent(db, guild));

    it("gives the first claim a token and the second nothing", async () => {
      const taskId = await newTask();
      expect(typeof (await claim(taskId))).toBe("string");
      expect(await claim(taskId)).toBeNull();
      expect((await logRow(taskId))?.attempts).toBe(1);
    });

    it("claims the new due date after a move, and refuses the old one", async () => {
      const taskId = await newTask();
      const moved = "2030-03-01";
      await queryAs(
        db,
        MIGRATION_OWNER,
        `UPDATE public.tasks SET due_date = $2 WHERE id = $1`,
        [taskId, moved],
      );
      expect(await claim(taskId, DUE)).toBeNull();
      expect(await claim(taskId, moved)).not.toBeNull();
    });

    it.each([
      ["done", `status = 'done', completed_at = now()`],
      ["soft-deleted", `deleted_at = now()`],
    ])("refuses a claim on a %s task", async (_name, set) => {
      const taskId = await newTask();
      await queryAs(
        db,
        "bot_app",
        `UPDATE public.tasks SET ${set} WHERE id = $1`,
        [taskId],
      );
      expect(await claim(taskId)).toBeNull();
    });

    it("marks sent or skipped only with the right token, and both are final", async () => {
      const sentTask = await newTask();
      const sentToken = present(await claim(sentTask));
      expect(await markSent(sentTask, crypto.randomUUID())).toBe(false);
      expect(await markSent(sentTask, sentToken)).toBe(true);
      expect(await markSkipped(sentTask, sentToken)).toBe(false);
      expect((await logRow(sentTask))?.state).toBe("sent");

      const skippedTask = await newTask();
      const skipToken = present(await claim(skippedTask));
      expect(await markSkipped(skippedTask, crypto.randomUUID())).toBe(false);
      expect(await markSkipped(skippedTask, skipToken)).toBe(true);
      expect(await claim(skippedTask)).toBeNull();
      expect(await markSent(skippedTask, skipToken)).toBe(false);
      await age(skippedTask, "2 hours");
      expect(await reclaim(skippedTask, skipToken)).toBeNull();
      expect((await logRow(skippedTask))?.state).toBe("skipped");
    });

    it.each([
      [
        "forge a sent row",
        `INSERT INTO public.reminder_log (task_id, kind, due_date, state, sent_at) VALUES ($1, 'overdue', '${DUE}', 'sent', now())`,
      ],
      [
        "mark sent without a token",
        `UPDATE public.reminder_log SET state = 'sent', sent_at = now() WHERE task_id = $1`,
      ],
      [
        "steal a claim",
        `UPDATE public.reminder_log SET claim_token = gen_random_uuid() WHERE task_id = $1`,
      ],
    ])("bot_app cannot %s directly", async (_name, sql) => {
      const taskId = await newTask();
      await claim(taskId);
      expect(await errorCodeOf(queryAs(db, "bot_app", sql, [taskId]))).toBe(
        "42501",
      );
      expect((await logRow(taskId))?.state).toBe("claimed");
    });

    it("reclaims a stale claim once with a new token, and the old worker can no longer finish", async () => {
      const taskId = await newTask();
      const oldToken = present(await claim(taskId));
      await age(taskId, "100 seconds");
      expect(await reclaim(taskId, oldToken)).toBeNull();

      await age(taskId, "3 minutes");
      expect(await reclaim(taskId, crypto.randomUUID())).toBeNull();
      const newToken = present(await reclaim(taskId, oldToken));
      expect(newToken).not.toBe(oldToken);
      expect((await logRow(taskId))?.attempts).toBe(2);
      expect(await reclaim(taskId, newToken)).toBeNull();
      await age(taskId, "2 hours");
      expect(await reclaim(taskId, oldToken)).toBeNull();

      expect(await markSent(taskId, oldToken)).toBe(false);
      expect(await markSent(taskId, newToken)).toBe(true);
    });

    it.each([["sent"], ["done"]])(
      "refuses to reclaim once the reminder or task is %s",
      async (change) => {
        const taskId = await newTask();
        const token = present(await claim(taskId));
        if (change === "sent") await markSent(taskId, token);
        else
          await queryAs(
            db,
            "bot_app",
            `UPDATE public.tasks SET status = 'done', completed_at = now() WHERE id = $1`,
            [taskId],
          );
        await age(taskId, "2 hours");
        expect(await reclaim(taskId, token)).toBeNull();
      },
    );
  });
});
