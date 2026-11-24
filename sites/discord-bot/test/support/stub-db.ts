import type { DbClient } from "../../src/db/client.ts";
import { recordingClient, type Intercept, type SqlCall } from "./sql-client.ts";

/** A client that runs nothing and answers every statement with `respond`. */
export function stubDb(respond?: Intercept): {
  db: DbClient;
  calls: SqlCall[];
} {
  return recordingClient(respond);
}
