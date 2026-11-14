/**
 * The event workflow at the SQL level: what the access layer cannot reach, such as the
 * history rows, the functions the bot's role may not call, and the
 * refusals a well-behaved caller never triggers. test/db/access-layer.test.ts covers the
 * ordinary paths through src/db/event-steps.ts.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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

  const value = async (sql: string, params: unknown[]): Promise<unknown> => {
    const rows = await queryAs<{ value: unknown }>(
      db,
      "bot_app",
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
      "complete Food pickup",
      `public.complete_event_step($1, $2, 'food_pickup', $3)`,
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
  });

  it("does not let bot_app call the internal functions, or another role the writers", async () => {
    expect(
      await errorCodeOf(
        queryAs(db, "bot_app", `SELECT public.create_event_steps()`),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    const eventId = await insertEvent(db, guild);
    for (const sql of [
      `SELECT public.complete_event_step('${eventId}', '${guild.guildId}', 'budget_sheet', '${fakeId()}')`,
      `SELECT public.claim_event_reminder('${eventId}', 'daily_steps', '2030-01-15')`,
    ]) {
      expect(await errorCodeOf(queryAs(db, OTHER_ROLE, sql))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    }
  });

  it("keeps the step and log rows consistent whatever the owner writes", async () => {
    const eventId = await insertEvent(db, guild);
    for (const sql of [
      `UPDATE public.event_steps SET status = 'done' WHERE event_id = $1 AND kind = 'budget_sheet'`,
      `INSERT INTO public.event_reminder_log (event_id, kind, reminder_date, state)
       VALUES ($1, 'daily_steps', '2030-01-01', 'sent')`,
    ]) {
      expect(
        await errorCodeOf(queryAs(db, MIGRATION_OWNER, sql, [eventId])),
      ).toBe(CHECK_VIOLATION);
    }
  });

  it("claims a pickup reminder only for today, and a step list up to the event", async () => {
    const eventId = await insertEvent(db, guild);
    const params = [eventId, guild.guildId, fakeId()];
    await value(
      `public.complete_event_step($1, $2, 'budget_approved', $3)`,
      params,
    );
    await value(`public.set_event_pickup_time($1, $2, '18:00', $3)`, params);
    await value(
      `public.assign_event_step($1, $2, 'food_pickup', $3, $3)`,
      params,
    );
    // insertEvent dates the event 2030-01-15.
    const claim = (kind: string, day: string) =>
      value(
        `public.claim_event_reminder($1, $2::public.event_reminder_kind, $3)`,
        [eventId, kind, day],
      );
    expect(await claim("pickup_before", "2030-01-13")).toBeNull();
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
    expect(await claim("pickup_day", today)).not.toBeNull();
  });

  describe("setup drafts", () => {
    const save = (guildId: string, roles: string[], fingerprint: string) =>
      value(`public.save_setup_draft($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
        guildId,
        fakeId(),
        ...roles,
        fingerprint,
      ]);
    const six = () => Array.from({ length: 6 }, () => fakeId());

    it("refuses the guild ID (@everyone) as a role, and a bad fingerprint", async () => {
      const guildId = fakeId();
      const roles = six();
      roles[0] = guildId;
      expect(await errorCodeOf(save(guildId, roles, "abcdefgh12345678"))).toBe(
        CHECK_VIOLATION,
      );
      expect(await errorCodeOf(save(fakeId(), six(), "comma,123456789"))).toBe(
        CHECK_VIOLATION,
      );
    });
  });
});
