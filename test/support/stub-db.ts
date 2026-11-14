import { createDbClient, type DbClient } from "../../src/db/client.ts";
import { recordingSql, type Intercept, type SqlCall } from "./sql-client.ts";

/** A client that runs nothing and answers every statement with `respond`. */
export function stubDb(respond?: Intercept): {
  db: DbClient;
  calls: SqlCall[];
} {
  const { sql, calls } = recordingSql(respond);
  return { db: createDbClient(sql), calls };
}
