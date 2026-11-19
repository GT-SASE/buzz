/**
 * Rules the schema enforces whoever calls it: the bot's grants, the row history, the
 * guards on deleted and closed rows, the CHECKs, and the claim functions' SQL.
 * access-layer.test.ts covers the same database through src/db.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { todayInZone } from "../../src/lib/dates.ts";
import { insertFinishedJobRun } from "../support/job-runs-fixture.ts";
import {
  FIXTURE_DUE_DATE as DUE,
  insertEvent,
  insertGuild,
  insertTask,
  type GuildFixture,
} from "./fixtures.ts";
import {
  BOT_APP,
  INSUFFICIENT_PRIVILEGE,
  MIGRATION_OWNER,
  OTHER_ROLE,
  createMigratedDb,
  errorCodeOf,
  fakeId,
  present,
  queryAs,
} from "./harness.ts";

const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const PARENT_UNAVAILABLE = "CF410";

const READ_ONLY_TABLES = [
  "config_audit",
  "event_reminder_log",
  "event_step_assignees",
  "event_steps",
  "guild_config",
  "managed_channels",
  "reminder_log",
  "setup_drafts",
];
const ALL_TABLES = [...READ_ONLY_TABLES, "events", "job_runs", "tasks"].sort();
/** Reached only through functions, so bot_app has no grant on it. */
const NO_GRANT_TABLES = ["interaction_claims", "task_reassignments"];
/** dbmate's record of applied migrations. */
const LEDGER_TABLES = ["schema_migrations"];

let db: PGlite;
let guild: GuildFixture;

beforeAll(async () => {
  db = await createMigratedDb();
  guild = await insertGuild(db);
});

afterAll(async () => {
  await db.close();
});

const asBot = <Row = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
) => queryAs<Row>(db, BOT_APP, sql, params);
const asOwner = (sql: string, params: unknown[] = []) =>
  queryAs(db, MIGRATION_OWNER, sql, params);
const refused = async (role: string, sql: string, params?: unknown[]) => {
  expect(await errorCodeOf(queryAs(db, role, sql, params))).toBe(
    INSUFFICIENT_PRIVILEGE,
  );
};
const newTask = async () => insertTask(db, guild, await insertEvent(db, guild));

describe("grants", () => {
  beforeAll(async () => {
    // One row in every table, so a read that returns nothing proves nothing.
    const eventId = await insertEvent(db, guild);
    const taskId = await insertTask(db, guild, eventId);
    await asBot(`SELECT public.claim_reminder($1, 'due_day', '${DUE}')`, [
      taskId,
    ]);
    await asBot(
      `SELECT public.assign_event_step($1, $2, 'budget_sheet', $3, $3)`,
      [eventId, guild.guildId, fakeId()],
    );
    await asBot(
      // A step reminder can be claimed only for today or yesterday in the guild's zone.
      `SELECT public.claim_event_reminder($1, 'daily_steps', (now() AT TIME ZONE 'America/New_York')::date)`,
      [eventId],
    );
    await asBot(
      `SELECT public.save_setup_draft($1, $2, $3, $3, $3, $3, $3, $3, 'abcdefgh12345678')`,
      [guild.guildId, fakeId(), fakeId()],
    );
    await insertFinishedJobRun(db, { status: "succeeded" });
  });

  it.each(ALL_TABLES)(
    "bot_app can read %s, and another role cannot read or write it",
    async (table) => {
      expect(
        (await asBot(`SELECT * FROM public.${table}`)).length,
      ).toBeGreaterThan(0);
      for (const sql of [
        `SELECT * FROM public.${table}`,
        `INSERT INTO public.${table} DEFAULT VALUES`,
        `DELETE FROM public.${table}`,
      ]) {
        await refused(OTHER_ROLE, sql);
      }
    },
  );

  it.each([
    ["config_audit", "guild_id"],
    ["event_reminder_log", "state"],
    ["event_step_assignees", "removed_at"],
    ["event_steps", "status"],
    ["guild_config", "guild_id"],
    ["job_runs", "status"],
    ["managed_channels", "guild_id"],
    ["reminder_log", "task_id"],
    ["setup_drafts", "fingerprint"],
  ])("bot_app cannot insert into or update %s directly", async (table, col) => {
    await refused(BOT_APP, `INSERT INTO public.${table} DEFAULT VALUES`);
    await refused(BOT_APP, `UPDATE public.${table} SET ${col} = ${col}`);
  });

  it.each([...ALL_TABLES, ...NO_GRANT_TABLES, ...LEDGER_TABLES])(
    "bot_app cannot DELETE from or TRUNCATE %s",
    async (table) => {
      await refused(BOT_APP, `DELETE FROM public.${table}`);
      await refused(BOT_APP, `TRUNCATE public.${table}`);
    },
  );

  it.each([...NO_GRANT_TABLES, ...LEDGER_TABLES])(
    "bot_app cannot read %s",
    async (table) => {
      await refused(BOT_APP, `SELECT * FROM public.${table}`);
    },
  );

  it.each([
    "ALTER TABLE public.tasks ADD COLUMN forged text",
    "ALTER TABLE public.tasks DISABLE TRIGGER ALL",
    "SELECT public.require_open_parent()",
    "ALTER FUNCTION public.claim_interaction(text) SECURITY INVOKER",
    "CREATE TABLE public.forged (id int)",
    "ALTER ROLE bot_app CREATEROLE",
  ])("bot_app cannot run %s", async (sql) => {
    await refused(BOT_APP, sql);
  });

  it("bot_app logs in with no other attribute, password, role or object, and a timeout", async () => {
    const { rows } = await db.query(
      `SELECT rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
              rolreplication, rolbypassrls, rolpassword IS NULL AS no_password,
              NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = a.oid) AS no_roles,
              NOT EXISTS (SELECT 1 FROM pg_class WHERE relowner = a.oid)
                AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proowner = a.oid)
                AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = a.oid) AS owns_nothing,
              (SELECT array_agg(s ORDER BY s) FROM pg_db_role_setting,
                 unnest(setconfig) AS s WHERE setrole = a.oid) AS settings
       FROM pg_authid a WHERE rolname = $1`,
      [BOT_APP],
    );
    expect(rows).toEqual([
      {
        rolcanlogin: true,
        rolsuper: false,
        rolinherit: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
        no_password: true,
        no_roles: true,
        owns_nothing: true,
        settings: [
          "TimeZone=UTC",
          "idle_in_transaction_session_timeout=15s",
          "statement_timeout=10s",
        ],
      },
    ]);
  });
});

