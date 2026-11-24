/**
 * Setup steps that go through the bot's own write code, as bot_app, on a database a test
 * built. They stand where raw calls of the old database functions stood, so a fixture
 * changes a guild's config the way the bot does, with the same version checks and audit.
 */

import type { PGlite } from "@electric-sql/pglite";
import { createDbClient, type DbClient } from "../../src/db/client.ts";
import type { DbResult } from "../../src/db/errors.ts";
import {
  applyConfigChange,
  applyRoleBindings,
  type ConfigChangeInput,
  type RoleBindings,
} from "../../src/db/guild-config.ts";
import { pgOrm, pgliteClient } from "../support/sql-client.ts";
import { queryAs, type Connection } from "./harness.ts";

/**
 * The bot's client on a test database: as bot_app on PGlite, or on a real server through
 * the connection that set it up, which is not restricted to bot_app's grants.
 */
export function botClient(db: Connection | PGlite): DbClient {
  const client = (db as Connection).pgClient;
  return client === undefined
    ? pgliteClient(db as PGlite)
    : createDbClient(pgOrm(client));
}

/** A result a test needs to have succeeded, or fails with the category it failed as. */
export function must<T>(result: DbResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `expected success, got ${result.error.category}:${result.error.code ?? "-"}`,
    );
  }
  return result.value;
}

/** A guild's config version, 0 when it has none. */
export async function configVersion(
  db: Connection,
  guildId: string,
): Promise<number> {
  const rows = await queryAs<{ version: number }>(
    db,
    "bot_app",
    "SELECT version FROM discord_bot.guild_config WHERE guild_id = $1",
    [guildId],
  );
  return rows[0]?.version ?? 0;
}

/** /setup's write: the six roles, `null` for one left unbound. */
export async function bindRoles(
  db: Connection,
  roles: Partial<RoleBindings> & Pick<RoleBindings, "guildId">,
): Promise<number> {
  return must(
    await applyRoleBindings(botClient(db), {
      actorId: roles.actorId ?? "100000000000000001",
      expectedVersion: roles.expectedVersion ?? 0,
      officerRoleId: roles.officerRoleId ?? "100000000000000002",
      adminRoleId: roles.adminRoleId ?? "100000000000000003",
      eboardRoleId: roles.eboardRoleId ?? null,
      eventsCommitteeRoleId: roles.eventsCommitteeRoleId ?? null,
      treasuryRoleId: roles.treasuryRoleId ?? null,
      marketingRoleId: roles.marketingRoleId ?? null,
      ...roles,
    }),
  );
}

/** /config's write: reminders on or off, forums to add, forums to remove. */
export async function changeConfig(
  db: Connection,
  change: Partial<ConfigChangeInput> & Pick<ConfigChangeInput, "guildId">,
): Promise<number> {
  return must(
    await applyConfigChange(botClient(db), {
      actorId: "100000000000000001",
      expectedVersion: await configVersion(db, change.guildId),
      remindersEnabled: null,
      addChannelIds: [],
      removeChannelIds: [],
      timezone: null,
      ...change,
    }),
  );
}
