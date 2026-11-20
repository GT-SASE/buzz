import type { DbClient } from "./client.ts";
import { callFunction, sql } from "./internal.ts";
import type { DbResult } from "./errors.ts";

/** Deletes claims older than a day. Returns how many went. */
export async function expireInteractionClaims(
  db: DbClient,
): Promise<DbResult<number>> {
  return callFunction<number>(
    db,
    sql`select public.expire_interaction_claims() as value`,
  );
}

/** True for the first caller with this interaction ID, false for every later one. */
export async function claimInteraction(
  db: DbClient,
  { interactionId }: { interactionId: string },
): Promise<DbResult<boolean>> {
  return callFunction<boolean>(
    db,
    sql`select public.claim_interaction(p_interaction_id => ${interactionId}) as value`,
  );
}
