import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("claim_interaction", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  const claim = async (interactionId: string) => {
    const rows = await queryAs<{ claimed: boolean }>(
      db,
      "bot_app",
      "SELECT public.claim_interaction($1) AS claimed",
      [interactionId],
    );
    return rows[0]?.claimed;
  };

  it("is true for the first claim and false for every later one", async () => {
    const interactionId = fakeId();
    expect(await claim(interactionId)).toBe(true);
    expect(await claim(interactionId)).toBe(false);
    expect(await claim(interactionId)).toBe(false);
  });

  it("treats different interactions separately", async () => {
    expect(await claim(fakeId())).toBe(true);
    expect(await claim(fakeId())).toBe(true);
  });

  it("keeps one row per interaction", async () => {
    const interactionId = fakeId();
    await claim(interactionId);
    await claim(interactionId);
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM public.interaction_claims WHERE interaction_id = $1",
      [interactionId],
    );
    expect(rows).toEqual([{ n: 1 }]);
  });

  it("rolls back with the transaction, so a failed change can be retried", async () => {
    const interactionId = fakeId();
    await db.exec("BEGIN");
    expect(await claim(interactionId)).toBe(true);
    await db.exec("ROLLBACK");
    expect(await claim(interactionId)).toBe(true);
  });

  it("rejects a value that is not a Discord ID", async () => {
    expect(await errorCodeOf(claim("not-an-id"))).toBe("23514");
  });

  it("is SECURITY DEFINER with an empty search_path", async () => {
    const { rows } = await db.query(
      "SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'claim_interaction'",
    );
    expect(rows).toEqual([{ prosecdef: true, proconfig: ['search_path=""'] }]);
  });

  it("bot_app has no direct access to the table", async () => {
    for (const sql of [
      "SELECT * FROM public.interaction_claims",
      `INSERT INTO public.interaction_claims (interaction_id) VALUES ('${fakeId()}')`,
      "DELETE FROM public.interaction_claims",
      "TRUNCATE public.interaction_claims",
    ]) {
      expect(await errorCodeOf(queryAs(db, "bot_app", sql))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    }
  });

  it.each([OTHER_ROLE])("%s cannot call it", async (role) => {
    const code = await errorCodeOf(
      queryAs(db, role, `SELECT public.claim_interaction('${fakeId()}')`),
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("states its retention rule in the migration", () => {
    const sql = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "db",
        "migrations",
        "20261111000000_baseline.sql",
      ),
      "utf8",
    );
    expect(sql).toContain("Retention:");
  });

  describe("expiry", () => {
    async function claimAged(hours: number): Promise<string> {
      const id = fakeId();
      await db.query(
        `INSERT INTO public.interaction_claims (interaction_id, claimed_at)
         VALUES ($1, now() - make_interval(hours => $2))`,
        [id, hours],
      );
      return id;
    }

    async function exists(id: string): Promise<boolean> {
      const { rows } = await db.query(
        "SELECT 1 FROM public.interaction_claims WHERE interaction_id = $1",
        [id],
      );
      return rows.length === 1;
    }

    it("deletes claims older than a day and keeps the rest", async () => {
      const old = await claimAged(25);
      const recent = await claimAged(23);

      const rows = await queryAs<{ deleted: number }>(
        db,
        "bot_app",
        "SELECT public.expire_interaction_claims() AS deleted",
      );

      expect(rows[0]?.deleted).toBeGreaterThanOrEqual(1);
      expect(await exists(old)).toBe(false);
      expect(await exists(recent)).toBe(true);
    });

    it.each([OTHER_ROLE])("is closed to %s", async (role) => {
      expect(
        await errorCodeOf(
          queryAs(db, role, "SELECT public.expire_interaction_claims()"),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });
});
