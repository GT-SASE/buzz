import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
        "service_role",
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

    it("rejects a task on a deleted event", async () => {
      const eventId = await insertEvent(db, guild);
      await queryAs(
        db,
        "service_role",
        `SELECT public.soft_delete_event($1, $2)`,
        [eventId, guild.guildId],
      );
      expect(await errorCodeOf(insertTask(db, guild, eventId))).toBe(
        PARENT_UNAVAILABLE,
      );
    });

    it("rejects a task on a closed event", async () => {
      const eventId = await insertEvent(db, guild);
      await queryAs(
        db,
        "service_role",
        `UPDATE public.events SET status = 'closed' WHERE id = $1`,
        [eventId],
      );
      expect(await errorCodeOf(insertTask(db, guild, eventId))).toBe(
        PARENT_UNAVAILABLE,
      );
    });

    it("rejects an event on a removed channel", async () => {
      expect(
        await errorCodeOf(insertEventOn(await addChannel("removed"))),
      ).toBe(PARENT_UNAVAILABLE);
    });

    it("allows an event on an unavailable channel, which may come back", async () => {
      expect(
        await errorCodeOf(insertEventOn(await addChannel("unavailable"))),
      ).toBeUndefined();
    });

    it("allows a task on a live event", async () => {
      const eventId = await insertEvent(db, guild);
      expect(await errorCodeOf(insertTask(db, guild, eventId))).toBeUndefined();
    });

    it("leaves a missing parent for the foreign key to report", async () => {
      expect(await errorCodeOf(insertEventOn(fakeId()))).toBe("23503");
    });
  });

  it("every lifecycle function is SECURITY DEFINER", async () => {
    const { rows } = await db.query(
      `SELECT proname, prosecdef FROM pg_proc
       WHERE proname IN ('soft_delete_event', 'claim_reminder', 'reclaim_reminder',
                         'mark_reminder_sent', 'mark_reminder_skipped', 'require_open_parent')
       ORDER BY proname`,
    );
    expect(rows).toEqual(
      [
        "claim_reminder",
        "mark_reminder_sent",
        "mark_reminder_skipped",
        "reclaim_reminder",
        "require_open_parent",
        "soft_delete_event",
      ].map((proname) => ({ proname, prosecdef: true })),
    );
  });

  describe("soft_delete_event", () => {
    const softDelete = async (eventId: string, guildId = guild.guildId) => {
      const rows = await queryAs<{ deleted: number | null }>(
        db,
        "service_role",
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

    it("deletes the event and its tasks and reports how many tasks", async () => {
      const eventId = await insertEvent(db, guild);
      await insertTask(db, guild, eventId);
      await insertTask(db, guild, eventId);

      expect(await softDelete(eventId)).toBe(2);
      expect(await liveCounts(eventId)).toEqual({ events: 0, tasks: 0 });
    });

    it("leaves tasks on other events alone", async () => {
      const keptEvent = await insertEvent(db, guild);
      await insertTask(db, guild, keptEvent);
      await softDelete(await insertEvent(db, guild));
      expect(await liveCounts(keptEvent)).toEqual({ events: 1, tasks: 1 });
    });

    it("returns null for an event already deleted", async () => {
      const eventId = await insertEvent(db, guild);
      await softDelete(eventId);
      expect(await softDelete(eventId)).toBeNull();
    });

    it("does not touch another guild's event", async () => {
      const eventId = await insertEvent(db, guild);
      expect(await softDelete(eventId, fakeId())).toBeNull();
      expect(await liveCounts(eventId)).toEqual({ events: 1, tasks: 0 });
    });

    it("rolls the event back if its tasks cannot be deleted", async () => {
      const eventId = await insertEvent(db, guild);
      await insertTask(db, guild, eventId);
      await db.exec(`
        CREATE FUNCTION public.test_fail_task() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'task write failed' USING ERRCODE = 'XX999'; END; $$;
        CREATE TRIGGER test_fail_task BEFORE UPDATE ON public.tasks
          FOR EACH ROW EXECUTE FUNCTION public.test_fail_task();
      `);
      try {
        expect(await errorCodeOf(softDelete(eventId))).toBe("XX999");
      } finally {
        await db.exec(`
          DROP TRIGGER test_fail_task ON public.tasks;
          DROP FUNCTION public.test_fail_task();
        `);
      }
      expect(await liveCounts(eventId)).toEqual({ events: 1, tasks: 1 });
    });
  });

  describe("reminder claims", () => {
    const claim = async (taskId: string, dueDate = DUE) => {
      const rows = await queryAs<{ token: string | null }>(
        db,
        "service_role",
        `SELECT public.claim_reminder($1, 'one_day', $2) AS token`,
        [taskId, dueDate],
      );
      return rows[0]?.token ?? null;
    };

    const reclaim = async (taskId: string, token: string) => {
      const rows = await queryAs<{ token: string | null }>(
        db,
        "service_role",
        `SELECT public.reclaim_reminder($1, 'one_day', '${DUE}', $2) AS token`,
        [taskId, token],
      );
      return rows[0]?.token ?? null;
    };

    const markSent = async (taskId: string, token: string) => {
      const rows = await queryAs<{ marked: boolean }>(
        db,
        "service_role",
        `SELECT public.mark_reminder_sent($1, 'one_day', '${DUE}', $2, $3) AS marked`,
        [taskId, token, fakeId()],
      );
      return rows[0]?.marked;
    };

    const age = (taskId: string, interval: string) =>
      db.query(
        `UPDATE public.reminder_log SET claimed_at = now() - $2::interval WHERE task_id = $1`,
        [taskId, interval],
      );

    const logRow = async (taskId: string) => {
      const { rows } = await db.query<{
        state: string;
        attempts: number;
        sent: boolean;
        has_message: boolean;
      }>(
        `SELECT state, attempts, sent_at IS NOT NULL AS sent, message_id IS NOT NULL AS has_message
         FROM public.reminder_log WHERE task_id = $1`,
        [taskId],
      );
      return rows[0];
    };

    const newTask = async () =>
      insertTask(db, guild, await insertEvent(db, guild));

    it("gives the first claim a token and the second nothing", async () => {
      const taskId = await newTask();
      expect(await claim(taskId)).toEqual(expect.any(String));
      expect(await claim(taskId)).toBeNull();
      expect((await logRow(taskId))?.attempts).toBe(1);
    });

    it("claims again after the due date changes", async () => {
      const taskId = await newTask();
      expect(await claim(taskId)).not.toBeNull();

      const moved = "2030-03-01";
      await queryAs(
        db,
        "service_role",
        `UPDATE public.tasks SET due_date = $2 WHERE id = $1`,
        [taskId, moved],
      );

      expect(await claim(taskId, moved)).not.toBeNull();
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM public.reminder_log WHERE task_id = $1`,
        [taskId],
      );
      expect(rows).toEqual([{ n: 2 }]);
    });

    it("refuses a claim for a due date the task no longer has", async () => {
      const taskId = await newTask();
      await queryAs(
        db,
        "service_role",
        `UPDATE public.tasks SET due_date = '2030-03-01' WHERE id = $1`,
        [taskId],
      );
      expect(await claim(taskId, DUE)).toBeNull();
    });

    it.each([
      ["done", `status = 'done', completed_at = now()`],
      ["soft-deleted", `deleted_at = now()`],
    ])("refuses a claim on a %s task", async (_name, set) => {
      const taskId = await newTask();
      await queryAs(
        db,
        "service_role",
        `UPDATE public.tasks SET ${set} WHERE id = $1`,
        [taskId],
      );
      expect(await claim(taskId)).toBeNull();
    });

    describe("skipping", () => {
      const markSkipped = async (taskId: string, token: string) => {
        const rows = await queryAs<{ marked: boolean }>(
          db,
          "service_role",
          `SELECT public.mark_reminder_skipped($1, 'one_day', '${DUE}', $2) AS marked`,
          [taskId, token],
        );
        return rows[0]?.marked;
      };

      it("marks skipped with the right token, and the skip is final", async () => {
        const taskId = await newTask();
        const token = present(await claim(taskId));

        expect(await markSkipped(taskId, token)).toBe(true);

        expect(await logRow(taskId)).toEqual({
          state: "skipped",
          attempts: 1,
          sent: false,
          has_message: false,
        });
        expect(await claim(taskId)).toBeNull();
        expect(await markSent(taskId, token)).toBe(false);
        await age(taskId, "2 hours");
        expect(await reclaim(taskId, token)).toBeNull();
      });

      it("refuses to skip with the wrong token", async () => {
        const taskId = await newTask();
        await claim(taskId);
        expect(await markSkipped(taskId, crypto.randomUUID())).toBe(false);
        expect((await logRow(taskId))?.state).toBe("claimed");
      });

      it("cannot overwrite a sent reminder", async () => {
        const taskId = await newTask();
        const token = present(await claim(taskId));
        await markSent(taskId, token);
        expect(await markSkipped(taskId, token)).toBe(false);
        expect((await logRow(taskId))?.state).toBe("sent");
      });
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
        "skip without a token",
        `UPDATE public.reminder_log SET state = 'skipped' WHERE task_id = $1`,
      ],
      [
        "steal a claim",
        `UPDATE public.reminder_log SET claim_token = gen_random_uuid() WHERE task_id = $1`,
      ],
    ])("service_role cannot %s directly", async (_name, sql) => {
      const taskId = await newTask();
      await claim(taskId);
      expect(
        await errorCodeOf(queryAs(db, "service_role", sql, [taskId])),
      ).toBe("42501");
      expect((await logRow(taskId))?.state).toBe("claimed");
    });

    it("marks sent with the right token", async () => {
      const taskId = await newTask();
      const token = present(await claim(taskId));
      expect(await markSent(taskId, token)).toBe(true);
      expect(await logRow(taskId)).toEqual({
        state: "sent",
        attempts: 1,
        sent: true,
        has_message: true,
      });
    });

    it("refuses to mark sent with the wrong token", async () => {
      const taskId = await newTask();
      await claim(taskId);
      expect(await markSent(taskId, crypto.randomUUID())).toBe(false);
      expect((await logRow(taskId))?.state).toBe("claimed");
    });

    it("refuses to reclaim a fresh claim", async () => {
      const taskId = await newTask();
      const token = present(await claim(taskId));
      await age(taskId, "59 minutes");
      expect(await reclaim(taskId, token)).toBeNull();
      expect((await logRow(taskId))?.attempts).toBe(1);
    });

    it("reclaims a stale claim with a new token, and the old worker can no longer finish", async () => {
      const taskId = await newTask();
      const oldToken = present(await claim(taskId));
      await age(taskId, "61 minutes");

      const newToken = await reclaim(taskId, oldToken);

      expect(newToken).not.toBeNull();
      expect(newToken).not.toBe(oldToken);
      expect((await logRow(taskId))?.attempts).toBe(2);
      expect(await markSent(taskId, oldToken)).toBe(false);
      expect(await markSent(taskId, present(newToken))).toBe(true);
    });

    it("resets the clock, so a reclaimed claim is fresh again", async () => {
      const taskId = await newTask();
      const token = present(await claim(taskId));
      await age(taskId, "2 hours");
      const newToken = present(await reclaim(taskId, token));
      expect(await reclaim(taskId, newToken)).toBeNull();
    });

    it("lets only one of two runs reclaim with the same token", async () => {
      const taskId = await newTask();
      const token = present(await claim(taskId));
      await age(taskId, "2 hours");
      expect(await reclaim(taskId, token)).not.toBeNull();
      await age(taskId, "2 hours");
      expect(await reclaim(taskId, token)).toBeNull();
    });

    it("refuses to reclaim with the wrong token", async () => {
      const taskId = await newTask();
      await claim(taskId);
      await age(taskId, "2 hours");
      expect(await reclaim(taskId, crypto.randomUUID())).toBeNull();
    });

    it("refuses to reclaim a sent reminder", async () => {
      const taskId = await newTask();
      const token = present(await claim(taskId));
      await markSent(taskId, token);
      await age(taskId, "2 hours");
      expect(await reclaim(taskId, token)).toBeNull();
    });

    it("refuses to reclaim once the task is done", async () => {
      const taskId = await newTask();
      const token = present(await claim(taskId));
      await age(taskId, "2 hours");
      await queryAs(
        db,
        "service_role",
        `UPDATE public.tasks SET status = 'done', completed_at = now() WHERE id = $1`,
        [taskId],
      );
      expect(await reclaim(taskId, token)).toBeNull();
    });
  });
});
