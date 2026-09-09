/**
 * First through the door gets extra points. The event value is still the
 * floor — this only adds a short race on top so a GBM is not a row of ties.
 *
 * Arrival 0 (first) → +5, then +4 … +1, then the base alone.
 */
export const EARLY_BIRD_MAX_BONUS = 5;

export function pointsForArrival(base: number, priorCount: number) {
  if (base <= 0) return 0;
  const bonus = Math.max(0, EARLY_BIRD_MAX_BONUS - priorCount);
  return base + bonus;
}
