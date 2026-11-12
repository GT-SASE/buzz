import pg from "pg";
import type { TestProject } from "vitest/node";

/**
 * Runs once before every concurrency test file. CI has migrated a database with dbmate,
 * as an operator does, and given bot_app a password. Each file copies that database
 * into one of its own, which writes nothing cluster-wide, so the files can run in
 * parallel.
 *
 * Needs CONCURRENCY_DATABASE_URL, a Postgres 17 superuser connection to the migrated
 * database, and BOT_APP_PASSWORD, the password CI gave bot_app. The tests log in as
 * bot_app with it, as the bot does. A missing setting or a wrong server fails the run:
 * these tests must never skip.
 */

const EXPECTED_MAJOR_VERSION = "17";

declare module "vitest" {
  export interface ProvidedContext {
    concurrencyAdminUrl: string;
    concurrencyTemplate: string;
    concurrencyBotPassword: string;
  }
}

/**
 * Vitest 5 cannot print an error thrown here: mapping its stack fails, and only that
 * failure shows. So the reason is written out first.
 */
function fail(message: string): never {
  console.error(`concurrency tests: ${message}`);
  throw new Error(message);
}

export function urlForDatabase(adminUrl: string, name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** The same server and database, logged in as bot_app with its password. */
export function botUrlForDatabase(
  adminUrl: string,
  name: string,
  password: string,
): string {
  const url = new URL(urlForDatabase(adminUrl, name));
  url.username = "bot_app";
  url.password = password;
  return url.toString();
}

async function withClient<T>(
  url: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const migratedUrl = process.env.CONCURRENCY_DATABASE_URL;
  if (!migratedUrl) {
    fail(
      "CONCURRENCY_DATABASE_URL is not set, so the concurrency tests cannot run",
    );
  }
  const botPassword = process.env.BOT_APP_PASSWORD;
  if (!botPassword) {
    fail("BOT_APP_PASSWORD is not set, so the tests cannot log in as bot_app");
  }
  const template = new URL(migratedUrl).pathname.slice(1);
  const adminUrl = urlForDatabase(migratedUrl, "postgres");

  // Each file copies the template, which must have no open connection then, so each
  // check here closes its connection before any file starts.
  await withClient(adminUrl, async (cluster) => {
    const version = await cluster.query<{ server_version_num: string }>(
      "SHOW server_version_num",
    );
    const major = version.rows[0]?.server_version_num.slice(0, 2);
    if (major !== EXPECTED_MAJOR_VERSION) {
      fail(
        `the server must be Postgres ${EXPECTED_MAJOR_VERSION}, not ${String(major)}`,
      );
    }
  });

  await withClient(migratedUrl, async (client) => {
    const { rows } = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.schema_migrations",
    );
    if ((rows[0]?.count ?? 0) === 0) {
      fail(`${template} has no migrations applied`);
    }
  });

  // A wrong password, or a server that does not ask for one, should fail here and not
  // in every file.
  await withClient(
    botUrlForDatabase(adminUrl, template, botPassword),
    async (bot) => {
      const { rows } = await bot.query<{ user: string }>(
        "SELECT current_user AS user",
      );
      if (rows[0]?.user !== "bot_app") {
        fail("logging in with BOT_APP_PASSWORD did not give bot_app");
      }
    },
  );

  project.provide("concurrencyAdminUrl", adminUrl);
  project.provide("concurrencyBotPassword", botPassword);
  project.provide("concurrencyTemplate", template);
}
