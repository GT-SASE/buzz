/**
 * Prepares a real Postgres server for scripts/test-backup-restore.sh.
 *
 * "source" gives it the platform's starting state, every migration, a record of those
 * migrations as the Supabase CLI keeps one, and a row in every table, one holding the canary
 * text. "recovery" gives it only the starting state, as a new project would have, for the
 * recovery steps in docs/BACKUPS.md.
 *
 * Both also get default privileges owned by a superuser the owner is not a member of, as
 * Supabase's supabase_admin has. Modelled on its role setup and not read from a hosted
 * project. A dump carries them, and the owner cannot restore them.
 *
 * Usage:
 *   BACKUP_TEST_DATABASE_URL=<superuser URL> BACKUP_RLS_PATH=policies|bypassrls \
 *     BACKUP_CANARY=<text> node scripts/prepare-backup-db.ts source|recovery
 */

import pg from "pg";
import {
  FIXTURE_DUE_DATE,
  insertEvent,
  insertGuild,
  insertTask,
} from "../test/db/fixtures.ts";
import {
  MIGRATION_OWNER,
  PLATFORM_BOOTSTRAP,
  fakeId,
  migrationFiles,
  migrationScripts,
  pgConnection,
  queryAs,
  type Connection,
} from "../test/db/harness.ts";

const PLATFORM_DEFAULT_PRIVILEGES = `
  CREATE ROLE supabase_admin NOLOGIN SUPERUSER;
  ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
    GRANT ALL ON SEQUENCES TO ${MIGRATION_OWNER};
`;

// The same shape as the CLI's table, as far as its columns are known here. The owner holds it
// so that the migration that grants on it can, as it would on the platform.
const MIGRATION_RECORD = `
  CREATE SCHEMA supabase_migrations AUTHORIZATION ${MIGRATION_OWNER};
  CREATE TABLE supabase_migrations.schema_migrations (
    version text PRIMARY KEY,
    statements text[],
    name text
  );
  ALTER TABLE supabase_migrations.schema_migrations OWNER TO ${MIGRATION_OWNER};
`;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set`);
  }
  return value;
}

async function seed(db: Connection, canary: string): Promise<void> {
  const guild = await insertGuild(db);
  const eventId = await insertEvent(db, guild);
  const taskId = await insertTask(db, guild, eventId);
  // Updated twice, so that history.row_versions holds the canary as well.
  for (const name of [canary, `${canary} again`]) {
    await queryAs(
      db,
      "service_role",
      `UPDATE public.events SET name = $1 WHERE id = $2`,
      [name, eventId],
    );
  }
  await queryAs(
    db,
    "service_role",
    `SELECT public.claim_reminder($1, 'due_day', '${FIXTURE_DUE_DATE}')`,
    [taskId],
  );
  await queryAs(db, "service_role", `SELECT public.claim_interaction($1)`, [
    fakeId(),
  ]);
  await queryAs(
    db,
    "service_role",
    `SELECT public.claim_event_post_attempt($1, $2)`,
    [eventId, guild.guildId],
  );
  await queryAs(
    db,
    "service_role",
    `INSERT INTO public.task_reassignments (guild_id, actor_id, task_id)
     VALUES ($1, $2, $3)`,
    [guild.guildId, fakeId(), taskId],
  );
  // Written as the superuser, because the bot's role has no direct write to this table.
  await db.query(
    `INSERT INTO public.job_runs (job_name, status, finished_at)
     SELECT 'reminders', 'succeeded', now() FROM generate_series(1, 6)`,
  );
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "source" && mode !== "recovery") {
    throw new Error("the first argument must be source or recovery");
  }
  const rlsPath = required("BACKUP_RLS_PATH");
  if (rlsPath !== "policies" && rlsPath !== "bypassrls") {
    throw new Error("BACKUP_RLS_PATH must be policies or bypassrls");
  }

  const client = new pg.Client({
    connectionString: required("BACKUP_TEST_DATABASE_URL"),
  });
  await client.connect();
  try {
    await client.query(PLATFORM_BOOTSTRAP);
    await client.query(PLATFORM_DEFAULT_PRIVILEGES);
    // The migration can hand BYPASSRLS on only if its own role has it.
    if (rlsPath === "bypassrls") {
      await client.query(`ALTER ROLE ${MIGRATION_OWNER} BYPASSRLS`);
    }
    if (mode === "recovery") {
      await client.query(`ALTER ROLE ${MIGRATION_OWNER} LOGIN`);
    } else {
      await client.query(MIGRATION_RECORD);
      for (const script of migrationScripts()) {
        await client.query(script);
      }
      for (const file of migrationFiles()) {
        await client.query(
          `INSERT INTO supabase_migrations.schema_migrations (version) VALUES ($1)`,
          [file.slice(0, 14)],
        );
      }
      await seed(pgConnection(client), required("BACKUP_CANARY"));
    }
  } finally {
    await client.end();
  }
  console.log(`Database ready: ${mode}, ${rlsPath}.`);
}

await main();
