import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Tests read TEST_DATABASE_URL only. DATABASE_URL is cleared so nothing can
 * fall back to the deployment's database; unset means the DB suites skip.
 */
const envFile = resolve(import.meta.dirname, "../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl) {
  process.env.DATABASE_URL = testDatabaseUrl;
} else {
  delete process.env.DATABASE_URL;
}

/**
 * No test sends real mail or posts to a real channel. A test that exercises
 * sending stubs these itself, against a mocked transport or `fetch`.
 */
for (const name of [
  "GMAIL_USER",
  "GMAIL_APP_PASSWORD",
  "MAIL_REPLY_TO",
  "NOTIFY_DISCORD_WEBHOOK_URL",
]) {
  delete process.env[name];
}

/** Check-in codes are signed with a key derived from this; set one for tests. */
process.env.AUTH_SECRET ??= "test-auth-secret-test-auth-secret-0123456789";
