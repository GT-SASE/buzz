import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  BOT_APP,
  INSUFFICIENT_PRIVILEGE,
  OTHER_ROLE,
  createMigratedDb,
  errorCodeOf,
  fakeId,
  queryAs,
} from "./harness.ts";

const STALE_VERSION = "CF409";
const CHECK_VIOLATION = "23514";
const INVALID_PARAMETER = "22023";
const NO_EXTRA_ROLES = {
  eboard_role_id: null,
  events_committee_role_id: null,
  treasury_role_id: null,
  marketing_role_id: null,
};

interface MoreRoles {
  eboard?: string | null;
  eventsCommittee?: string | null;
  treasury?: string | null;
  marketing?: string | null;
}

interface Change {
  reminders?: boolean;
  add?: (string | null)[];
  remove?: (string | null)[];
  actor?: string;
  timezone?: string;
}

let db: PGlite;

beforeAll(async () => {
  db = await createMigratedDb();
});

afterAll(async () => {
  await db.close();
});

async function versionFrom(sql: string, params: unknown[]): Promise<number> {
  const rows = await queryAs<{ version: number }>(db, BOT_APP, sql, params);
  return (rows[0] as { version: number }).version;
}

function applyRoles(
  guildId: string,
  expected: number | null,
  officer: string,
  admin: string,
  more: MoreRoles = {},
): Promise<number> {
  return versionFrom(
    `SELECT public.apply_role_bindings($1, $2, $3, $4, $5, $6, $7, $8, $9) AS version`,
    [
      guildId,
      expected,
      fakeId(),
      officer,
      admin,
      more.eboard ?? null,
      more.eventsCommittee ?? null,
      more.treasury ?? null,
      more.marketing ?? null,
    ],
  );
}

function applyChange(
  guildId: string,
  expected: number,
  change: Change,
): Promise<number> {
  return versionFrom(
    `SELECT public.apply_config_change($1, $2, $3, $4, $5, $6, $7) AS version`,
    [
      guildId,
      expected,
      change.actor ?? fakeId(),
      change.reminders ?? null,
      change.add ?? [],
      change.remove ?? [],
      change.timezone ?? null,
    ],
  );
}

async function setUpGuild(): Promise<string> {
  const guildId = fakeId();
  await applyRoles(guildId, 0, fakeId(), fakeId());
  return guildId;
}

async function auditRows(guildId: string) {
  const { rows } = await db.query<{
    actor_id: string;
    action: string;
    old_values: Record<string, unknown> | null;
    new_values: Record<string, unknown>;
    version_after: number;
  }>(
    `SELECT actor_id, action, old_values, new_values, version_after
     FROM public.config_audit WHERE guild_id = $1 ORDER BY id`,
    [guildId],
  );
  return rows;
}

async function configOf(guildId: string) {
  const { rows } = await db.query<{
    version: number;
    reminders_enabled: boolean;
    timezone: string;
  }>(
    `SELECT version, reminders_enabled, timezone FROM public.guild_config WHERE guild_id = $1`,
    [guildId],
  );
  return rows[0];
}

async function channelsOf(guildId: string) {
  const { rows } = await db.query<{ channel_id: string; status: string }>(
    `SELECT channel_id, status FROM public.managed_channels WHERE guild_id = $1 ORDER BY channel_id`,
    [guildId],
  );
  return rows;
}

