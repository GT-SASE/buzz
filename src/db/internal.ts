/**
 * The link between an opaque `DbClient` and the query client behind it. Lint stops
 * anything outside `src/db/` importing this file, so code elsewhere can hold a client
 * and pass it to the functions here, but cannot build a query with it.
 */

import type { PostgrestClient } from "@supabase/postgrest-js";
import type { Database } from "./types.ts";

declare const dbClientBrand: unique symbol;

/** A database connection that only the functions in `src/db/` can use. */
export interface DbClient {
  readonly [dbClientBrand]: true;
}

export type RestClient = PostgrestClient<Database>;

interface Registered {
  readonly client: RestClient;
  readonly withDeadline: (deadlineMs: number) => DbClient;
}

const registry = new WeakMap<DbClient, Registered>();

export function registerClient(entry: Registered): DbClient {
  // Only ever a key in the registry, so it needs no properties of its own.
  const handle = Object.freeze({}) as unknown as DbClient;
  registry.set(handle, entry);
  return handle;
}

function registered(db: DbClient): Registered {
  const entry = registry.get(db);
  if (entry === undefined) {
    throw new TypeError("Not a database client");
  }
  return entry;
}

export function rest(db: DbClient): RestClient {
  return registered(db).client;
}

export function rebuildWithDeadline(
  db: DbClient,
  deadlineMs: number,
): DbClient {
  return registered(db).withDeadline(deadlineMs);
}
