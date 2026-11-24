import { checkInCodeFor } from "../../packages/api/src/check-in-code";

/**
 * The code a scanner would read off the projector for this event right now.
 * Tests keep the event's stored key and id; the rotating code is derived at
 * the moment of the call so a long suite never holds a stale one.
 */
export function liveCode(
  event: { id: string; checkInCode: string },
  now: number = Date.now(),
) {
  return checkInCodeFor(event, now);
}