describe("apply_role_bindings", () => {
  it("creates the config, rebinds every role, unbinds on null and audits each change", async () => {
    const guildId = fakeId();
    const officer = fakeId();
    const admin = fakeId();
    const newOfficer = fakeId();
    const roles = {
      eboard: fakeId(),
      eventsCommittee: fakeId(),
      treasury: fakeId(),
      marketing: fakeId(),
    };
    expect(await applyRoles(guildId, 0, officer, admin)).toBe(1);
    expect(await applyRoles(guildId, 1, newOfficer, admin, roles)).toBe(2);

    const bound = await db.query(
      `SELECT officer_role_id, eboard_role_id, events_committee_role_id,
              treasury_role_id, marketing_role_id
       FROM public.guild_config WHERE guild_id = $1`,
      [guildId],
    );
    expect(bound.rows).toEqual([
      {
        officer_role_id: newOfficer,
        eboard_role_id: roles.eboard,
        events_committee_role_id: roles.eventsCommittee,
        treasury_role_id: roles.treasury,
        marketing_role_id: roles.marketing,
      },
    ]);
    const first = {
      officer_role_id: officer,
      admin_role_id: admin,
      ...NO_EXTRA_ROLES,
    };
    const audit = await auditRows(guildId);
    expect(audit[0]).toMatchObject({
      action: "role_bindings",
      old_values: null,
      new_values: first,
      version_after: 1,
    });
    expect(audit[1]?.old_values).toEqual(first);
    expect(audit[1]?.new_values).toMatchObject({
      officer_role_id: newOfficer,
      marketing_role_id: roles.marketing,
    });

    await applyRoles(guildId, 2, newOfficer, admin);
    const after = await db.query(
      `SELECT eboard_role_id FROM public.guild_config WHERE guild_id = $1`,
      [guildId],
    );
    expect(after.rows).toEqual([{ eboard_role_id: null }]);
  });

  it.each(["officer", "admin", "treasury"])(
    "rejects the guild ID (@everyone) as the %s role",
    async (which) => {
      const guildId = fakeId();
      const officer = which === "officer" ? guildId : fakeId();
      const admin = which === "admin" ? guildId : fakeId();
      const more = which === "treasury" ? { treasury: guildId } : {};
      expect(
        await errorCodeOf(applyRoles(guildId, 0, officer, admin, more)),
      ).toBe(CHECK_VIOLATION);
      expect(await configOf(guildId)).toBeUndefined();
    },
  );

  it.each([
    ["a version behind the row", true, 5],
    ["a second first-time setup", true, 0],
    ["a non-zero version with no config", false, 1],
    ["a null version", true, null],
  ])(
    "rejects %s as stale and changes nothing",
    async (_name, setUp, version) => {
      const guildId = setUp ? await setUpGuild() : fakeId();
      const before = await configOf(guildId);
      expect(
        await errorCodeOf(applyRoles(guildId, version, fakeId(), fakeId())),
      ).toBe(STALE_VERSION);
      expect(await configOf(guildId)).toEqual(before);
      expect(await auditRows(guildId)).toHaveLength(setUp ? 1 : 0);
    },
  );
});

