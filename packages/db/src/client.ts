import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

/** Cached in development so HMR does not open a new connection per update. */
const globalForDb = globalThis as unknown as {
  conn: postgres.Sql | undefined;
};

const url = process.env.DATABASE_URL;

/**
 * postgres.js does not dial anything until the first query, so an unset URL
 * costs nothing at build time — which is what lets the public site deploy with
 * no environment at all.
 *
 * The unset branch must not be bare `postgres()`. That is not "no connection":
 * postgres.js then resolves host, port, user and database from PGHOST/PGPORT/
 * PGUSER/PGDATABASE or their defaults, so a misconfigured deployment quietly
 * dials localhost:5432 as the OS user instead of failing. `.invalid` is the
 * reserved TLD (RFC 2606) — it cannot resolve, so the first portal query fails
 * naming the actual problem.
 */
const conn =
  globalForDb.conn ??
  (url
    ? postgres(url)
    : postgres({
        host: "database-url-is-not-set.invalid",
        port: 1,
        database: "unset",
        username: "unset",
        max: 1,
      }));

if (process.env.NODE_ENV !== "production") globalForDb.conn = conn;

export const db = drizzle(conn, { schema });
