/**
 * Neon for the bot: the HTTP driver for reads and single statements, and a WebSocket
 * connection for each transaction.
 */

import { Pool, neon } from "@neondatabase/serverless";
import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { BotDb, DbClient } from "./client.ts";
import { limitStatements, openOn } from "./open.ts";
import * as schema from "./schema.ts";

/**
 * Reads and single statements: one HTTPS request each, so there is no connection to open,
 * keep or lose between requests.
 */
export function neonHttp(connectionString: string): BotDb {
  return drizzleHttp({ client: neon(connectionString), schema });
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
    const orm = drizzle({ client, schema });
    await limitStatements(orm, deadlineMs);
    return {
      orm,
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
