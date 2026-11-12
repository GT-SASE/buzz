import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

    it("binds the four workflow roles, and audits them", async () => {
      const guildId = fakeId();
      const roles = {
        eboard: fakeId(),
        eventsCommittee: fakeId(),
        treasury: fakeId(),
        marketing: fakeId(),
      };
      await applyRoles(guildId, 0, fakeId(), fakeId());

      expect(
        await applyRoles(guildId, 1, fakeId(), fakeId(), fakeId(), roles),
      ).toBe(2);

      const { rows } = await db.query(
        `SELECT eboard_role_id, events_committee_role_id, treasury_role_id, marketing_role_id
         FROM public.guild_config WHERE guild_id = $1`,
        [guildId],
      );
      expect(rows).toEqual([
        {
          eboard_role_id: roles.eboard,
          events_committee_role_id: roles.eventsCommittee,
          treasury_role_id: roles.treasury,
          marketing_role_id: roles.marketing,
        },
      ]);
      const audit = await auditRows(guildId);
      expect(audit[1]?.old_values).toMatchObject({
        eboard_role_id: null,
        treasury_role_id: null,
      });
      expect(audit[1]?.new_values).toMatchObject({
        eboard_role_id: roles.eboard,
        events_committee_role_id: roles.eventsCommittee,
        treasury_role_id: roles.treasury,
        marketing_role_id: roles.marketing,
      });

      // A null unbinds the role again.
      await applyRoles(guildId, 2, fakeId(), fakeId());
      const after = await db.query(
        `SELECT eboard_role_id FROM public.guild_config WHERE guild_id = $1`,
        [guildId],
      );
      expect(after.rows).toEqual([{ eboard_role_id: null }]);
    });

    it.each(["eboard", "eventsCommittee", "treasury", "marketing"] as const)(
      "rejects the guild ID (@everyone) as the %s role",
      async (which) => {
        const guildId = fakeId();
        expect(
          await errorCodeOf(
            applyRoles(guildId, 0, fakeId(), fakeId(), fakeId(), {
              [which]: guildId,
            }),
          ),
        ).toBe(CHECK_VIOLATION);
        expect(await configOf(guildId)).toBeUndefined();
      },
    );

    it("has a single signature, with no five-argument version left", async () => {
      const { rows } = await db.query<{ args: string }>(
        `SELECT pg_get_function_identity_arguments(oid) AS args
         FROM pg_proc WHERE proname = 'apply_role_bindings'`,
      );
      expect(rows.map((row) => row.args.split(", ").length)).toEqual([9]);
    });

    it("changes the roles, bumps the version and records the old values", async () => {
      const guildId = fakeId();
      const oldOfficer = fakeId();
      const oldAdmin = fakeId();
      const newOfficer = fakeId();
      await applyRoles(guildId, 0, oldOfficer, oldAdmin);

      expect(await applyRoles(guildId, 1, newOfficer, oldAdmin)).toBe(2);

      expect((await configOf(guildId))?.officer_role_id).toBe(newOfficer);
      const audit = await auditRows(guildId);
      expect(audit).toHaveLength(2);
      expect(audit[1]?.old_values).toEqual({
        officer_role_id: oldOfficer,
        admin_role_id: oldAdmin,
        eboard_role_id: null,
        events_committee_role_id: null,
        treasury_role_id: null,
        marketing_role_id: null,
      });
      expect(audit[1]?.version_after).toBe(2);
    });

    it("rejects a stale version and changes nothing", async () => {
      const guildId = await setUpGuild();
      const before = await configOf(guildId);

      const code = await errorCodeOf(
        applyRoles(guildId, 5, fakeId(), fakeId()),
      );

      expect(code).toBe(STALE_VERSION);
      expect(await configOf(guildId)).toEqual(before);
      expect(await auditRows(guildId)).toHaveLength(1);
    });

    it("rejects a second first-time setup", async () => {
      const guildId = await setUpGuild();
      expect(
        await errorCodeOf(applyRoles(guildId, 0, fakeId(), fakeId())),
      ).toBe(STALE_VERSION);
    });

    it("rejects a non-zero version when no config exists", async () => {
      const guildId = fakeId();
      expect(
        await errorCodeOf(applyRoles(guildId, 1, fakeId(), fakeId())),
      ).toBe(STALE_VERSION);
      expect(await configOf(guildId)).toBeUndefined();
    });

    it("rejects a null version", async () => {
      const guildId = await setUpGuild();
      const code = await errorCodeOf(
        queryAs(
          db,
          "bot_app",
          `SELECT public.apply_role_bindings($1, NULL, $2, $3, $4, NULL, NULL, NULL, NULL)`,
          [guildId, fakeId(), fakeId(), fakeId()],
        ),
      );
      expect(code).toBe(STALE_VERSION);
    });

    it.each(["officer", "admin"])(
      "rejects the guild ID (@everyone) as the %s role",
      async (which) => {
        const guildId = fakeId();
        const officer = which === "officer" ? guildId : fakeId();
        const admin = which === "admin" ? guildId : fakeId();

        expect(await errorCodeOf(applyRoles(guildId, 0, officer, admin))).toBe(
          CHECK_VIOLATION,
        );
        expect(await configOf(guildId)).toBeUndefined();
      },
    );

    // PGlite has one connection, so a test-only trigger stands in for the other session:
    // it creates the row after the function's first read found none. The two-connection
    // version of this race runs against real Postgres in test/db-concurrency.
    it("reports a first setup that loses the race as a stale version", async () => {
      const guildId = fakeId();
      await db.exec(`
        CREATE FUNCTION public.test_lose_race() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF pg_trigger_depth() = 1 THEN
            INSERT INTO public.guild_config (guild_id, officer_role_id, admin_role_id)
            VALUES (NEW.guild_id, NEW.officer_role_id, NEW.admin_role_id);
          END IF;
          RETURN NEW;
        END; $$;
        CREATE TRIGGER test_lose_race BEFORE INSERT ON public.guild_config
          FOR EACH ROW EXECUTE FUNCTION public.test_lose_race();
      `);
      try {
        expect(
          await errorCodeOf(applyRoles(guildId, 0, fakeId(), fakeId())),
        ).toBe(STALE_VERSION);
      } finally {
        await db.exec(`
          DROP TRIGGER test_lose_race ON public.guild_config;
          DROP FUNCTION public.test_lose_race();
        `);
      }
    });

    it("rolls the role change back if the audit row cannot be written", async () => {
      const guildId = await setUpGuild();
      const before = await configOf(guildId);

      const code = await withFailingAudit(() =>
        applyRoles(guildId, 1, fakeId(), fakeId()),
      );

      expect(code).toBe("XX999");
      expect(await configOf(guildId)).toEqual(before);
    });

    it("rolls first setup back if the audit row cannot be written", async () => {
      const guildId = fakeId();
      const code = await withFailingAudit(() =>
        applyRoles(guildId, 0, fakeId(), fakeId()),
      );
      expect(code).toBe("XX999");
      expect(await configOf(guildId)).toBeUndefined();
    });
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

    it("changes the timezone and audits old and new values", async () => {
      const guildId = await setUpGuild();

      expect(await applyChange(guildId, 1, { timezone: "Europe/London" })).toBe(
        2,
      );

      expect((await configOf(guildId))?.timezone).toBe("Europe/London");
      const audit = await auditRows(guildId);
      expect(audit[1]?.old_values?.timezone).toBe("America/New_York");
      expect(audit[1]?.new_values.timezone).toBe("Europe/London");
    });

    it("leaves the timezone alone when it is not given", async () => {
      const guildId = await setUpGuild();
      await applyChange(guildId, 1, { timezone: "Europe/London" });
      await applyChange(guildId, 2, { reminders: false });
      expect((await configOf(guildId))?.timezone).toBe("Europe/London");
    });

    it.each(["Mars/Phobos", "america/new_york", "; DROP TABLE tasks"])(
      "rejects the timezone %s and changes nothing",
      async (timezone) => {
        const guildId = await setUpGuild();
        const code = await errorCodeOf(
          applyChange(guildId, 1, { reminders: false, timezone }),
        );

        expect(code).toBe(INVALID_PARAMETER);
        const config = await configOf(guildId);
        expect(config?.version).toBe(1);
        expect(config?.reminders_enabled).toBe(true);
        expect(config?.timezone).toBe("America/New_York");
      },
    );

    const channelIds = (count: number) =>
      Array.from({ length: count }, () => fakeId());

    it("allows adding 25 channels at once but not 26", async () => {
      const guildId = await setUpGuild();

      const code = await errorCodeOf(
        applyChange(guildId, 1, { add: channelIds(26) }),
      );

      expect(code).toBe(INVALID_PARAMETER);
      expect((await configOf(guildId))?.version).toBe(1);
      expect(await applyChange(guildId, 1, { add: channelIds(25) })).toBe(2);
    });

    it("allows removing 25 channels at once but not 26", async () => {
      const guildId = await setUpGuild();
      const channels = channelIds(26);
      await applyChange(guildId, 1, { add: channels.slice(0, 25) });
      await applyChange(guildId, 2, { add: channels.slice(25) });

      const code = await errorCodeOf(
        applyChange(guildId, 3, { remove: channels }),
      );

      expect(code).toBe(INVALID_PARAMETER);
      expect((await configOf(guildId))?.version).toBe(3);
      expect(
        await applyChange(guildId, 3, { remove: channels.slice(0, 25) }),
      ).toBe(4);
    });

    it("treats a channel listed twice as one", async () => {
      const guildId = await setUpGuild();
      const channel = fakeId();

      expect(await applyChange(guildId, 1, { add: [channel, channel] })).toBe(
        2,
      );

      expect(await activeChannels(guildId)).toEqual([
        { channel_id: channel, status: "active" },
      ]);
    });

    it("removes a channel listed twice", async () => {
      const guildId = await setUpGuild();
      const channel = fakeId();
      await applyChange(guildId, 1, { add: [channel] });
      expect(
        await applyChange(guildId, 2, { remove: [channel, channel] }),
      ).toBe(3);
    });

    it.each([
      ["add", { add: [null] }],
      ["remove", { remove: [null] }],
    ])(
      "rejects a null element in the %s list and changes nothing",
      async (_name, list) => {
        const guildId = await setUpGuild();
        const code = await errorCodeOf(
          applyChange(guildId, 1, { reminders: false, ...list }),
        );

        expect(code).toBe(INVALID_PARAMETER);
        expect((await configOf(guildId))?.version).toBe(1);
      },
    );

    it("names the forums it added and removed in the audit row", async () => {
      const guildId = await setUpGuild();
      const [first, second] = [fakeId(), fakeId()].sort() as [string, string];

      await applyChange(guildId, 1, { add: [second, first, second] });
      // Adding one that is already active changes nothing, so it isn't recorded.
      await applyChange(guildId, 2, { add: [first] });
      await applyChange(guildId, 3, { remove: [first] });

      const audit = await auditRows(guildId);
      expect(audit[1]?.new_values).toMatchObject({
        added_channel_ids: [first, second],
        removed_channel_ids: [],
      });
      expect(audit[2]?.new_values).toMatchObject({
        added_channel_ids: [],
        removed_channel_ids: [],
      });
      expect(audit[3]?.new_values).toMatchObject({
        added_channel_ids: [],
        removed_channel_ids: [first],
      });
    });

    it("records the removal of a forum that was already unavailable", async () => {
      const guildId = await setUpGuild();
      const channel = fakeId();
      await applyChange(guildId, 1, { add: [channel] });
      await queryAs(
        db,
        "bot_app",
        `SELECT public.mark_channel_unavailable($1, $2)`,
        [guildId, channel],
      );

      await applyChange(guildId, 2, { remove: [channel] });

      const row = (await auditRows(guildId))[2];
      expect(row?.old_values).toMatchObject({ active_channel_ids: [] });
      expect(row?.new_values).toMatchObject({
        active_channel_ids: [],
        removed_channel_ids: [channel],
      });
    });

    it("adds, removes and re-adds a channel, keeping its row", async () => {
      const guildId = await setUpGuild();
      const channel = fakeId();

      await applyChange(guildId, 1, { add: [channel] });
      expect(await activeChannels(guildId)).toEqual([
        { channel_id: channel, status: "active" },
      ]);

      await applyChange(guildId, 2, { remove: [channel] });
      expect(await activeChannels(guildId)).toEqual([
        { channel_id: channel, status: "removed" },
      ]);

      expect(await applyChange(guildId, 3, { add: [channel] })).toBe(4);
      expect(await activeChannels(guildId)).toEqual([
        { channel_id: channel, status: "active" },
      ]);
      expect(
        (await auditRows(guildId))[3]?.new_values.active_channel_ids,
      ).toEqual([channel]);
    });

    it("leaves reminders alone when only channels change", async () => {
      const guildId = await setUpGuild();
      await applyChange(guildId, 1, { reminders: false });
      await applyChange(guildId, 2, { add: [fakeId()] });
      expect((await configOf(guildId))?.reminders_enabled).toBe(false);
    });

    it("rejects a stale version and changes nothing", async () => {
      const guildId = await setUpGuild();
      const channel = fakeId();
      await applyChange(guildId, 1, { reminders: false });

      // A second open panel still holds version 1.
      const code = await errorCodeOf(
        applyChange(guildId, 1, { reminders: true, add: [channel] }),
      );

      expect(code).toBe(STALE_VERSION);
      const config = await configOf(guildId);
      expect(config?.reminders_enabled).toBe(false);
      expect(config?.version).toBe(2);
      expect(await activeChannels(guildId)).toEqual([]);
      expect(await auditRows(guildId)).toHaveLength(2);
    });

    it("rejects a guild that has not been set up", async () => {
      expect(
        await errorCodeOf(applyChange(fakeId(), 0, { reminders: false })),
      ).toBe(STALE_VERSION);
    });

    it("rejects a call with no change", async () => {
      const guildId = await setUpGuild();
      expect(await errorCodeOf(applyChange(guildId, 1, {}))).toBe(
        INVALID_PARAMETER,
      );
    });

    it("rejects a channel both added and removed", async () => {
      const guildId = await setUpGuild();
      const channel = fakeId();
      expect(
        await errorCodeOf(
          applyChange(guildId, 1, { add: [channel], remove: [channel] }),
        ),
      ).toBe(INVALID_PARAMETER);
    });

    it("rolls everything back when one channel cannot be removed", async () => {
      const guildId = await setUpGuild();
      const code = await errorCodeOf(
        applyChange(guildId, 1, {
          reminders: false,
          add: [fakeId()],
          remove: [fakeId()],
        }),
      );

      expect(code).toBe(INVALID_PARAMETER);
      const config = await configOf(guildId);
      expect(config?.reminders_enabled).toBe(true);
      expect(config?.version).toBe(1);
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

    it("rolls everything back if the actor is not a valid ID", async () => {
      const guildId = await setUpGuild();
      const code = await errorCodeOf(
        applyChange(guildId, 1, { reminders: false, actor: "nobody" }),
      );

      expect(code).toBe(CHECK_VIOLATION);
      expect((await configOf(guildId))?.version).toBe(1);
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

    it("marks an active channel and leaves the version and audit alone", async () => {
      const guildId = await setUpGuild();
      const channel = fakeId();
      await applyChange(guildId, 1, { add: [channel] });

      expect(await mark(guildId, channel)).toBe(true);

      expect(await statusOf(channel)).toBe("unavailable");
      expect((await configOf(guildId))?.version).toBe(2);
      expect(await auditRows(guildId)).toHaveLength(2);
    });

    const callsFor = async (channelId: string) => {
      const { rows } = await db.query(
        `SELECT job_name, status, finished_at IS NOT NULL AS finished, results->>'changed' AS changed
         FROM public.job_runs
         WHERE job_name = 'mark_channel_unavailable' AND results->>'channel_id' = $1
         ORDER BY changed DESC`,
        [channelId],
      );
      return rows;
    };

    it("records each call in job_runs, including one that changed nothing", async () => {
      const guildId = await setUpGuild();
      const channel = fakeId();
      await applyChange(guildId, 1, { add: [channel] });

      await mark(guildId, channel);
      await mark(guildId, channel);

      const calls = await callsFor(channel);
      expect(calls).toHaveLength(2);
      expect(
        calls.map((call) => (call as { changed: string }).changed),
      ).toEqual(["true", "false"]);
      expect(calls[0]).toMatchObject({
        job_name: "mark_channel_unavailable",
        status: "succeeded",
        finished: true,
      });
    });

    it("records a call for a channel it does not know", async () => {
      const channel = fakeId();
      expect(await mark(await setUpGuild(), channel)).toBe(false);
      expect(await callsFor(channel)).toHaveLength(1);
    });

    it("does nothing to a removed channel", async () => {
      const guildId = await setUpGuild();
      const channel = fakeId();
      await applyChange(guildId, 1, { add: [channel] });
      await applyChange(guildId, 2, { remove: [channel] });

      expect(await mark(guildId, channel)).toBe(false);
      expect(await statusOf(channel)).toBe("removed");
    });

    it("an admin can bring it back by adding it again", async () => {
      const guildId = await setUpGuild();
      const channel = fakeId();
      await applyChange(guildId, 1, { add: [channel] });
      await mark(guildId, channel);
      await applyChange(guildId, 2, { add: [channel] });
      expect(await statusOf(channel)).toBe("active");
    });
  });

  describe("execution rights", () => {
    it.each([OTHER_ROLE])("%s cannot call either function", async (role) => {
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
