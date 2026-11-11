import { isSnowflake } from "../lib/snowflake.ts";
import type { DbClient } from "./client.ts";
import { rest } from "./internal.ts";
import { refused, type DbResult } from "./errors.ts";
import { booleanValue, integerValue } from "./result.ts";

/** Deletes claims older than a day. Returns how many went. */
export async function expireInteractionClaims(
  db: DbClient,
): Promise<DbResult<number>> {
  return integerValue(await rest(db).rpc("expire_interaction_claims", {}));
}

/** True for the first caller with this interaction ID, false for every later one. */
export async function claimInteraction(
  db: DbClient,
  { interactionId }: { interactionId: string },
): Promise<DbResult<boolean>> {
  if (!isSnowflake(interactionId)) {
    return refused();
  }
  return booleanValue(
    await rest(db).rpc("claim_interaction", {
      p_interaction_id: interactionId,
    }),
  );
}
