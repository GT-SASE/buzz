import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FIXTURE_DUE_DATE as DUE,
  insertEvent,
  insertGuild,
  insertTask,
  type GuildFixture,
} from "./fixtures.ts";
import { MIGRATION_OWNER, createMigratedDb, queryAs } from "./harness.ts";

/** Each change must stop new claims and takeovers, with the task itself still open. */
const STOPPERS: [
  string,
  (db: PGlite, own: GuildFixture, eventId: string) => Promise<unknown>,
][] = [
  [
    "reminders turned off",
    (db, own) =>
      queryAs(
        db,
        "bot_app",
        `SELECT public.apply_config_change($1, 2, $1, false)`,
        [own.guildId],
      ),
  ],
  [
    "the channel removed",
    (db, own) =>
      queryAs(
        db,
        MIGRATION_OWNER,
        `UPDATE public.managed_channels SET status = 'removed' WHERE guild_id = $1`,
        [own.guildId],
      ),
  ],
  [
    "the channel unavailable",
    (db, own) =>
      queryAs(db, "bot_app", `SELECT public.mark_channel_unavailable($1, $2)`, [
        own.guildId,
        own.channelId,
      ]),
  ],
  [
    "the event closed",
    (db, _own, eventId) =>
      queryAs(
        db,
        "bot_app",
        `UPDATE public.events SET status = 'closed' WHERE id = $1`,
        [eventId],
      ),
  ],
  [
    "the event deleted with its task left live",
    (db, _own, eventId) =>
      queryAs(
        db,
        MIGRATION_OWNER,
        `UPDATE public.events SET deleted_at = now() WHERE id = $1`,
        [eventId],
      ),
  ],
];

describe("reminder claims check the task's parents", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  const setUp = async () => {
    const own = await insertGuild(db);
    const eventId = await insertEvent(db, own);
    const taskId = await insertTask(db, own, eventId);
    return { own, eventId, taskId };
  };

  const claim = async (taskId: string, kind = "due_day") => {
    const rows = await queryAs<{ token: string | null }>(
      db,
      "bot_app",
      `SELECT public.claim_reminder($1, $2, '${DUE}') AS token`,
      [taskId, kind],
    );
    return rows[0]?.token ?? null;
  };

  const reclaim = async (taskId: string, token: string) => {
    const rows = await queryAs<{ token: string | null }>(
      db,
      "bot_app",
      `SELECT public.reclaim_reminder($1, 'due_day', '${DUE}', $2) AS token`,
      [taskId, token],
    );
    return rows[0]?.token ?? null;
  };

  const age = (taskId: string) =>
    db.query(
      `UPDATE public.reminder_log SET claimed_at = now() - interval '2 hours' WHERE task_id = $1`,
      [taskId],
    );

  it("still claims and reclaims when nothing has stopped reminders", async () => {
    const { taskId } = await setUp();
    const token = await claim(taskId);
    expect(token).not.toBeNull();
    await age(taskId);
    expect(await reclaim(taskId, token ?? "")).not.toBeNull();
  });

  it.each(STOPPERS)("refuses a new claim after %s", async (_name, stop) => {
    const { own, eventId, taskId } = await setUp();
    await stop(db, own, eventId);
    expect(await claim(taskId)).toBeNull();
    const { rows } = await db.query(
      `SELECT 1 FROM public.reminder_log WHERE task_id = $1`,
      [taskId],
    );
    expect(rows).toEqual([]);
  });

  it.each(STOPPERS)("refuses a takeover after %s", async (_name, stop) => {
    const { own, eventId, taskId } = await setUp();
    const token = await claim(taskId);
    await age(taskId);
    await stop(db, own, eventId);
    expect(await reclaim(taskId, token ?? "")).toBeNull();
    const { rows } = await db.query<{ attempts: number; token: string }>(
      `SELECT attempts, claim_token AS token FROM public.reminder_log WHERE task_id = $1`,
      [taskId],
    );
    expect(rows).toEqual([{ attempts: 1, token }]);
  });

  it("claims again once reminders are turned back on", async () => {
    const { own, taskId } = await setUp();
    await queryAs(
      db,
      "bot_app",
      `SELECT public.apply_config_change($1, 2, $1, false)`,
      [own.guildId],
    );
    expect(await claim(taskId)).toBeNull();
    await queryAs(
      db,
      "bot_app",
      `SELECT public.apply_config_change($1, 3, $1, true)`,
      [own.guildId],
    );
    expect(await claim(taskId)).not.toBeNull();
  });

  it("is not stopped by another guild turning reminders off", async () => {
    const { taskId } = await setUp();
    const other = await insertGuild(db);
    await queryAs(
      db,
      "bot_app",
      `SELECT public.apply_config_change($1, 2, $1, false)`,
      [other.guildId],
    );
    expect(await claim(taskId)).not.toBeNull();
  });

  it("keeps both functions SECURITY DEFINER, with an empty search_path and one version each", async () => {
    const { rows } = await db.query(
      `SELECT proname, prosecdef, proconfig FROM pg_proc
       WHERE proname IN ('claim_reminder', 'reclaim_reminder') ORDER BY proname`,
    );
    expect(rows).toEqual(
      ["claim_reminder", "reclaim_reminder"].map((proname) => ({
        proname,
        prosecdef: true,
        proconfig: ['search_path=""'],
      })),
    );
  });
});
