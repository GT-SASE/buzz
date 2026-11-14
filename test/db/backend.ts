/**
 * Where the access layer tests run: the migrated database on PGlite, logged in as
 * bot_app. The statements are the ones production sends: only where they run differs.
 */

import { createDbClient, type DbClient } from "../../src/db/client.ts";
import { pgliteSql } from "../support/sql-client.ts";
import { createMigratedDb, type Connection } from "./harness.ts";

export interface Backend {
  /** A superuser connection, for setting up rows the bot's role cannot write. */
  connection: Connection;
  db: DbClient;
  /** A client that runs `before` ahead of each statement, to stage a race at that point. */
  dbWith: (before: (statement: string) => Promise<void>) => DbClient;
  close: () => Promise<unknown>;
}

export async function openBackend(): Promise<Backend> {
  const database = await createMigratedDb();
  return {
    connection: database,
    db: createDbClient(pgliteSql(database)),
    dbWith: (before) =>
      createDbClient(
        pgliteSql(database, async (call) => {
          await before(call.sql);
          return undefined;
        }),
      ),
    close: () => database.close(),
  };
}
