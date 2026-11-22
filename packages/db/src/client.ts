import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { pooledConnectionString } from "./pooled-url";
import * as schema from "./schema";

/** Cached in development so HMR does not open a new pool per update. */
const globalForDb = globalThis as unknown as {
  pool: Pool | undefined;
};

const url = process.env.DATABASE_URL;

/**
 * `pg.Pool` does not dial until the first query, so an unset URL costs nothing
 * at build time — which is what lets the public site deploy with no
 * environment at all.
 *
 * The unset branch must not omit host. `pg` then reads PGHOST/PGPORT/PGUSER,
 * so a misconfigured deployment quietly dials localhost:5432 as the OS user
 * instead of failing. `.invalid` is the reserved TLD (RFC 2606).
 *
 * `max` used to be 1 (postgres.js). Promise.all of dashboard queries then
 * queued on one socket, which is how /portal's p99 became the sum of every
 * query instead of the slowest one.
 */
const pool =
  globalForDb.pool ??
  new Pool(
    url
      ? {
          connectionString: pooledConnectionString(url),
          max: 5,
          idleTimeoutMillis: 10_000,
          connectionTimeoutMillis: 5_000,
        }
      : {
          host: "database-url-is-not-set.invalid",
          port: 1,
          database: "unset",
          user: "unset",
          max: 1,
        },
  );

if (process.env.NODE_ENV !== "production") globalForDb.pool = pool;

// Fluid keeps the instance warm; this closes idle sockets before suspend so
// the pool does not leak across freezes. Skip off-Vercel (tests, `next dev`).
if (process.env.VERCEL) attachDatabasePool(pool);

export const db = drizzle(pool, { schema });
