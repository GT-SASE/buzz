/**
 * Rules the schema enforces whoever calls it: the bot's grants, the row history, the
 * guards on deleted and closed rows, the CHECKs, and the claims the bot's write code
 * makes. access-layer.test.ts covers the same database through src/db.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  expireInteractionClaims,
  claimInteraction,
} from "../../src/db/interaction-claims.ts";
import { todayInZone, type DateOnly } from "../../src/lib/dates.ts";
import {
  assignEventStep,
  claimEventReminder,
  closeStaleEventClaim,
  setEventPickupTime,
} from "../../src/db/event-steps.ts";
import {
  claimReminder,
  closeStaleClaim,
  markReminderSent,
  markReminderSkipped,
  reclaimReminder,
} from "../../src/db/reminders.ts";
import { saveSetupDraft } from "../../src/db/guild-config.ts";
import type { EventReminderKind } from "../../src/db/types.ts";
import { pgliteOrm } from "../support/sql-client.ts";
import { evaluate } from "../../src/db/internal.ts";
import { sql } from "drizzle-orm";
import { botClient, must } from "./bot-writes.ts";
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
  HOOK_TIMEOUT_MS,
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

/** The tables bot_app reads. */
const ALL_TABLES = [
  "config_audit",
  "event_reminder_log",
  "event_step_assignees",
  "event_steps",
  "events",
  "guild_config",
  "interaction_claims",
  "job_runs",
  "managed_channels",
  "reminder_log",
  "setup_drafts",
  "tasks",
].sort();
/** Written by the bot and never read back, so bot_app has no SELECT on it. */
const NO_READ_TABLES = ["row_versions"];
/** Read by the bot to count, with nothing seeded here. */
const COUNTED_TABLES = ["task_reassignments"];
/** The migration tool's record of applied migrations. */
const LEDGER_TABLES = ["drizzle_migrations"];
/** The only table the bot deletes from: claims are worth keeping for a day. */
const DELETABLE_TABLES = ["interaction_claims"];

const bot = () => botClient(db);

let db: PGlite;
let guild: GuildFixture;

