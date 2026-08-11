import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Config } from "drizzle-kit";

/**
 * `.env` lives with the web app, because that is the one place Next.js reads it
 * from without configuration. drizzle-kit never loads Next, so it is pointed at
 * the same file rather than given a second copy of the credentials.
 */
// `process.cwd()`, not `import.meta.dirname`: drizzle-kit bundles this config
// to CJS before running it, which leaves import.meta empty. The scripts that
// use this file all run with the package directory as the working directory.
const envFile = resolve(process.cwd(), "../../sites/web/.env");
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
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  tablesFilter: ["buzz_*"],
} satisfies Config;