describe("row history", () => {
  const versionsOf = async (rowId: string) => {
    const { rows } = await db.query<{
      source_table: string;
      operation: string;
      old_row: Record<string, unknown>;
    }>(
      `SELECT source_table, operation, old_row FROM history.row_versions WHERE row_id = $1 ORDER BY id`,
      [rowId],
    );
    return rows;
  };

  it("keeps the old row of each update and soft delete, in order, and not the insert", async () => {
    const eventId = await insertEvent(db, guild);
    await asBot(`UPDATE public.events SET name = 'Renamed' WHERE id = $1`, [
      eventId,
    ]);
    expect(await versionsOf(eventId)).toMatchObject([
      {
        source_table: "events",
        operation: "UPDATE",
        old_row: { name: "General meeting" },
      },
    ]);

    const taskId = await newTask();
    await asOwner(
      `UPDATE public.tasks SET description = 'Second' WHERE id = $1`,
      [taskId],
    );
    await asBot(`UPDATE public.tasks SET deleted_at = now() WHERE id = $1`, [
      taskId,
    ]);
    expect(
      (await versionsOf(taskId)).map(({ old_row }) => [
        old_row.description,
        old_row.deleted_at,
      ]),
    ).toEqual([
      ["Book the room", null],
      ["Second", null],
    ]);
  });

  it.each([BOT_APP, OTHER_ROLE])(
    "%s has no privilege on the history schema and cannot touch it",
    async (role) => {
      const { rows } = await db.query(
        `SELECT
           has_schema_privilege($1, 'history', 'USAGE') AS schema_usage,
           has_table_privilege($1, 'history.row_versions', 'SELECT') AS table_select,
           has_function_privilege($1, 'history.record_row_version()', 'EXECUTE') AS fn_execute`,
        [role],
      );
      expect(rows).toEqual([
        { schema_usage: false, table_select: false, fn_execute: false },
      ]);
      for (const sql of [
        `SELECT * FROM history.row_versions`,
        `INSERT INTO history.row_versions (source_table, row_id, old_row) VALUES ('x', 'x', '{}')`,
        `DELETE FROM history.row_versions`,
        `TRUNCATE history.row_versions`,
        `DROP TRIGGER tasks_record_update ON public.tasks`,
      ]) {
        await refused(role, sql);
      }
    },
  );
});

