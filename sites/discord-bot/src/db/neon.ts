/**
 * Neon's HTTP driver for reads: one HTTPS request per statement, so there is no
 * connection to open, keep or lose between requests. Writes that need a transaction use
 * its WebSocket pool, below.
 */

import { Pool, neon, types } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { BotDb, Runner } from "./client.ts";
import { TYPE_PARSERS } from "./parsers.ts";
import * as schema from "./schema.ts";

const parsers = {
  getTypeParser: (
    oid: number,
    format?: "text" | "binary",
  ): ((value: string) => unknown) =>
    TYPE_PARSERS.get(oid) ??
    (types.getTypeParser(oid, format) as (value: string) => unknown),
};

export function neonRunner(connectionString: string): Runner {
  const sql = neon(connectionString);
  return (text, params, signal) =>
    sql.query(text, [...params], { types: parsers, fetchOptions: { signal } });
}

/**
 * The connection for writes. A transaction needs one connection for all of its
 * statements, which HTTP cannot give, so these go over a WebSocket (Node 22 and later
 * have one built in) from a small pool. Idle connections are let go after a few seconds,
 * so a function that goes quiet holds none open, and a connection that Neon drops while
 * idle is only noted, as the next statement takes a fresh one.
 */
export function neonOrm(connectionString: string): BotDb {
  const pool = new Pool({
    connectionString,
    max: 4,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 3000,
  });
  pool.on("error", () => undefined);
  return drizzle({ client: pool, schema });
}
