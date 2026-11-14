import pg from "pg";
import { describe, expect, it } from "bun:test";
import { getGuildConfig } from "../../src/db/guild-config.ts";
import { claimInteraction } from "../../src/db/interaction-claims.ts";
import { insertGuild } from "../db/fixtures.ts";
import { errorCodeOf, fakeId } from "../db/harness.ts";
import { botUrlForDatabase, concurrencyContext } from "./global-setup.ts";
import { raceDatabase } from "./race.ts";

const INSUFFICIENT_PRIVILEGE = "42501";
const INVALID_PASSWORD = "28P01";

/**
 * The role the bot logs in as, on a real server with password logins, reached the way
 * production reaches it. PGlite has one session and no logins, so only this shows what
 * bot_app itself may do once connected, and that it cannot turn into another role.
 */
describe("the bot's role over a real connection", () => {
  const db = raceDatabase();

  it("reads and writes through the bot's own client", async () => {
    const guild = await insertGuild(db.connection);
    const config = await getGuildConfig(db.db, { guildId: guild.guildId });
    expect(config).toMatchObject({
      ok: true,
      value: { guild_id: guild.guildId },
    });
    expect(await claimInteraction(db.db, { interactionId: fakeId() })).toEqual({
      ok: true,
      value: true,
    });
  });

  it("is logged in as bot_app, with its own statement timeout and UTC", async () => {
    const { rows } = await db.t1.query<{
      user: string;
      timeout: string;
      zone: string;
    }>(
      "SELECT current_user AS user, current_setting('statement_timeout') AS timeout, current_setting('TimeZone') AS zone",
    );
    expect(rows).toEqual([{ user: "bot_app", timeout: "10s", zone: "UTC" }]);
  });

  it.each([
    "DELETE FROM public.tasks",
    "DELETE FROM public.interaction_claims",
    "TRUNCATE public.tasks",
    "TRUNCATE public.config_audit",
    "ALTER TABLE public.tasks DISABLE TRIGGER ALL",
    "CREATE TABLE public.forged (id int)",
    "SELECT * FROM history.row_versions",
    "INSERT INTO public.task_reassignments (guild_id, actor_id, task_id) VALUES ('1', '1', gen_random_uuid())",
    "SET ROLE migration_owner",
  ])("cannot run %s", async (sql) => {
    expect(await errorCodeOf(db.t1.query(sql))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  // Postgres lets a role change its own settings, so the timeout is a default the bot
  // keeps, not a limit a leaked login is held to. Both changes run in a transaction that
  // is rolled back, so neither this session nor the role keeps them for later tests.
  it("can lift its own statement timeout, which is only a default", async () => {
    await db.t1.query("BEGIN");
    try {
      await db.t1.query("SET LOCAL statement_timeout = 0");
      await db.t1.query("ALTER ROLE bot_app SET statement_timeout = 0");
      const { rows } = await db.t1.query<{ timeout: string; config: string[] }>(
        `SELECT current_setting('statement_timeout') AS timeout, rolconfig AS config
         FROM pg_catalog.pg_roles WHERE rolname = 'bot_app'`,
      );
      expect(rows).toEqual([
        {
          timeout: "0",
          config: expect.arrayContaining(["statement_timeout=0"]) as string[],
        },
      ]);
    } finally {
      await db.t1.query("ROLLBACK");
    }
    const { rows } = await db.observer.query<{ config: string[] }>(
      "SELECT rolconfig AS config FROM pg_catalog.pg_roles WHERE rolname = 'bot_app'",
    );
    expect(rows[0]?.config).toContain("statement_timeout=10s");
    const after = await db.t1.query<{ timeout: string }>(
      "SELECT current_setting('statement_timeout') AS timeout",
    );
    expect(after.rows).toEqual([{ timeout: "10s" }]);
  });

  it("is refused with a wrong password", async () => {
    const url = new URL(
      botUrlForDatabase(
        concurrencyContext().adminUrl,
        "postgres",
        concurrencyContext().botPassword,
      ),
    );
    url.password = `${url.password}-wrong`;
    const client = new pg.Client({ connectionString: url.toString() });
    expect(await errorCodeOf(client.connect())).toBe(INVALID_PASSWORD);
    await client.end().catch(() => undefined);
  });
});
