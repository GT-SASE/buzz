import { describe, expect, it } from "vitest";
import {
  applyConfigChange,
  applyRoleBindings,
  type RoleBindings,
} from "../../src/db/guild-config.ts";
import { insertGuild } from "../db/fixtures.ts";
import { fakeId } from "../db/harness.ts";
import { raceDatabase } from "./race.ts";

const STALE = {
  ok: false,
  error: { category: "stale_version", code: "CF409" },
};

/**
 * Two panels saving at once, or two first setups of the same server. Each save names the
 * version it read, and the one that loses must be told its view is stale rather than
 * overwrite the other.
 */
describe("two config saves at once", () => {
  const db = raceDatabase();
  const changeSql =
    "SELECT public.apply_config_change($1, $2, $3, $4) AS version";
  const bindingsSql =
    "SELECT public.apply_role_bindings($1, $2, $3, $4, $5, $6, $7, $8, $9) AS version";

  /** Arguments after the version for a full set of role bindings: actor, then roles. */
  const roles = () => [
    fakeId(),
    fakeId(),
    fakeId(),
    fakeId(),
    fakeId(),
    fakeId(),
    fakeId(),
  ];

  /** The bot's own save of a full set of role bindings. */
  const bindings = (
    guildId: string,
    expectedVersion: number,
  ): RoleBindings => ({
    guildId,
    actorId: fakeId(),
    expectedVersion,
    officerRoleId: fakeId(),
    adminRoleId: fakeId(),
    eboardRoleId: fakeId(),
    eventsCommitteeRoleId: fakeId(),
    treasuryRoleId: fakeId(),
    marketingRoleId: fakeId(),
  });

  const remindersOn = (guildId: string) => ({
    guildId,
    actorId: fakeId(),
    expectedVersion: 2,
    remindersEnabled: true,
    addChannelIds: [],
    removeChannelIds: [],
    timezone: null,
  });

  async function auditCount(guildId: string): Promise<number> {
    const { rows } = await db.observer.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.config_audit WHERE guild_id = $1",
      [guildId],
    );
    return rows[0]?.n ?? -1;
  }

  it("settings: the save that waited gets CF409 and changes nothing", async () => {
    // insertGuild leaves the guild at version 2 with two audit rows.
    const { guildId } = await insertGuild(db.connection);

    const second = await db.race(
      [changeSql, [guildId, 2, fakeId(), false]],
      (bot) => applyConfigChange(bot, remindersOn(guildId)),
    );

    expect(second).toEqual(STALE);
    const { rows } = await db.observer.query(
      "SELECT version, reminders_enabled FROM public.guild_config WHERE guild_id = $1",
      [guildId],
    );
    expect(rows).toEqual([{ version: 3, reminders_enabled: false }]);
    expect(await auditCount(guildId)).toBe(3);
  });

  it("settings: the save that waited goes through if the first rolls back", async () => {
    const { guildId } = await insertGuild(db.connection);

    const second = await db.race(
      [changeSql, [guildId, 2, fakeId(), false]],
      (bot) => applyConfigChange(bot, remindersOn(guildId)),
      "ROLLBACK",
    );

    expect(second).toEqual({ ok: true, value: 3 });
    expect(await auditCount(guildId)).toBe(3);
  });

  it("role bindings: the save that waited gets CF409 and changes nothing", async () => {
    const { guildId } = await insertGuild(db.connection);

    const second = await db.race(
      [bindingsSql, [guildId, 2, ...roles()]],
      (bot) => applyRoleBindings(bot, bindings(guildId, 2)),
    );

    expect(second).toEqual(STALE);
    expect(await auditCount(guildId)).toBe(3);
  });

  describe("first setup", () => {
    it("the setup that waited gets CF409, leaving one config row and one audit row", async () => {
      const guildId = fakeId();
      const first = roles();

      const second = await db.race(
        [bindingsSql, [guildId, 0, ...first]],
        (bot) => applyRoleBindings(bot, bindings(guildId, 0)),
      );

      expect(second).toEqual(STALE);
      const { rows } = await db.observer.query(
        "SELECT version, officer_role_id FROM public.guild_config WHERE guild_id = $1",
        [guildId],
      );
      expect(rows).toEqual([{ version: 1, officer_role_id: first[1] }]);
      expect(await auditCount(guildId)).toBe(1);
    });

    it("the setup that waited goes through if the first rolls back", async () => {
      const guildId = fakeId();

      const second = await db.race(
        [bindingsSql, [guildId, 0, ...roles()]],
        (bot) => applyRoleBindings(bot, bindings(guildId, 0)),
        "ROLLBACK",
      );

      expect(second).toEqual({ ok: true, value: 1 });
      expect(await auditCount(guildId)).toBe(1);
    });
  });
});
