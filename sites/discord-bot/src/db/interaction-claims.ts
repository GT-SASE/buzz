import { lt, sql } from "drizzle-orm";
import type { DbClient } from "./client.ts";
import { write } from "./internal.ts";
import type { DbResult } from "./errors.ts";
import { interactionClaims } from "./schema.ts";

/** Deletes claims older than a day. Returns how many went. */
export async function expireInteractionClaims(
  db: DbClient,
): Promise<DbResult<number>> {
  return write(db, async (orm) => {
    const deleted = await orm
      .delete(interactionClaims)
      .where(lt(interactionClaims.claimedAt, sql`now() - interval '1 day'`))
      .returning({ interactionId: interactionClaims.interactionId });
    return deleted.length;
  });
}

/** True for the first caller with this interaction ID, false for every later one. */
export async function claimInteraction(
  db: DbClient,
  { interactionId }: { interactionId: string },
): Promise<DbResult<boolean>> {
  return write(db, async (orm) => {
    const claimed = await orm
      .insert(interactionClaims)
      .values({ interactionId })
      .onConflictDoNothing({ target: interactionClaims.interactionId })
      .returning({ interactionId: interactionClaims.interactionId });
    return claimed.length > 0;
  });
}