beforeAll(async () => {
  db = await createMigratedDb();
  guild = await insertGuild(db);
}, HOOK_TIMEOUT_MS);

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
    must(
      await claimReminder(bot(), {
        taskId,
        kind: "due_day",
        dueDate: DUE as DateOnly,
      }),
    );
    must(
      await assignEventStep(bot(), {
        eventId,
        guildId: guild.guildId,
        kind: "budget_sheet",
        userId: fakeId(),
        actorId: fakeId(),
      }),
    );
    must(
      await claimEventReminder(bot(), {
        eventId,
        // A step reminder can be claimed only for today or yesterday in the guild's zone.
        kind: "daily_steps",
        reminderDate: todayInZone(new Date(), "America/New_York"),
      }),
    );
    const person = fakeId();
    must(
      await saveSetupDraft(bot(), {
        guildId: guild.guildId,
        actorId: person,
        roles: {
          officerRoleId: person,
          adminRoleId: person,
          eboardRoleId: person,
          eventsCommitteeRoleId: person,
          treasuryRoleId: person,
          marketingRoleId: person,
        },
      }),
    );
    must(await claimInteraction(bot(), { interactionId: fakeId() }));
    await insertFinishedJobRun(db, { status: "succeeded" });
  });

  it.each(ALL_TABLES)(
    "bot_app can read %s, and another role cannot read or write it",
    async (table) => {
      expect(
        (await asBot(`SELECT * FROM discord_bot.${table}`)).length,
      ).toBeGreaterThan(0);
      for (const sql of [
        `SELECT * FROM discord_bot.${table}`,
        `INSERT INTO discord_bot.${table} DEFAULT VALUES`,
        `DELETE FROM discord_bot.${table}`,
      ]) {
        await refused(OTHER_ROLE, sql);
      }
    },
  );

  // The columns a write may change are granted by name, so a column the code never
  // writes, such as a row's key, is refused even on a table the bot updates.
  it.each([
    ["config_audit", "guild_id"],
    ["event_reminder_log", "event_id"],
    ["event_reminder_log", "kind"],
    ["event_step_assignees", "user_id"],
    ["event_steps", "guild_id"],
    ["event_steps", "kind"],
    ["guild_config", "guild_id"],
    ["guild_config", "created_at"],
    ["job_runs", "job_name"],
    ["job_runs", "started_at"],
    ["job_runs", "heartbeat_at"],
    ["managed_channels", "guild_id"],
    ["managed_channels", "channel_id"],
    ["reminder_log", "task_id"],
    ["reminder_log", "due_date"],
    ["setup_drafts", "guild_id"],
    ["interaction_claims", "interaction_id"],
    ["task_reassignments", "actor_id"],
    ["row_versions", "old_row"],
  ])("bot_app cannot update %s.%s", async (table, col) => {
    await refused(BOT_APP, `UPDATE discord_bot.${table} SET ${col} = ${col}`);
  });

  it.each(["config_audit", "interaction_claims", "task_reassignments"])(
    "bot_app cannot update any column of %s",
    async (table) => {
      const { rows } = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'discord_bot' AND table_name = $1
           AND is_identity = 'NO'`,
        [table],
      );
      for (const { column_name: column } of rows) {
        await refused(
          BOT_APP,
          `UPDATE discord_bot.${table} SET ${column} = ${column}`,
        );
      }
    },
  );

  it.each(
    [
      ...ALL_TABLES,
      ...COUNTED_TABLES,
      ...NO_READ_TABLES,
      ...LEDGER_TABLES,
    ].filter((table) => !DELETABLE_TABLES.includes(table)),
  )("bot_app cannot DELETE from %s", async (table) => {
    await refused(BOT_APP, `DELETE FROM discord_bot.${table}`);
  });

  it.each([
    ...ALL_TABLES,
    ...COUNTED_TABLES,
    ...NO_READ_TABLES,
    ...LEDGER_TABLES,
  ])("bot_app cannot TRUNCATE %s", async (table) => {
    await refused(BOT_APP, `TRUNCATE discord_bot.${table}`);
  });

  it("bot_app may delete from the tables DELETABLE_TABLES names, and nothing else", async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.table_privileges
       WHERE table_schema = 'discord_bot' AND grantee = $1
         AND privilege_type IN ('DELETE', 'TRUNCATE')`,
      [BOT_APP],
    );
    expect(rows.map((row) => row.table_name)).toEqual(DELETABLE_TABLES);
  });

  it.each([...NO_READ_TABLES, ...LEDGER_TABLES])(
    "bot_app cannot read %s",
    async (table) => {
      await refused(BOT_APP, `SELECT * FROM discord_bot.${table}`);
    },
  );

  it.each([
    "ALTER TABLE discord_bot.tasks ADD COLUMN forged text",
    "ALTER TABLE discord_bot.tasks DISABLE TRIGGER ALL",
    "CREATE TABLE discord_bot.forged (id int)",
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
  it.each([BOT_APP, OTHER_ROLE])(
    "%s cannot read, change or remove the row history, and only the bot adds to it",
    async (role) => {
      const { rows } = await db.query(
        `SELECT
           has_table_privilege($1, 'discord_bot.row_versions', 'SELECT') AS table_select,
           has_table_privilege($1, 'discord_bot.row_versions', 'INSERT') AS table_insert,
           has_column_privilege($1, 'discord_bot.row_versions', 'old_row', 'SELECT') AS column_select`,
        [role],
      );
      expect(rows).toEqual([
        {
          table_select: false,
          table_insert: role === BOT_APP,
          column_select: false,
        },
      ]);
      for (const sql of [
        `SELECT * FROM discord_bot.row_versions`,
        `SELECT old_row FROM discord_bot.row_versions`,
        `UPDATE discord_bot.row_versions SET old_row = '{}'`,
        `DELETE FROM discord_bot.row_versions`,
        `TRUNCATE discord_bot.row_versions`,
        ...(role === BOT_APP
          ? []
          : [
              `INSERT INTO discord_bot.row_versions (source_table, operation, row_id, old_row) VALUES ('x', 'UPDATE', 'x', '{}')`,
            ]),
      ]) {
        await refused(role, sql);
      }
    },
  );
});

