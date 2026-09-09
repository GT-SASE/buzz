/**
 * First through the door gets extra points. The event value is still the
 * floor — this only adds a short race on top so a GBM is not a row of ties.
 *
 * Arrival 0 (first) → +5, then +4 … +1, then the base alone.
 */
export const EARLY_BIRD_MAX_BONUS = 5;

/** Extra for coming back: +3 per prior consecutive happening, capped. */
export const STREAK_STEP = 3;
export const STREAK_CAP = 9;

export function pointsForArrival(base: number, priorCount: number) {
  if (base <= 0) return 0;
  const bonus = Math.max(0, EARLY_BIRD_MAX_BONUS - priorCount);
  return base + bonus;
}

export function streakBonus(priorConsecutive: number) {
  if (priorConsecutive <= 0) return 0;
  return Math.min(STREAK_CAP, STREAK_STEP * priorConsecutive);
}

/**
 * Happenings newest-first, before the event being stamped. Walk until a miss
 * so a skipped GBM breaks the run instead of counting any past attendance.
 */
export function consecutivePriorStreak(
  attendedEventIds: Iterable<string>,
  previousHappeningsNewestFirst: readonly string[],
) {
  const attended = new Set(attendedEventIds);
  let streak = 0;
  for (const id of previousHappeningsNewestFirst) {
    if (!attended.has(id)) break;
    streak += 1;
  }
  return streak;
}

export function pointsForCheckIn(
  base: number,
  priorCount: number,
  priorConsecutive: number,
) {
  const arrival = pointsForArrival(base, priorCount);
  if (arrival === 0) return 0;
  return arrival + streakBonus(priorConsecutive);
}
