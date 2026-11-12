/**
 * The event workflow at the SQL level: what the access layer cannot reach, such as the
 * history rows, the functions the bot's role may not call, and the
 * refusals a well-behaved caller never triggers. test/db/access-layer.test.ts covers the
 * ordinary paths through src/db/event-steps.ts.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayInZone } from "../../src/lib/dates.ts";
import {
  insertEvent,
  insertGuild,
  type WorkflowGuildFixture,
} from "./fixtures.ts";
import {
  INSUFFICIENT_PRIVILEGE,
  MIGRATION_OWNER,
  OTHER_ROLE,
  createMigratedDb,
  errorCodeOf,
  fakeId,
  queryAs,
} from "./harness.ts";

const INVALID_PARAMETER = "22023";
const CHECK_VIOLATION = "23514";
const KINDS = ["budget_sheet", "engage_post", "budget_approved", "food_pickup"];

describe("the event workflow functions", () => {
  let db: PGlite;
  let guild: WorkflowGuildFixture;

  beforeAll(async () => {
    db = await createMigratedDb();
    guild = await insertGuild(db);
  });

  afterAll(async () => {
    await db.close();
  });

  const call = <Row = Record<string, unknown>>(
    sql: string,
    params: unknown[],
  ) => queryAs<Row>(db, "bot_app", sql, params);
  const value = async (sql: string, params: unknown[]): Promise<unknown> => {
    const rows = await call<{ value: unknown }>(
      `SELECT ${sql} AS value`,
      params,
    );
    return rows[0]?.value;
  };

  it("makes the steps for a new event in the same insert", async () => {
    const eventId = await insertEvent(db, guild);
    const { rows } = await db.query(
      `SELECT kind::text AS kind, status::text AS status, guild_id
       FROM public.event_steps AS step WHERE event_id = $1 ORDER BY step.kind`,
      [eventId],
    );
    expect(rows).toEqual(
      KINDS.map((kind) => ({ kind, status: "open", guild_id: guild.guildId })),
    );
  });

  it.each([
    [
      "assign Budget approved",
      `public.assign_event_step($1, $2, 'budget_approved', $3, $3)`,
    ],
    [
      "unassign Budget approved",
      `public.unassign_event_step($1, $2, 'budget_approved', $3, $3)`,
    ],
    [
      "complete Food pickup",
      `public.complete_event_step($1, $2, 'food_pickup', $3)`,
    ],
    [
      "hand off Food pickup",
      `public.claim_step_handoff($1, $2, 'food_pickup') AND $3::text IS NOT NULL`,
    ],
    ["a null pickup time", `public.set_event_pickup_time($1, $2, NULL, $3)`],
  ])("refuses to %s", async (_name, sql) => {
    const eventId = await insertEvent(db, guild);
    expect(
      await errorCodeOf(value(sql, [eventId, guild.guildId, fakeId()])),
    ).toBe(INVALID_PARAMETER);
  });

  it("cannot be steered to another guild's event by its ID alone", async () => {
    const eventId = await insertEvent(db, guild);
    const other = await insertGuild(db);
    const actor = fakeId();
    for (const sql of [
      `public.assign_event_step($1, $2, 'budget_sheet', $3, $3)`,
      `public.unassign_event_step($1, $2, 'budget_sheet', $3, $3)`,
      `public.complete_event_step($1, $2, 'budget_sheet', $3)`,
      `public.set_event_pickup_time($1, $2, '12:00', $3)`,
    ]) {
      expect(await value(sql, [eventId, other.guildId, actor])).toBeNull();
    }
    expect(
      await value(`public.claim_step_handoff($1, $2, 'budget_sheet')`, [
        eventId,
        other.guildId,
      ]),
    ).toBe(false);
    const { rows } = await db.query(
      `SELECT count(*)::int AS count FROM public.event_steps
       WHERE event_id = $1 AND status = 'done'`,
      [eventId],
    );
    expect(rows).toEqual([{ count: 0 }]);
  });

  it("does not hand off a step of a deleted event", async () => {
    const eventId = await insertEvent(db, guild);
    await value(`public.complete_event_step($1, $2, 'engage_post', $3)`, [
      eventId,
      guild.guildId,
      fakeId(),
    ]);
    await value(`public.soft_delete_event($1, $2)`, [eventId, guild.guildId]);
    expect(
      await value(`public.claim_step_handoff($1, $2, 'engage_post')`, [
        eventId,
        guild.guildId,
      ]),
    ).toBe(false);
  });

  it("records the old step and assignment rows in history", async () => {
    const eventId = await insertEvent(db, guild);
    const user = fakeId();
    await value(`public.assign_event_step($1, $2, 'budget_sheet', $3, $3)`, [
      eventId,
      guild.guildId,
      user,
    ]);
    await value(`public.unassign_event_step($1, $2, 'budget_sheet', $3, $3)`, [
      eventId,
      guild.guildId,
      user,
    ]);
    await value(`public.complete_event_step($1, $2, 'budget_sheet', $3)`, [
      eventId,
      guild.guildId,
      user,
    ]);

    const { rows } = await db.query<{
      source_table: string;
      row_id: string;
      status: string | null;
    }>(
      `SELECT source_table, row_id, old_row ->> 'status' AS status
       FROM history.row_versions
       WHERE source_table IN ('event_steps', 'event_step_assignees')
         AND old_row ->> 'event_id' = $1
       ORDER BY id`,
      [eventId],
    );
    expect(rows).toEqual([
      {
        source_table: "event_step_assignees",
        row_id: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
        status: null,
      },
      {
        source_table: "event_steps",
        row_id: `${eventId}:budget_sheet`,
        status: "open",
      },
    ]);
  });

  it.each([
    "public.create_event_steps()",
    `public.sync_food_pickup_step('${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}', '1')`,
    `public.event_reminder_allowed('${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}', 'daily_steps', '2030-01-01')`,
  ])("does not let bot_app call %s", async (sql) => {
    expect(await errorCodeOf(queryAs(db, "bot_app", `SELECT ${sql}`))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it.each([OTHER_ROLE])(
    "does not let %s call any of the writers",
    async (role) => {
      const eventId = await insertEvent(db, guild);
      for (const sql of [
        `SELECT public.assign_event_step('${eventId}', '${guild.guildId}', 'budget_sheet', '${fakeId()}', '${fakeId()}')`,
        `SELECT public.complete_event_step('${eventId}', '${guild.guildId}', 'budget_sheet', '${fakeId()}')`,
        `SELECT public.claim_event_reminder('${eventId}', 'daily_steps', '2030-01-15')`,
        `SELECT public.save_setup_draft('${guild.guildId}', '${fakeId()}', '${fakeId()}', '${fakeId()}', '${fakeId()}', '${fakeId()}', '${fakeId()}', '${fakeId()}', 'abcdefgh12345678')`,
      ]) {
        expect(await errorCodeOf(queryAs(db, role, sql))).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      }
    },
  );

  describe("setup drafts", () => {
    const save = (guildId: string, roles: string[], fingerprint: string) =>
      value(`public.save_setup_draft($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
        guildId,
        fakeId(),
        ...roles,
        fingerprint,
      ]);
    const six = () => Array.from({ length: 6 }, () => fakeId());

    it("replaces the guild's draft and restarts its hour", async () => {
      const guildId = fakeId();
      expect(await save(guildId, six(), "abcdefgh12345678")).toBe(true);
      await db.query(
        `UPDATE public.setup_drafts SET created_at = now() - interval '2 hours'
         WHERE guild_id = $1`,
        [guildId],
      );
      const roles = six();
      expect(await save(guildId, roles, "ABCDEFGH-_345678")).toBe(true);
      const { rows } = await db.query(
        `SELECT treasury_role_id, fingerprint, created_at > now() - interval '1 minute' AS fresh
         FROM public.setup_drafts WHERE guild_id = $1`,
        [guildId],
      );
      expect(rows).toEqual([
        {
          treasury_role_id: roles[4],
          fingerprint: "ABCDEFGH-_345678",
          fresh: true,
        },
      ]);
    });

    it.each([0, 1, 2, 3, 4, 5])(
      "refuses the guild ID (@everyone) as role %i",
      async (position) => {
        const guildId = fakeId();
        const roles = six();
        roles[position] = guildId;
        expect(
          await errorCodeOf(save(guildId, roles, "abcdefgh12345678")),
        ).toBe(CHECK_VIOLATION);
      },
    );

    it.each(["short", "has space 123456", "x".repeat(65), "comma,123456789"])(
      "refuses the fingerprint %j",
      async (fingerprint) => {
        expect(await errorCodeOf(save(fakeId(), six(), fingerprint))).toBe(
          CHECK_VIOLATION,
        );
      },
    );
  });

  it("keeps the step and log rows consistent whatever the owner writes", async () => {
    const eventId = await insertEvent(db, guild);
    for (const sql of [
      `UPDATE public.event_steps SET status = 'done' WHERE event_id = $1 AND kind = 'budget_sheet'`,
      `UPDATE public.event_steps SET handoff_claimed_at = now() WHERE event_id = $1 AND kind = 'engage_post'`,
      `INSERT INTO public.event_step_assignees (event_id, guild_id, kind, user_id, assigned_by)
       SELECT $1, guild_id, 'budget_approved', guild_id, guild_id FROM public.events WHERE id = $1`,
      `INSERT INTO public.event_reminder_log (event_id, kind, reminder_date, state)
       VALUES ($1, 'daily_steps', '2030-01-01', 'sent')`,
    ]) {
      expect(
        await errorCodeOf(queryAs(db, MIGRATION_OWNER, sql, [eventId])),
      ).toBe(CHECK_VIOLATION);
    }
  });

  it("refuses a pickup reminder on any date but its own", async () => {
    const eventId = await insertEvent(db, guild);
    const actor = fakeId();
    await value(`public.complete_event_step($1, $2, 'budget_approved', $3)`, [
      eventId,
      guild.guildId,
      actor,
    ]);
    await value(`public.set_event_pickup_time($1, $2, '18:00', $3)`, [
      eventId,
      guild.guildId,
      actor,
    ]);
    await value(`public.assign_event_step($1, $2, 'food_pickup', $3, $3)`, [
      eventId,
      guild.guildId,
      actor,
    ]);
    // insertEvent dates the event 2030-01-15.
    const claim = (kind: string, day: string) =>
      value(
        `public.claim_event_reminder($1, $2::public.event_reminder_kind, $3)`,
        [eventId, kind, day],
      );
    expect(await claim("pickup_two_days", "2030-01-14")).toBeNull();
    expect(await claim("pickup_day", "2030-01-14")).toBeNull();
    expect(await claim("pickup_two_days", "2030-01-13")).not.toBeNull();
    expect(await claim("pickup_day", "2030-01-15")).not.toBeNull();
    expect(await claim("daily_steps", "2030-01-16")).toBeNull();

    await db.query(
      `UPDATE public.guild_config SET reminders_enabled = false WHERE guild_id = $1`,
      [guild.guildId],
    );
    // A step reminder can be claimed only for today or yesterday in the guild's zone.
    const today = todayInZone(new Date(), "America/New_York");
    try {
      expect(await claim("daily_steps", today)).toBeNull();
    } finally {
      await db.query(
        `UPDATE public.guild_config SET reminders_enabled = true WHERE guild_id = $1`,
        [guild.guildId],
      );
    }
    expect(await claim("daily_steps", today)).not.toBeNull();
  });
});
