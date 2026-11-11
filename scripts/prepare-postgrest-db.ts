/**
 * Prepares an empty Postgres database for a real PostgREST server: the platform's
 * starting state, every migration, and the role PostgREST logs in as.
 *
 * Usage: POSTGREST_DATABASE_URL=<superuser URL> node scripts/prepare-postgrest-db.ts
 */

import pg from "pg";
import { PLATFORM_BOOTSTRAP, migrationScripts } from "../test/db/harness.ts";

/**
 * NOINHERIT, so the login itself has no rights: PostgREST must switch to the role
 * named in a request's token, as it does on hosted Supabase.
 */
const AUTHENTICATOR = `
  CREATE ROLE authenticator LOGIN NOINHERIT;
  GRANT anon, authenticated, service_role TO authenticator;
`;

async function main(): Promise<void> {
  const connectionString = process.env.POSTGREST_DATABASE_URL;
  if (connectionString === undefined || connectionString === "") {
    throw new Error("POSTGREST_DATABASE_URL must be set");
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(PLATFORM_BOOTSTRAP);
    for (const script of migrationScripts()) {
      await client.query(script);
    }
    await client.query(AUTHENTICATOR);
  } finally {
    await client.end();
  }
  console.log("Database ready for PostgREST.");
}

await main();
