import { describe, expect, it } from "vitest";
import { claimInteraction } from "../../src/db/interaction-claims.ts";
import { fakeId } from "../db/harness.ts";
import { raceDatabase } from "./race.ts";

/** Discord sends the same interaction again while the first delivery is still running. */
describe("a retried interaction", () => {
  const db = raceDatabase();
  const claimSql = "SELECT public.claim_interaction($1)";

  it("is handled by only one of the two deliveries", async () => {
    const interactionId = fakeId();
    const second = await db.race([claimSql, [interactionId]], (bot) =>
      claimInteraction(bot, { interactionId }),
    );
    expect(second).toEqual({ ok: true, value: false });
  });

  it("is handled by the retry if the first delivery's claim rolls back", async () => {
    const interactionId = fakeId();
    const second = await db.race(
      [claimSql, [interactionId]],
      (bot) => claimInteraction(bot, { interactionId }),
      "ROLLBACK",
    );
    expect(second).toEqual({ ok: true, value: true });
  });
});