describe("apply_config_change", () => {
  it("turns reminders off, bumps the version and audits old and new values", async () => {
    const guildId = await setUpGuild();
    const actor = fakeId();
    expect(await applyChange(guildId, 1, { reminders: false, actor })).toBe(2);
    expect((await configOf(guildId))?.reminders_enabled).toBe(false);
    expect((await auditRows(guildId))[1]).toEqual({
      actor_id: actor,
      action: "settings",
      old_values: {
        reminders_enabled: true,
        timezone: "America/New_York",
        active_channel_ids: [],
      },
      new_values: {
        reminders_enabled: false,
        timezone: "America/New_York",
        active_channel_ids: [],
        added_channel_ids: [],
        removed_channel_ids: [],
      },
      version_after: 2,
    });
  });

  it("adds, removes and re-adds a channel, keeping its row", async () => {
    const guildId = await setUpGuild();
    const channel = fakeId();
    await applyChange(guildId, 1, { add: [channel] });
    await applyChange(guildId, 2, { remove: [channel] });
    expect(await channelsOf(guildId)).toEqual([
      { channel_id: channel, status: "removed" },
    ]);
    expect(await applyChange(guildId, 3, { add: [channel] })).toBe(4);
    expect(await channelsOf(guildId)).toEqual([
      { channel_id: channel, status: "active" },
    ]);
  });

  it("allows adding 25 channels at once but not 26", async () => {
    const guildId = await setUpGuild();
    const channelIds = (count: number) =>
      Array.from({ length: count }, () => fakeId());
    expect(
      await errorCodeOf(applyChange(guildId, 1, { add: channelIds(26) })),
    ).toBe(INVALID_PARAMETER);
    expect((await configOf(guildId))?.version).toBe(1);
    expect(await applyChange(guildId, 1, { add: channelIds(25) })).toBe(2);
  });

  const channel = fakeId();
  it.each<[string, number, Change, string]>([
    ["no change", 1, {}, INVALID_PARAMETER],
    ["a stale version", 0, { add: [fakeId()] }, STALE_VERSION],
    ["an unknown timezone", 1, { timezone: "Mars/Phobos" }, INVALID_PARAMETER],
    ["a null channel", 1, { add: [null] }, INVALID_PARAMETER],
    [
      "a channel both added and removed",
      1,
      { add: [channel], remove: [channel] },
      INVALID_PARAMETER,
    ],
    [
      "a channel that cannot be removed",
      1,
      { add: [fakeId()], remove: [fakeId()] },
      INVALID_PARAMETER,
    ],
    ["an actor that is not an ID", 1, { actor: "nobody" }, CHECK_VIOLATION],
  ])(
    "rejects %s and rolls everything back",
    async (_name, expected, change, code) => {
      const guildId = await setUpGuild();
      expect(
        await errorCodeOf(
          applyChange(guildId, expected, {
            ...(Object.keys(change).length === 0 ? {} : { reminders: false }),
            ...change,
          }),
        ),
      ).toBe(code);
      expect(await configOf(guildId)).toEqual({
        version: 1,
        reminders_enabled: true,
        timezone: "America/New_York",
      });
      expect(await channelsOf(guildId)).toEqual([]);
      expect(await auditRows(guildId)).toHaveLength(1);
    },
  );

  it("rolls everything back if the audit row cannot be written", async () => {
    const guildId = await setUpGuild();
    await db.exec(`
      CREATE FUNCTION public.test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'audit unavailable' USING ERRCODE = 'XX999'; END; $$;
      CREATE TRIGGER test_fail_audit BEFORE INSERT ON public.config_audit
        FOR EACH ROW EXECUTE FUNCTION public.test_fail_audit();
    `);
    try {
      expect(
        await errorCodeOf(
          applyChange(guildId, 1, { reminders: false, add: [fakeId()] }),
        ),
      ).toBe("XX999");
    } finally {
      await db.exec(`
        DROP TRIGGER test_fail_audit ON public.config_audit;
        DROP FUNCTION public.test_fail_audit();
      `);
    }
    expect(await configOf(guildId)).toMatchObject({
      reminders_enabled: true,
      version: 1,
    });
    expect(await channelsOf(guildId)).toEqual([]);
  });
});

it("mark_channel_unavailable marks an active channel once, leaving the version and audit alone, until it is added again", async () => {
  const guildId = await setUpGuild();
  const channel = fakeId();
  await applyChange(guildId, 1, { add: [channel] });
  const mark = async () =>
    (
      await queryAs<{ marked: boolean }>(
        db,
        BOT_APP,
        `SELECT public.mark_channel_unavailable($1, $2) AS marked`,
        [guildId, channel],
      )
    )[0]?.marked;

  expect(await mark()).toBe(true);
  expect(await mark()).toBe(false);
  expect(await channelsOf(guildId)).toEqual([
    { channel_id: channel, status: "unavailable" },
  ]);
  expect((await configOf(guildId))?.version).toBe(2);
  expect(await auditRows(guildId)).toHaveLength(2);

  await applyChange(guildId, 2, { add: [channel] });
  expect((await channelsOf(guildId))[0]?.status).toBe("active");
});

it("other roles cannot call any of the three config functions", async () => {
  const guildId = await setUpGuild();
  for (const sql of [
    `SELECT public.apply_role_bindings('${guildId}', 1, '${fakeId()}', '${fakeId()}', '${fakeId()}', NULL, NULL, NULL, NULL)`,
    `SELECT public.apply_config_change('${guildId}', 1, '${fakeId()}', false)`,
    `SELECT public.mark_channel_unavailable('${guildId}', '${fakeId()}')`,
  ]) {
    expect(await errorCodeOf(queryAs(db, OTHER_ROLE, sql))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  }
});
