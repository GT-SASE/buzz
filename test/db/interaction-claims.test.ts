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

  it("is true for the first claim of each interaction and false after", async () => {
    const interactionId = fakeId();
    expect(await claim(interactionId)).toBe(true);
    expect(await claim(interactionId)).toBe(false);
    expect(await claim(fakeId())).toBe(true);
  });

  it("rolls back with the transaction, so a failed change can be retried", async () => {
    const interactionId = fakeId();
    await db.exec("BEGIN");
    expect(await claim(interactionId)).toBe(true);
    await db.exec("ROLLBACK");
    expect(await claim(interactionId)).toBe(true);
  });

  it.each([
    "SELECT * FROM public.interaction_claims",
    "DELETE FROM public.interaction_claims",
    "TRUNCATE public.interaction_claims",
  ])("bot_app cannot run %s", async (sql) => {
    expect(await errorCodeOf(queryAs(db, "bot_app", sql))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it.each([
    `SELECT public.claim_interaction('${fakeId()}')`,
    "SELECT public.expire_interaction_claims()",
  ])("%s is closed to other roles", async (sql) => {
    expect(await errorCodeOf(queryAs(db, OTHER_ROLE, sql))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it("expires claims older than a day and keeps the rest", async () => {
    const claimAged = async (hours: number) => {
      const id = fakeId();
      await db.query(
        `INSERT INTO public.interaction_claims (interaction_id, claimed_at)
         VALUES ($1, now() - make_interval(hours => $2))`,
        [id, hours],
      );
      return id;
    };
    const old = await claimAged(25);
    const recent = await claimAged(23);

    await queryAs(db, "bot_app", "SELECT public.expire_interaction_claims()");

    const { rows } = await db.query<{ interaction_id: string }>(
      "SELECT interaction_id FROM public.interaction_claims WHERE interaction_id = ANY($1)",
      [[old, recent]],
    );
    expect(rows.map((row) => row.interaction_id)).toEqual([recent]);
  });
});
