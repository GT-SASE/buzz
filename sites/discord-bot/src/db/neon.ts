/**
 * Neon's HTTP driver for reads: one HTTPS request per statement, so there is no
 * connection to open, keep or lose between requests. Writes that need a transaction use
 * its WebSocket pool, below.
 */

import { Pool, neon, types } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { DbClient, Runner } from "./client.ts";
import { openOn, statementTimeoutSql } from "./open.ts";
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
 * statements, which HTTP cannot give, so each write opens a pool of one over a WebSocket
 * (Node 22 and later have one built in), runs, and ends the pool in `finally`. Nothing
 * is held across requests, as Neon advises for serverless. The price is a handshake per
 * write; a statement that needs no lock still takes one round trip once connected.
 */
export function neonOpen(
  connectionString: string,
): NonNullable<DbClient["open"]> {
  return openOn(async (deadlineMs) => {
    const pool = new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 3000,
    });
    pool.on("error", () => undefined);
    const client = await pool.connect().catch(async (error: unknown) => {
      await pool.end().catch(() => undefined);
      throw error;
    });
    await client.query(statementTimeoutSql(deadlineMs));
    return {
      orm: drizzle({ client, schema }),
      close: async () => {
        client.release();
        await pool.end();
      },
      destroy: () => {
        client.release(true);
        void pool.end().catch(() => undefined);
      },
    };
  });
}
