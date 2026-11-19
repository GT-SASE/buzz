/**
 * Neon's HTTP driver: one HTTPS request per statement, so there is no connection to
 * open, keep or lose between requests.
 */

import { neon, types } from "@neondatabase/serverless";
import type { Runner } from "./client.ts";
import { TYPE_PARSERS } from "./parsers.ts";

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
