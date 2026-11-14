import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
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

interface AuditRow {
  actor_id: string;
  action: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown>;
  version_after: number;
}

describe("config functions", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  interface MoreRoles {
    eboard?: string | null;
    eventsCommittee?: string | null;
    treasury?: string | null;
    marketing?: string | null;
  }

  async function applyRoles(
    guildId: string,
    expected: number,
    officer: string,
    admin: string,
    actor: string = fakeId(),
    more: MoreRoles = {},
  ): Promise<number> {
    const rows = await queryAs<{ version: number }>(
      db,
      "bot_app",
      `SELECT public.apply_role_bindings($1, $2, $3, $4, $5, $6, $7, $8, $9) AS version`,
      [
        guildId,
        expected,
        actor,
        officer,
        admin,
        more.eboard ?? null,
        more.eventsCommittee ?? null,
        more.treasury ?? null,
        more.marketing ?? null,
      ],
    );
    return (rows[0] as { version: number }).version;
  }

  interface Change {
    reminders?: boolean;
    add?: (string | null)[];
    remove?: (string | null)[];
    actor?: string;
    timezone?: string;
  }

  async function applyChange(
    guildId: string,
    expected: number,
    change: Change,
  ): Promise<number> {
    const rows = await queryAs<{ version: number }>(
      db,
      "bot_app",
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
    return (rows[0] as { version: number }).version;
  }

  async function setUpGuild(): Promise<string> {
    const guildId = fakeId();
    await applyRoles(guildId, 0, fakeId(), fakeId());
    return guildId;
  }

  async function auditRows(guildId: string): Promise<AuditRow[]> {
    const { rows } = await db.query<AuditRow>(
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
      officer_role_id: string;
      timezone: string;
    }>(
      `SELECT version, reminders_enabled, officer_role_id, timezone FROM public.guild_config WHERE guild_id = $1`,
      [guildId],
    );
    return rows[0];
  }

  /** Makes every audit insert fail while `run` executes, to prove the config write rolls back with it. */
  async function withFailingAudit(
    run: () => Promise<unknown>,
  ): Promise<string | undefined> {
    await db.exec(`
      CREATE FUNCTION public.test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'audit unavailable' USING ERRCODE = 'XX999'; END; $$;
      CREATE TRIGGER test_fail_audit BEFORE INSERT ON public.config_audit
        FOR EACH ROW EXECUTE FUNCTION public.test_fail_audit();
    `);
    try {
      return await errorCodeOf(run());
    } finally {
      await db.exec(`
        DROP TRIGGER test_fail_audit ON public.config_audit;
        DROP FUNCTION public.test_fail_audit();
      `);
    }
  }

  describe("apply_role_bindings", () => {
    it("creates the config on first setup and audits it", async () => {
      const guildId = fakeId();
      const officer = fakeId();
      const admin = fakeId();
      const actor = fakeId();

      expect(await applyRoles(guildId, 0, officer, admin, actor)).toBe(1);

      expect(await auditRows(guildId)).toEqual([
        {
          actor_id: actor,
          action: "role_bindings",
          old_values: null,
          new_values: {
            officer_role_id: officer,
            admin_role_id: admin,
            eboard_role_id: null,
            events_committee_role_id: null,
            treasury_role_id: null,
            marketing_role_id: null,
          },
          version_after: 1,
        },
      ]);
    });

    it("rebinds every role, records the old values, and unbinds on null", async () => {
      const guildId = fakeId();
      const oldOfficer = fakeId();
      const oldAdmin = fakeId();
      const newOfficer = fakeId();
      const roles = {
        eboard: fakeId(),
        eventsCommittee: fakeId(),
        treasury: fakeId(),
        marketing: fakeId(),
      };
      await applyRoles(guildId, 0, oldOfficer, oldAdmin);

      expect(
        await applyRoles(guildId, 1, newOfficer, oldAdmin, fakeId(), roles),
      ).toBe(2);

      const { rows } = await db.query(
        `SELECT officer_role_id, eboard_role_id, events_committee_role_id,
                treasury_role_id, marketing_role_id
         FROM public.guild_config WHERE guild_id = $1`,
        [guildId],
      );
      expect(rows).toEqual([
        {
          officer_role_id: newOfficer,
          eboard_role_id: roles.eboard,
          events_committee_role_id: roles.eventsCommittee,
          treasury_role_id: roles.treasury,
          marketing_role_id: roles.marketing,
        },
      ]);
      const audit = await auditRows(guildId);
      expect(audit[1]?.old_values).toEqual({
        officer_role_id: oldOfficer,
        admin_role_id: oldAdmin,
        eboard_role_id: null,
        events_committee_role_id: null,
        treasury_role_id: null,
        marketing_role_id: null,
      });
      expect(audit[1]?.new_values).toMatchObject({
        officer_role_id: newOfficer,
        eboard_role_id: roles.eboard,
        marketing_role_id: roles.marketing,
      });
      expect(audit[1]?.version_after).toBe(2);

      await applyRoles(guildId, 2, newOfficer, oldAdmin);
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
          await errorCodeOf(
            applyRoles(guildId, 0, officer, admin, fakeId(), more),
          ),
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

        const code = await errorCodeOf(
          queryAs(
            db,
            "bot_app",
            `SELECT public.apply_role_bindings($1, $2, $3, $4, $5, NULL, NULL, NULL, NULL)`,
            [guildId, version, fakeId(), fakeId(), fakeId()],
          ),
        );

        expect(code).toBe(STALE_VERSION);
        expect(await configOf(guildId)).toEqual(before);
        expect(await auditRows(guildId)).toHaveLength(setUp ? 1 : 0);
      },
    );
  });

  describe("apply_config_change", () => {
    const activeChannels = async (guildId: string) => {
      const { rows } = await db.query<{ channel_id: string; status: string }>(
        `SELECT channel_id, status FROM public.managed_channels WHERE guild_id = $1 ORDER BY channel_id`,
        [guildId],
      );
      return rows;
    };

    it("turns reminders off, bumps the version and audits old and new values", async () => {
      const guildId = await setUpGuild();
      const actor = fakeId();

      expect(await applyChange(guildId, 1, { reminders: false, actor })).toBe(
        2,
      );

      expect((await configOf(guildId))?.reminders_enabled).toBe(false);
      const audit = await auditRows(guildId);
      expect(audit[1]).toEqual({
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
      expect(await activeChannels(guildId)).toEqual([
        { channel_id: channel, status: "removed" },
      ]);

      expect(await applyChange(guildId, 3, { add: [channel] })).toBe(4);
      expect(await activeChannels(guildId)).toEqual([
        { channel_id: channel, status: "active" },
      ]);
    });

    it("allows adding 25 channels at once but not 26", async () => {
      const guildId = await setUpGuild();
      const channelIds = (count: number) =>
        Array.from({ length: count }, () => fakeId());

      const code = await errorCodeOf(
        applyChange(guildId, 1, { add: channelIds(26) }),
      );

      expect(code).toBe(INVALID_PARAMETER);
      expect((await configOf(guildId))?.version).toBe(1);
      expect(await applyChange(guildId, 1, { add: channelIds(25) })).toBe(2);
    });

    it("rejects a stale version and changes nothing", async () => {
      const guildId = await setUpGuild();
      await applyChange(guildId, 1, { reminders: false });

      // A second open panel still holds version 1.
      const code = await errorCodeOf(
        applyChange(guildId, 1, { reminders: true, add: [fakeId()] }),
      );

      expect(code).toBe(STALE_VERSION);
      const config = await configOf(guildId);
      expect(config?.reminders_enabled).toBe(false);
      expect(config?.version).toBe(2);
      expect(await activeChannels(guildId)).toEqual([]);
      expect(await auditRows(guildId)).toHaveLength(2);
    });

    const channel = fakeId();
    it.each<[string, Change, string]>([
      ["no change", {}, INVALID_PARAMETER],
      ["an unknown timezone", { timezone: "Mars/Phobos" }, INVALID_PARAMETER],
      ["a null channel", { add: [null] }, INVALID_PARAMETER],
      [
        "a channel both added and removed",
        { add: [channel], remove: [channel] },
        INVALID_PARAMETER,
      ],
      [
        "a channel that cannot be removed",
        { add: [fakeId()], remove: [fakeId()] },
        INVALID_PARAMETER,
      ],
      ["an actor that is not an ID", { actor: "nobody" }, CHECK_VIOLATION],
    ])("rejects %s and rolls everything back", async (_name, change, code) => {
      const guildId = await setUpGuild();

      expect(
        await errorCodeOf(
          applyChange(guildId, 1, {
            ...(Object.keys(change).length === 0 ? {} : { reminders: false }),
            ...change,
          }),
        ),
      ).toBe(code);

      const config = await configOf(guildId);
      expect(config?.version).toBe(1);
      expect(config?.reminders_enabled).toBe(true);
      expect(config?.timezone).toBe("America/New_York");
      expect(await activeChannels(guildId)).toEqual([]);
    });

    it("rolls everything back if the audit row cannot be written", async () => {
      const guildId = await setUpGuild();
      const code = await withFailingAudit(() =>
        applyChange(guildId, 1, { reminders: false, add: [fakeId()] }),
      );

      expect(code).toBe("XX999");
      const config = await configOf(guildId);
      expect(config?.reminders_enabled).toBe(true);
      expect(config?.version).toBe(1);
      expect(await activeChannels(guildId)).toEqual([]);
    });
  });

  describe("mark_channel_unavailable", () => {
    const mark = async (guildId: string, channelId: string) => {
      const rows = await queryAs<{ marked: boolean }>(
        db,
        "bot_app",
        `SELECT public.mark_channel_unavailable($1, $2) AS marked`,
        [guildId, channelId],
      );
      return rows[0]?.marked;
    };

    const statusOf = async (channelId: string) => {
      const { rows } = await db.query<{ status: string }>(
        `SELECT status FROM public.managed_channels WHERE channel_id = $1`,
        [channelId],
      );
      return rows[0]?.status;
    };

    it("marks an active channel, leaving the version and audit alone, until it is added again", async () => {
      const guildId = await setUpGuild();
      const channel = fakeId();
      await applyChange(guildId, 1, { add: [channel] });

      expect(await mark(guildId, channel)).toBe(true);

      expect(await statusOf(channel)).toBe("unavailable");
      expect((await configOf(guildId))?.version).toBe(2);
      expect(await auditRows(guildId)).toHaveLength(2);

      await applyChange(guildId, 2, { add: [channel] });
      expect(await statusOf(channel)).toBe("active");
    });

    it("records each call in job_runs, including one that changed nothing", async () => {
      const guildId = await setUpGuild();
      const channel = fakeId();
      await applyChange(guildId, 1, { add: [channel] });

      await mark(guildId, channel);
      expect(await mark(guildId, channel)).toBe(false);

      const { rows } = await db.query(
        `SELECT job_name, status, finished_at IS NOT NULL AS finished, results->>'changed' AS changed
         FROM public.job_runs
         WHERE job_name = 'mark_channel_unavailable' AND results->>'channel_id' = $1
         ORDER BY changed DESC`,
        [channel],
      );
      expect(rows).toEqual([
        {
          job_name: "mark_channel_unavailable",
          status: "succeeded",
          finished: true,
          changed: "true",
        },
        {
          job_name: "mark_channel_unavailable",
          status: "succeeded",
          finished: true,
          changed: "false",
        },
      ]);
    });
  });

  describe("execution rights", () => {
    it("other roles cannot call any of the three", async () => {
      const role = OTHER_ROLE;
      const guildId = await setUpGuild();
      for (const sql of [
        `SELECT public.apply_role_bindings('${guildId}', 1, '${fakeId()}', '${fakeId()}', '${fakeId()}', NULL, NULL, NULL, NULL)`,
        `SELECT public.apply_config_change('${guildId}', 1, '${fakeId()}', false)`,
        `SELECT public.mark_channel_unavailable('${guildId}', '${fakeId()}')`,
      ]) {
        expect(await errorCodeOf(queryAs(db, role, sql))).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      }
    });

    it("all three are SECURITY DEFINER with an empty search_path", async () => {
      const { rows } = await db.query(
        `SELECT proname, prosecdef, proconfig FROM pg_proc
         WHERE proname IN ('apply_role_bindings', 'apply_config_change', 'mark_channel_unavailable')
         ORDER BY proname`,
      );
      expect(rows).toEqual([
        {
          proname: "apply_config_change",
          prosecdef: true,
          proconfig: ['search_path=""'],
        },
        {
          proname: "apply_role_bindings",
          prosecdef: true,
          proconfig: ['search_path=""'],
        },
        {
          proname: "mark_channel_unavailable",
          prosecdef: true,
          proconfig: ['search_path=""'],
        },
      ]);
    });
  });
});