describe("deleted and closed rows", () => {
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
      const taskId = await newTask();
      const sql = `UPDATE public.tasks SET deleted_at = ${value} WHERE id = $1`;
      await asBot("UPDATE public.tasks SET deleted_at = now() WHERE id = $1", [
        taskId,
      ]);
      await refused(BOT_APP, sql, [taskId]);
      await asOwner(sql, [taskId]);
    },
  );

  it("a deleted event cannot be undeleted by the bot", async () => {
    const eventId = await insertEvent(db, guild);
    await asBot(`SELECT public.soft_delete_event($1, $2)`, [
      eventId,
      guild.guildId,
    ]);
    await refused(
      BOT_APP,
      "UPDATE public.events SET deleted_at = NULL WHERE id = $1",
      [eventId],
    );
  });

  it("a closed event cannot be reopened by the bot, only by the owner", async () => {
    const eventId = await insertEvent(db, guild);
    const reopen = "UPDATE public.events SET status = 'active' WHERE id = $1";
    await asBot("UPDATE public.events SET status = 'closed' WHERE id = $1", [
      eventId,
    ]);
    await refused(BOT_APP, reopen, [eventId]);

    // Other columns, and a repeated close, are still allowed.
    await asBot(
      "UPDATE public.events SET status = 'closed', name = 'Renamed' WHERE id = $1",
      [eventId],
    );
    await asOwner(reopen, [eventId]);
    expect(await column("events", "status", eventId)).toBe("active");
  });

  it("lets a new event adopt a deleted event's thread, and then refuses the undelete", async () => {
    const threadId = fakeId();
    const link = (eventId: string) =>
      asBot(
        `UPDATE public.events SET thread_id = $2, thread_status = 'active' WHERE id = $1`,
        [eventId, threadId],
      );
    const oldEvent = await insertEvent(db, guild);
    await link(oldEvent);
    await asBot(`SELECT public.soft_delete_event($1, $2)`, [
      oldEvent,
      guild.guildId,
    ]);
    expect(
      await errorCodeOf(link(await insertEvent(db, guild))),
    ).toBeUndefined();
    expect(
      await errorCodeOf(
        asOwner(`UPDATE public.events SET deleted_at = NULL WHERE id = $1`, [
          oldEvent,
        ]),
      ),
    ).toBe(UNIQUE_VIOLATION);
  });

  it.each([
    ["deleted", `SELECT public.soft_delete_event($1, $2)`],
    ["closed", `UPDATE public.events SET status = 'closed' WHERE id = $1`],
  ])("rejects a new task on a %s event", async (_name, sql) => {
    const eventId = await insertEvent(db, guild);
    await asBot(sql, sql.includes("$2") ? [eventId, guild.guildId] : [eventId]);
    expect(await errorCodeOf(insertTask(db, guild, eventId))).toBe(
      PARENT_UNAVAILABLE,
    );
  });

  it("rejects an event on a removed channel but allows an unavailable one", async () => {
    const eventOn = async (status: string) => {
      const channelId = fakeId();
      await asOwner(
        `INSERT INTO public.managed_channels (guild_id, channel_id, status) VALUES ($1, $2, $3)`,
        [guild.guildId, channelId, status],
      );
      return errorCodeOf(
        asBot(
          `INSERT INTO public.events (guild_id, channel_id, name, event_date, created_by)
           VALUES ($1, $2, 'Social', '2030-02-01', $3)`,
          [guild.guildId, channelId, fakeId()],
        ),
      );
    };
    expect(await eventOn("removed")).toBe(PARENT_UNAVAILABLE);
    expect(await eventOn("unavailable")).toBeUndefined();
  });

  it("refuses a step's hand-off on a closed event", async () => {
    const eventId = await insertEvent(db, guild);
    await asBot(
      "SELECT public.complete_event_step($1, $2, 'budget_sheet', $3)",
      [eventId, guild.guildId, fakeId()],
    );
    await asBot("UPDATE public.events SET status = 'closed' WHERE id = $1", [
      eventId,
    ]);
    expect(
      await errorCodeOf(
        asBot("SELECT public.claim_step_handoff($1, $2, 'budget_sheet')", [
          eventId,
          guild.guildId,
        ]),
      ),
    ).toBe(PARENT_UNAVAILABLE);
  });

  it("counts a task edit against the officer's limit only when the person changes", async () => {
    const taskId = await newTask();
    const actor = fakeId();
    const edit = async (assignee?: string) => {
      const { rows } = await db.query<{ assignee_id: string; v: string }>(
        "SELECT assignee_id, updated_at::text AS v FROM public.tasks WHERE id = $1",
        [taskId],
      );
      await asBot(
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
});

describe("schema constraints", () => {
  it("rejects an event on another guild's channel, and a task on another guild's event", async () => {
    const other = await insertGuild(db);
    expect(
      await errorCodeOf(
        asBot(
          `INSERT INTO public.events (guild_id, channel_id, name, event_date, created_by)
           VALUES ($1, $2, 'Social', '2030-02-01', $3)`,
          [guild.guildId, other.channelId, fakeId()],
        ),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
    expect(
      await errorCodeOf(insertTask(db, guild, await insertEvent(db, other))),
    ).toBe(FOREIGN_KEY_VIOLATION);
  });

  it("keeps completed_at in step with task status", async () => {
    const taskId = await newTask();
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

  it.each([
    ["infinity", CHECK_VIOLATION],
    ["0044-03-15 BC", CHECK_VIOLATION],
    ["1999-12-31", CHECK_VIOLATION],
    ["10000-01-01", CHECK_VIOLATION],
    ["2000-01-01", undefined],
    ["9999-12-31", undefined],
  ])("a task's due date of %s gives %p", async (dueDate, code) => {
    const insert = asBot(
      `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
       VALUES ($1, $2, $3, 'Dated', $4::date, $3)`,
      [await insertEvent(db, guild), guild.guildId, fakeId(), dueDate],
    );
    expect(await errorCodeOf(insert)).toBe(code);
  });

  it("keeps one reminder_log row per task, kind and due date, with sent_at before message_id", async () => {
    const taskId = await newTask();
    const insertLog = (kind: string, dueDate = DUE) =>
      errorCodeOf(
        asOwner(
          `INSERT INTO public.reminder_log (task_id, kind, due_date) VALUES ($1, $2, $3)`,
          [taskId, kind, dueDate],
        ),
      );
    expect(await insertLog("one_day")).toBeUndefined();
    expect(await insertLog("one_day")).toBe(UNIQUE_VIOLATION);
    expect(await insertLog("one_day", "2030-02-02")).toBeUndefined();
    expect(await insertLog("one_day", "1999-12-31")).toBe(CHECK_VIOLATION);

    const update = (set: string, params: unknown[] = []) =>
      errorCodeOf(
        asOwner(
          `UPDATE public.reminder_log SET ${set} WHERE task_id = $1 AND due_date = '${DUE}'`,
          [taskId, ...params],
        ),
      );
    expect(await update(`state = 'sent'`)).toBe(CHECK_VIOLATION);
    expect(await update(`message_id = $2`, [fakeId()])).toBe(CHECK_VIOLATION);
    expect(
      await update(`state = 'sent', sent_at = now(), message_id = $2`, [
        fakeId(),
      ]),
    ).toBeUndefined();
  });
});

describe("task reminder claims", () => {
  const claim = async (taskId: string, dueDate = DUE) =>
    (
      await asBot<{ token: string | null }>(
        `SELECT public.claim_reminder($1, 'one_day', $2) AS token`,
        [taskId, dueDate],
      )
    )[0]?.token ?? null;
  const reclaim = async (taskId: string, token: string) =>
    (
      await asBot<{ token: string | null }>(
        `SELECT public.reclaim_reminder($1, 'one_day', '${DUE}', $2, 120) AS token`,
        [taskId, token],
      )
    )[0]?.token ?? null;
  const mark = async (taskId: string, how: "sent" | "skipped", token: string) =>
    (
      await asBot<{ marked: boolean }>(
        how === "sent"
          ? `SELECT public.mark_reminder_sent($1, 'one_day', '${DUE}', $2, $3) AS marked`
          : `SELECT public.mark_reminder_skipped($1, 'one_day', '${DUE}', $2) AS marked`,
        how === "sent" ? [taskId, token, fakeId()] : [taskId, token],
      )
    )[0]?.marked;
  const age = (taskId: string, interval: string) =>
    db.query(
      `UPDATE public.reminder_log SET claimed_at = now() - $2::interval WHERE task_id = $1`,
      [taskId, interval],
    );
  const logRow = async (taskId: string) =>
    (
      await db.query<{ state: string; attempts: number }>(
        `SELECT state, attempts FROM public.reminder_log WHERE task_id = $1`,
        [taskId],
      )
    ).rows[0];

  it("claims the new due date after a move, and refuses the old one", async () => {
    const taskId = await newTask();
    const moved = "2030-03-01";
    await asOwner(`UPDATE public.tasks SET due_date = $2 WHERE id = $1`, [
      taskId,
      moved,
    ]);
    expect(await claim(taskId, DUE)).toBeNull();
    expect(await claim(taskId, moved)).not.toBeNull();
  });

  it("marks sent or skipped only with the right token, and both are final", async () => {
    const sentTask = await newTask();
    const sentToken = present(await claim(sentTask));
    expect(await mark(sentTask, "sent", crypto.randomUUID())).toBe(false);
    expect(await mark(sentTask, "sent", sentToken)).toBe(true);
    expect(await mark(sentTask, "skipped", sentToken)).toBe(false);
    expect((await logRow(sentTask))?.state).toBe("sent");

    const skippedTask = await newTask();
    const skipToken = present(await claim(skippedTask));
    expect(await mark(skippedTask, "skipped", skipToken)).toBe(true);
    expect(await claim(skippedTask)).toBeNull();
    expect(await mark(skippedTask, "sent", skipToken)).toBe(false);
    await age(skippedTask, "2 hours");
    expect(await reclaim(skippedTask, skipToken)).toBeNull();
    expect((await logRow(skippedTask))?.state).toBe("skipped");
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

    expect(await mark(taskId, "sent", oldToken)).toBe(false);
    expect(await mark(taskId, "sent", newToken)).toBe(true);
  });
});

describe("event reminder claims", () => {
  const claim = async (eventId: string, kind: string, date: string) =>
    (
      await asBot<{ token: string | null }>(
        "SELECT public.claim_event_reminder($1, $2::public.event_reminder_kind, $3) AS token",
        [eventId, kind, date],
      )
    )[0]?.token ?? null;

  it("sets up Food pickup and its reminders without waiting for the budget", async () => {
    const eventId = await insertEvent(db, guild);
    const actor = fakeId();
    await asBot(
      "SELECT public.assign_event_step($1, $2, 'food_pickup', $3, $3)",
      [eventId, guild.guildId, actor],
    );
    expect(
      await asBot(
        "SELECT public.set_event_pickup_time($1, $2, '17:30', $3) AS done",
        [eventId, guild.guildId, actor],
      ),
    ).toEqual([{ done: true }]);

    // The fixture's event is on 2030-01-15, and a reminder is claimed for today.
    const today = todayInZone(new Date(), "America/New_York");
    expect(await claim(eventId, "pickup_before", today)).not.toBeNull();
    expect(await claim(eventId, "pickup_day", today)).not.toBeNull();
  });

  it("claims a day's step reminder only for today or yesterday, never a day to come", async () => {
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

describe("claim_interaction", () => {
  const claim = async (interactionId: string) =>
    (
      await asBot<{ claimed: boolean }>(
        "SELECT public.claim_interaction($1) AS claimed",
        [interactionId],
      )
    )[0]?.claimed;

  it("is true for the first claim of each interaction and false after, even on replay", async () => {
    const interactionId = fakeId();
    expect(await claim(interactionId)).toBe(true);
    expect(await claim(interactionId)).toBe(false);
    expect(await claim(fakeId())).toBe(true);
  });

  it("rolls back with the transaction, so a failed change can be retried", async () => {
    const interactionId = fakeId();
    await db.exec("BEGIN");
    expect(await claim(interactionId)).toBe(true);
    await db.exec("ROLLBACK");
    expect(await claim(interactionId)).toBe(true);
  });

  it("is closed to other roles, as is expiry", async () => {
    await refused(OTHER_ROLE, `SELECT public.claim_interaction('${fakeId()}')`);
    await refused(OTHER_ROLE, "SELECT public.expire_interaction_claims()");
  });

  it("expires claims older than a day and keeps the rest", async () => {
    const claimAged = async (hours: number) => {
      const id = fakeId();
      await db.query(
        `INSERT INTO public.interaction_claims (interaction_id, claimed_at)
         VALUES ($1, now() - make_interval(hours => $2))`,
        [id, hours],
      );
      return id;
    };
    const old = await claimAged(25);
    const recent = await claimAged(23);

    await asBot("SELECT public.expire_interaction_claims()");

    const { rows } = await db.query<{ interaction_id: string }>(
      "SELECT interaction_id FROM public.interaction_claims WHERE interaction_id = ANY($1)",
      [[old, recent]],
    );
    expect(rows.map((row) => row.interaction_id)).toEqual([recent]);
  });
});
