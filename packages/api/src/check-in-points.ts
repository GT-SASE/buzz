/**
 * First members through the door get extra points. The event value is still the
 * floor — this only adds a short race on top so a GBM is not a row of ties.
 * Only member arrivals use up a spot; officers are paid by the same formula but
 * never take a bonus away from the members who came for it.
 *
 * Arrival 0 (first) → +5, then +4 … +1, then the base alone.
 */
export const EARLY_BIRD_MAX_BONUS = 5;

/** Extra for coming back: +3 per streak level, three levels, so +9 at most. */
export const STREAK_STEP = 3;
export const STREAK_CAP = 9;
export const STREAK_MAX_LEVEL = STREAK_CAP / STREAK_STEP;

export function pointsForArrival(base: number, priorCount: number) {
  if (base <= 0) return 0;
  const bonus = Math.max(0, EARLY_BIRD_MAX_BONUS - priorCount);
  return base + bonus;
}

export function streakBonus(level: number) {
  if (level <= 0) return 0;
  return STREAK_STEP * Math.min(STREAK_MAX_LEVEL, level);
}

/**
 * Streak level going into the next event. `happeningsOldestFirst` is every
 * live (non-archived) event with a check-in before the one being stamped.
 * History before the person's first attended happening is ignored, so a
 * newcomer is never charged for events held before they came. After that each
 * attendance climbs a level (to the cap) and each miss costs one, so a regular
 * who skips once keeps most of the bonus instead of dropping to nothing.
 */
export function streakLevel(
  attendedEventIds: Iterable<string>,
  happeningsOldestFirst: readonly string[],
) {
  const attended = new Set(attendedEventIds);
  let started = false;
  let level = 0;
  for (const id of happeningsOldestFirst) {
    if (attended.has(id)) {
      started = true;
      level = Math.min(STREAK_MAX_LEVEL, level + 1);
    } else if (started) {
      level = Math.max(0, level - 1);
    }
  }
  return level;
}

export function pointsForCheckIn(
  base: number,
  priorCount: number,
  level: number,
) {
  const arrival = pointsForArrival(base, priorCount);
  if (arrival === 0) return 0;
  return arrival + streakBonus(level);
}
