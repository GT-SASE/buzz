import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Config } from "drizzle-kit";

/**
 * `.env` lives with the web app, because that is the one place Next.js reads it
 * from without configuration. drizzle-kit never loads Next, so it is pointed at
 * the same file rather than given a second copy of the credentials.
 */
const envFile = resolve(import.meta.dirname, "../../sites/web/.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const url = process.env.DATABASE_URL;

// Required here and only here. The app tolerates a missing URL so the public
// site can deploy with no environment at all; drizzle-kit cannot, because
// every one of its commands is a round trip to the database.
if (!url) {
  throw new Error(
    `DATABASE_URL is not set. Add it to ${envFile} (copy .env.example) before running a db: script.`,
  );
}

export default {
  schema: "./src/schema.ts",
  dialect: "postgresql",
  dbCredentials: { url },
  tablesFilter: ["buzz_*"],
} satisfies Config;
