/**
 * Applies the bot's migrations as the database's owner: `bun run db:migrate`, with
 * `DATABASE_URL` set to the owner's connection string and the `discord_bot` schema
 * already made, as docs/SETUP.md says. Drizzle keeps its record in
 * `discord_bot.drizzle_migrations` and runs every file newer than the newest row in it.
 *
 * One run at a time: a second run waits for the first, then finds nothing left to do.
 */

import { join } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const MIGRATIONS_FOLDER = join(import.meta.dirname, "drizzle");
const LOCK = sql`hashtextextended('discord_bot_migrate', 0)`;
const ONE_ROW = sql`(values (1)) as one(x)`;

async function migrateBotDatabase(client: pg.Client): Promise<void> {
  const db = drizzle(client);
  await db.select({ locked: sql`pg_advisory_lock(${LOCK})` }).from(ONE_ROW);
  try {
    await migrate(db, {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsSchema: "discord_bot",
      migrationsTable: "drizzle_migrations",
    });
  } finally {
    await db
      .select({ unlocked: sql`pg_advisory_unlock(${LOCK})` })
      .from(ONE_ROW);
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
    await migrateBotDatabase(client);
    console.log("Migrations applied.");
  } finally {
    await client.end();
  }
}
