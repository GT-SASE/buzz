import { type Config } from "drizzle-kit";

/**
 * Only `generate` runs from here, which reads `src/db/schema.ts` and needs no database.
 * Migrations are applied by `db/migrate.ts`, which takes `DATABASE_URL` itself, so this
 * file never reads a connection string.
 */
export default {
  schema: "./src/db/schema.ts",
  out: "./db/drizzle",
  dialect: "postgresql",
  schemaFilter: ["discord_bot"],
  migrations: { schema: "discord_bot", table: "drizzle_migrations" },
} satisfies Config;