describe("schema constraints", () => {
  it("rejects an event on another guild's channel, and a task on another guild's event", async () => {
    const other = await insertGuild(db);
    expect(
      await errorCodeOf(
        asBot(
          `INSERT INTO discord_bot.events (guild_id, channel_id, name, event_date, created_by)
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
      asBot(`UPDATE discord_bot.tasks SET ${set} WHERE id = $1`, [taskId]);
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
      `INSERT INTO discord_bot.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
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
          `INSERT INTO discord_bot.reminder_log (task_id, kind, due_date) VALUES ($1, $2, $3)`,
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
          `UPDATE discord_bot.reminder_log SET ${set} WHERE task_id = $1 AND due_date = '${DUE}'`,
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
    must(
      await claimReminder(bot(), {
        taskId,
        kind: "one_day",
        dueDate: dueDate as DateOnly,
      }),
    );
  const reclaim = async (taskId: string, claimToken: string) =>
    must(
      await reclaimReminder(bot(), {
        taskId,
        kind: "one_day",
        dueDate: DUE as DateOnly,
        claimToken,
      }),
    );
  const mark = async (
    taskId: string,
    how: "sent" | "skipped",
    claimToken: string,
  ) => {
    const key = {
      taskId,
      kind: "one_day" as const,
      dueDate: DUE as DateOnly,
      claimToken,
    };
    return must(
      how === "sent"
        ? await markReminderSent(bot(), { ...key, messageId: fakeId() })
        : await markReminderSkipped(bot(), key),
    );
  };
  const age = (taskId: string, interval: string) =>
    db.query(
      `UPDATE discord_bot.reminder_log SET claimed_at = now() - $2::interval WHERE task_id = $1`,
      [taskId, interval],
    );
  const logRow = async (taskId: string) =>
    (
      await db.query<{ state: string; attempts: number }>(
        `SELECT state, attempts FROM discord_bot.reminder_log WHERE task_id = $1`,
        [taskId],
      )
    ).rows[0];

  it("claims the new due date after a move, and refuses the old one", async () => {
    const taskId = await newTask();
    const moved = "2030-03-01";
    await asOwner(`UPDATE discord_bot.tasks SET due_date = $2 WHERE id = $1`, [
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

describe("closing a stale claim", () => {
  const closeTask = async (taskId: string, claimToken: string) => {
    const closed = must(
      await closeStaleClaim(bot(), {
        taskId,
        kind: "one_day",
        dueDate: DUE as DateOnly,
        claimToken,
      }),
    );
    return closed.outcome === "closed";
  };
  const claimTask = async (taskId: string) =>
    present(
      must(
        await claimReminder(bot(), {
          taskId,
          kind: "one_day",
          dueDate: DUE as DateOnly,
        }),
      ),
    );
  const stateOf = async (taskId: string) =>
    (
      await db.query<{ state: string }>(
        `SELECT state FROM discord_bot.reminder_log WHERE task_id = $1`,
        [taskId],
      )
    ).rows[0]?.state;

  it("leaves a claim whose task can still be sent, and closes it once it cannot", async () => {
    const taskId = await newTask();
    const token = await claimTask(taskId);

    expect(await closeTask(taskId, token)).toBe(false);
    expect(await stateOf(taskId)).toBe("claimed");

    await asOwner(
      `UPDATE discord_bot.tasks SET status = 'done', completed_at = now() WHERE id = $1`,
      [taskId],
    );
    expect(await closeTask(taskId, crypto.randomUUID())).toBe(false);
    expect(await closeTask(taskId, token)).toBe(true);
    expect(await stateOf(taskId)).toBe("skipped");
    expect(await closeTask(taskId, token)).toBe(false);
  });

  const closeEvent = async (
    eventId: string,
    claimToken: string,
    before: string,
  ) =>
    must(
      await closeStaleEventClaim(bot(), {
        eventId,
        kind: "event_today",
        reminderDate: EVENT_DAY as DateOnly,
        claimToken,
        beforeDate: before as DateOnly,
      }),
    ) === "closed";
  const EVENT_DAY = "2030-01-15";

  it("leaves an event's claim while it is live and the guild has reminders on, and closes it otherwise", async () => {
    const eventId = await insertEvent(db, guild);
    await asOwner(
      `INSERT INTO discord_bot.event_reminder_log (event_id, kind, reminder_date)
       VALUES ($1, 'event_today', $2)`,
      [eventId, EVENT_DAY],
    );
    const { rows } = await db.query<{ claim_token: string }>(
      `SELECT claim_token FROM discord_bot.event_reminder_log WHERE event_id = $1`,
      [eventId],
    );
    const token = present(rows[0]).claim_token;
    const stateOf = async () =>
      (
        await db.query<{ state: string }>(
          `SELECT state FROM discord_bot.event_reminder_log WHERE event_id = $1`,
          [eventId],
        )
      ).rows[0]?.state;

    expect(await closeEvent(eventId, token, "2030-01-01")).toBe(false);

    const setReminders = (on: boolean) =>
      asOwner(
        `UPDATE discord_bot.guild_config SET reminders_enabled = $2 WHERE guild_id = $1`,
        [guild.guildId, on],
      );
    await setReminders(false);
    expect(await closeEvent(eventId, token, "2031-01-01")).toBe(false);
    await setReminders(true);
    expect(await closeEvent(eventId, crypto.randomUUID(), "2031-01-01")).toBe(
      false,
    );
    expect(await stateOf()).toBe("claimed");
    expect(await closeEvent(eventId, token, "2031-01-01")).toBe(true);
    expect(await stateOf()).toBe("skipped");
  });

  it("leaves an Engage picture late claim whose own day is not past, though its event is, and closes the rest", async () => {
    const eventId = await insertEvent(db, guild);
    // The event was a week before the ping's day, 2030-01-15, so the ping is today and
    // 2030-01-14 is the earliest a guild's today can be.
    await asOwner(
      `UPDATE discord_bot.events SET event_date = '2030-01-08' WHERE id = $1`,
      [eventId],
    );
    const claimFor = async (kind: string, day: string) => {
      await asOwner(
        `INSERT INTO discord_bot.event_reminder_log (event_id, kind, reminder_date)
         VALUES ($1, $2::discord_bot.event_reminder_kind, $3)`,
        [eventId, kind, day],
      );
      const { rows } = await db.query<{ claim_token: string }>(
        `SELECT claim_token FROM discord_bot.event_reminder_log
         WHERE event_id = $1 AND kind = $2::discord_bot.event_reminder_kind AND reminder_date = $3`,
        [eventId, kind, day],
      );
      return present(rows[0]).claim_token;
    };
    const closeOf = async (kind: string, day: string, claimToken: string) =>
      must(
        await closeStaleEventClaim(bot(), {
          eventId,
          kind: kind as EventReminderKind,
          reminderDate: day as DateOnly,
          claimToken,
          beforeDate: "2030-01-14" as DateOnly,
        }),
      ) === "closed";

    const late = await claimFor("engage_picture_late", "2030-01-15");
    const lateGone = await claimFor("engage_picture_late", "2030-01-12");
    const today = await claimFor("event_today", "2030-01-08");

    expect(await closeOf("engage_picture_late", "2030-01-15", late)).toBe(
      false,
    );
    // A day already past in every guild, and a kind that stops with the event.
    expect(await closeOf("engage_picture_late", "2030-01-12", lateGone)).toBe(
      true,
    );
    expect(await closeOf("event_today", "2030-01-08", today)).toBe(true);
    expect(
      (
        await db.query<{ kind: string; state: string }>(
          `SELECT kind, state FROM discord_bot.event_reminder_log WHERE event_id = $1
           ORDER BY kind, reminder_date`,
          [eventId],
        )
      ).rows,
    ).toEqual([
      { kind: "engage_picture_late", state: "skipped" },
      { kind: "engage_picture_late", state: "claimed" },
      { kind: "event_today", state: "skipped" },
    ]);
  });
});

describe("event reminder claims", () => {
  const claim = async (eventId: string, kind: string, date: string) =>
    must(
      await claimEventReminder(bot(), {
        eventId,
        kind: kind as EventReminderKind,
        reminderDate: date as DateOnly,
      }),
    );

  it("sets up Food pickup and its reminders without waiting for the budget", async () => {
    const eventId = await insertEvent(db, guild);
    const actor = fakeId();
    must(
      await assignEventStep(bot(), {
        eventId,
        guildId: guild.guildId,
        kind: "food_pickup",
        userId: actor,
        actorId: actor,
      }),
    );
    expect(
      must(
        await setEventPickupTime(bot(), {
          eventId,
          guildId: guild.guildId,
          pickupTime: "17:30",
          actorId: actor,
        }),
      ),
    ).toBe(true);

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

describe("claimInteraction", () => {
  const claim = async (interactionId: string) =>
    must(await claimInteraction(bot(), { interactionId }));

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
    await refused(
      OTHER_ROLE,
      `INSERT INTO discord_bot.interaction_claims (interaction_id) VALUES ('${fakeId()}')`,
    );
    await refused(OTHER_ROLE, "DELETE FROM discord_bot.interaction_claims");
  });

  it("lets bot_app delete a claim only once it is a day old, whatever it asks for", async () => {
    const aged = async (hours: number) => {
      const id = fakeId();
      await db.query(
        `INSERT INTO discord_bot.interaction_claims (interaction_id, claimed_at)
         VALUES ($1, now() - make_interval(hours => $2))`,
        [id, hours],
      );
      return id;
    };
    const old = await aged(25);
    const recent = await aged(1);
    await asBot(
      "DELETE FROM discord_bot.interaction_claims WHERE interaction_id = ANY($1)",
      [[old, recent]],
    );
    await asBot("DELETE FROM discord_bot.interaction_claims");
    const { rows } = await db.query<{ interaction_id: string }>(
      "SELECT interaction_id FROM discord_bot.interaction_claims WHERE interaction_id = ANY($1)",
      [[old, recent]],
    );
    expect(rows.map((row) => row.interaction_id)).toEqual([recent]);
  });

  it("expires claims older than a day and keeps the rest", async () => {
    const claimAged = async (hours: number) => {
      const id = fakeId();
      await db.query(
        `INSERT INTO discord_bot.interaction_claims (interaction_id, claimed_at)
         VALUES ($1, now() - make_interval(hours => $2))`,
        [id, hours],
      );
      return id;
    };
    const old = await claimAged(25);
    const recent = await claimAged(23);

    expect(must(await expireInteractionClaims(bot()))).toBeGreaterThanOrEqual(
      1,
    );

    const { rows } = await db.query<{ interaction_id: string }>(
      "SELECT interaction_id FROM discord_bot.interaction_claims WHERE interaction_id = ANY($1)",
      [[old, recent]],
    );
    expect(rows.map((row) => row.interaction_id)).toEqual([recent]);
  });
});

describe("queryAs", () => {
  it("keeps its role while the bot's runner shares the connection", async () => {
    const [asOther, asBot] = await Promise.all([
      queryAs<{ who: string }>(db, OTHER_ROLE, "SELECT current_user AS who"),
      evaluate(pgliteOrm(db), sql<string>`current_user`),
    ]);

    expect(asOther).toEqual([{ who: OTHER_ROLE }]);
    expect(asBot).toBe(BOT_APP);
  });
});
