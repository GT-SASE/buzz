import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

/**
 * Cache the database connection in development. This avoids creating a new connection on every HMR
 * update.
 */
const globalForDb = globalThis as unknown as {
  conn: postgres.Sql | undefined;
};

/**
 * Read straight from the environment, and tolerate it being absent.
 *
 * postgres.js does not dial anything until the first query, so an unset URL
 * costs nothing at build time — which is what lets the public site deploy with
 * no environment at all. A portal request then fails loudly on its first query
 * instead of taking the whole build down for pages that never ask.
 */
const url = process.env.DATABASE_URL;
const conn = globalForDb.conn ?? (url ? postgres(url) : postgres());
if (process.env.NODE_ENV !== "production") globalForDb.conn = conn;

export const db = drizzle(conn, { schema });
