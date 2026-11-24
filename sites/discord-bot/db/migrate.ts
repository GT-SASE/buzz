/**
 * Applies the bot's migrations as the database's owner: `bun run db:migrate`, with
 * `DATABASE_URL` set to the owner's connection string and the `discord_bot` schema
 * already made, as docs/SETUP.md says.
 *
 * Until this tool took over, dbmate made the schema, and a production database holds
 * dbmate's six files in `discord_bot.schema_migrations` and none of Drizzle's ledger,
 * `discord_bot.drizzle_migrations`. Drizzle runs every file newer than the newest row in
 * its ledger, so on such a database it would run 0000_baseline.sql on tables that exist
 * and fail. `adoptDbmateDatabase` writes the baseline's row into the ledger first, in
 * one transaction, and only when the database is exactly where dbmate left it. After
 * that Drizzle runs what is newer than the baseline, 0001, and nothing else.
 *
 * A new database has no `schema_migrations`, so nothing is adopted and Drizzle runs both
 * files. A database Drizzle already ledgered is left alone.
 */

import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import pg from "pg";

const MIGRATIONS_FOLDER = join(import.meta.dirname, "drizzle");
const MIGRATIONS_SCHEMA = "discord_bot";
const MIGRATIONS_TABLE = "drizzle_migrations";

/** The files dbmate applied, all of which 0000_baseline.sql stands for. */
export const DBMATE_VERSIONS: readonly string[] = [
  "20261111000000",
  "20261115000000",
  "20261119000000",
  "20261119000100",
  "20261119000200",
  "20261119000300",
];

const LEDGER = `"${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`;

export type Adoption = "adopted" | "already_ledgered" | "new_database";

/** What adopting needs of a connection, so a pg client and PGlite both fit. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Marks 0000_baseline.sql applied on a database dbmate built. Refuses anything but
 * exactly dbmate's six files, so a database one file behind is finished with the old
 * tool first, and one ahead of this code is not guessed at.
 */
export async function adoptDbmateDatabase(
  client: Queryable,
): Promise<Adoption> {
  await client.query("BEGIN");
  try {
    const found = await client.query(
      `SELECT to_regclass('${MIGRATIONS_SCHEMA}.schema_migrations')::text AS old,
              to_regclass('${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}')::text AS ledger`,
    );
    const { old, ledger } = (found.rows[0] ?? { old: null, ledger: null }) as {
      old: string | null;
      ledger: string | null;
    };
    if (ledger !== null) {
      const { rows } = await client.query(
        `SELECT count(*)::int AS count FROM ${LEDGER}`,
      );
      if (((rows[0] as { count: number } | undefined)?.count ?? 0) > 0) {
        await client.query("COMMIT");
        return "already_ledgered";
      }
    }
    if (old === null) {
      await client.query("COMMIT");
      return "new_database";
    }

    // Two runs at once would both see an empty ledger and both write the row.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('discord_bot_migrate', 0))",
    );
    // A run that waited on the lock finds the other's row and has nothing to do.
    const again = await client.query(
      `SELECT to_regclass('${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}')::text AS ledger`,
    );
    if ((again.rows[0] as { ledger: string | null }).ledger !== null) {
      const filled = await client.query(
        `SELECT count(*)::int AS count FROM ${LEDGER}`,
      );
      if ((filled.rows[0] as { count: number }).count > 0) {
        await client.query("COMMIT");
        return "already_ledgered";
      }
    }
    const versions = await client.query(
      `SELECT version FROM ${MIGRATIONS_SCHEMA}.schema_migrations ORDER BY version`,
    );
    const applied = (versions.rows as { version: string }[]).map(
      (row) => row.version,
    );
    if (applied.join(",") !== DBMATE_VERSIONS.join(",")) {
      throw new Error(
        `discord_bot.schema_migrations holds ${String(applied.length)} versions (${applied.join(", ")}) ` +
          `and this code expects exactly ${DBMATE_VERSIONS.join(", ")}. Bring the database to the ` +
          "last dbmate file with `bun run db:migrate:legacy` from an older checkout, then run this again.",
      );
    }

    const [baseline] = readMigrationFiles({
      migrationsFolder: MIGRATIONS_FOLDER,
    });
    if (baseline === undefined) {
      throw new Error("db/drizzle has no baseline migration");
    }
    // The table as Drizzle makes it, so its own CREATE TABLE IF NOT EXISTS is a no-op.
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${LEDGER} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    );
    await client.query(
      `INSERT INTO ${LEDGER} (hash, created_at) VALUES ($1, $2)`,
      [baseline.hash, baseline.folderMillis],
    );
    await client.query("COMMIT");
    return "adopted";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** Adopts a dbmate database if this is one, then applies every newer migration. */
export async function migrateBotDatabase(client: pg.Client): Promise<Adoption> {
  // One run at a time on this database, for adopting and for Drizzle's own check of
  // what is pending, which two runs would both pass before either applied 0001.
  const key = "hashtextextended('discord_bot_migrate', 0)";
  await client.query(`SELECT pg_advisory_lock(${key})`);
  try {
    const adoption = await adoptDbmateDatabase(client);
    await migrate(drizzle(client), {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: MIGRATIONS_TABLE,
    });
    return adoption;
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${key})`);
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "DATABASE_URL is not set. Use the owner's connection string.",
    );
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const adoption = await migrateBotDatabase(client);
    console.log(
      adoption === "adopted"
        ? "Adopted a dbmate database: 0000_baseline.sql marked applied, newer files run."
        : adoption === "new_database"
          ? "New database: every file run."
          : "Ledger present: newer files run.",
    );
  } finally {
    await client.end();
  }
}
