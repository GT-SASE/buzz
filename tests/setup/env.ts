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
