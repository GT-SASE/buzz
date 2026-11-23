/**
 * A migrated database for one test, seeded with the rows a handler test starts from.
 * Each one is a copy of the same migrated template, so tests never share rows, and it
 * is closed when the test finishes. The bot's statements run as bot_app.
 */

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, onTestFinished } from "bun:test";
import { createDbClient, type DbClient } from "../../src/db/client.ts";
import {
  GUILD_ID,
  type ChangeRow,
  type ChannelRow,
  type ConfigRow,
  type DraftRow,
} from "../support/interactions.ts";
import { names, pgliteSql, serverError } from "../support/sql-client.ts";
import { createMigratedDb, fakeId, HOOK_TIMEOUT_MS } from "./harness.ts";

export interface Seed {
  config?: ConfigRow | null;
  drafts?: DraftRow[];
  channels?: ChannelRow[];
  /** Rows of the config audit trail, for this guild. */
  changes?: ChangeRow[];
  /** Open tasks to put in each channel, in one live event there. */
  openTasks?: Map<string, number>;
  /** Event rows, as the events table holds them. */
  events?: readonly object[];
}

export interface HandlerDb {
  readonly db: DbClient;
  readonly pg: PGlite;
  /** Fails each statement that names this table or function, with this SQLSTATE. */
  readonly fail: (name: string, code?: string) => void;
  /** How many statements the bot has sent. */
  readonly sent: () => number;
  readonly config: () => Promise<ConfigRow | null>;
  readonly setConfig: (row: ConfigRow | null) => Promise<void>;
  readonly drafts: () => Promise<DraftRow[]>;
  readonly channels: () => Promise<ChannelRow[]>;
  readonly changes: () => Promise<{ actor_id: string; action: string }[]>;
  /** How many interactions have been claimed. */
  readonly claims: () => Promise<number>;
}

let template: Promise<File | Blob> | undefined;

function migratedTemplate(): Promise<File | Blob> {
  template ??= createMigratedDb().then(async (db) => {
    const dump = await db.dumpDataDir("none");
    await db.close();
    return dump;
  });
  return template;
}

// Every file that imports this builds the template before its first test, in a
// hook with room. Left to the first handlerDb call, the boot and every
// migration counted against that one test's 30 seconds and timed it out on a
// busy machine.
beforeAll(migratedTemplate, HOOK_TIMEOUT_MS);

async function migratedCopy(): Promise<PGlite> {
  const db = new PGlite({ loadDataDir: await migratedTemplate() });
  await db.waitReady;
  return db;
}

/** Inserts a row as the superuser, with no triggers, so a test can start anywhere. */
async function insertRow(
  db: PGlite,
  table: string,
  row: object,
): Promise<void> {
  const columns = Object.keys(row);
  const values = Object.values(row).map((value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? JSON.stringify(value)
      : value,
  );
  await db.query(
    `INSERT INTO discord_bot.${table} (${columns.join(", ")}) OVERRIDING SYSTEM VALUE
     VALUES (${columns.map((_, index) => `$${String(index + 1)}`).join(", ")})`,
    values,
  );
}

async function seed(db: PGlite, fields: Seed): Promise<void> {
  await db.exec("SET session_replication_role = replica");
  try {
    if (fields.config) {
      await insertRow(db, "guild_config", { ...fields.config });
    }
    for (const draft of fields.drafts ?? []) {
      await insertRow(db, "setup_drafts", { ...draft });
    }
    for (const channel of fields.channels ?? []) {
      await insertRow(db, "managed_channels", { ...channel });
    }
    for (const change of fields.changes ?? []) {
      await insertRow(db, "config_audit", { guild_id: GUILD_ID, ...change });
    }
    for (const event of fields.events ?? []) {
      await insertRow(db, "events", event);
      // The trigger that adds an event's steps is off while seeding.
      await db.query(
        `INSERT INTO discord_bot.event_steps (event_id, guild_id, kind)
         SELECT $1, $2, kind
         FROM unnest(enum_range(NULL::discord_bot.event_step_kind)) AS kind`,
        [
          (event as { id: string }).id,
          (event as { guild_id: string }).guild_id,
        ],
      );
    }
    for (const [channelId, count] of fields.openTasks ?? []) {
      const eventId = crypto.randomUUID();
      await insertRow(db, "events", {
        id: eventId,
        guild_id: GUILD_ID,
        channel_id: channelId,
        name: "General meeting",
        event_date: "2099-01-15",
        created_by: fakeId(),
      });
      await db.query(
        `INSERT INTO discord_bot.tasks
           (event_id, guild_id, assignee_id, description, due_date, created_by)
         SELECT $1, $2, $3, 'Book the room', '2099-01-10', $3
         FROM generate_series(1, $4)`,
        [eventId, GUILD_ID, fakeId(), count],
      );
    }
  } finally {
    await db.exec("SET session_replication_role = DEFAULT");
  }
}

/** A database for this test, holding these rows. Call it inside a test. */
export async function handlerDb(fields: Seed = {}): Promise<HandlerDb> {
  const pg = await migratedCopy();
  onTestFinished(() => pg.close());
  await seed(pg, fields);

  const failing: { name: string; code: string }[] = [];
  let sent = 0;
  const db = createDbClient(
    pgliteSql(pg, (call) => {
      sent += 1;
      const failure = failing.find(({ name }) => names(call, name));
      return failure === undefined ? undefined : serverError(failure.code);
    }),
  );

  const rows = async <T>(text: string): Promise<T[]> =>
    (await pg.query<T>(text, [GUILD_ID])).rows;

  return {
    db,
    pg,
    fail(name, code = "XX000") {
      failing.push({ name, code });
    },
    sent: () => sent,
    async config() {
      const [row] = await rows<ConfigRow>(
        `SELECT guild_id, officer_role_id, admin_role_id, eboard_role_id,
                events_committee_role_id, treasury_role_id, marketing_role_id,
                timezone, reminders_enabled, version
         FROM discord_bot.guild_config WHERE guild_id = $1`,
      );
      return row ?? null;
    },
    async setConfig(row) {
      await pg.exec("SET session_replication_role = replica");
      await pg.query(
        "DELETE FROM discord_bot.guild_config WHERE guild_id = $1",
        [GUILD_ID],
      );
      await seed(pg, { config: row });
    },
    drafts: () =>
      rows<DraftRow>(
        `SELECT guild_id, actor_id, officer_role_id, admin_role_id, eboard_role_id,
                events_committee_role_id, treasury_role_id, marketing_role_id,
                fingerprint, created_at::text AS created_at
         FROM discord_bot.setup_drafts WHERE guild_id = $1`,
      ),
    channels: () =>
      rows<ChannelRow>(
        `SELECT guild_id, channel_id, status::text AS status
         FROM discord_bot.managed_channels WHERE guild_id = $1
         ORDER BY created_at, channel_id`,
      ),
    changes: () =>
      rows(
        `SELECT actor_id, action FROM discord_bot.config_audit
         WHERE guild_id = $1 ORDER BY id`,
      ),
    async claims() {
      const result = await pg.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM discord_bot.interaction_claims",
      );
      return result.rows[0]?.count ?? 0;
    },
  };
}
