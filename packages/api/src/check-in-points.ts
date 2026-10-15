/**
 * What one check-in is worth. Every number in the scoring rules lives here, and
 * `scoreCheckIn` is the only place they combine, so the live door and the
 * re-score replay cannot drift apart.
 *
 * Officers (ADMIN, SUPER_ADMIN) are running the room, not racing for the
 * leaderboard: they earn the event's base points and no bonuses (no early-bird,
 * streak, or catch-up), and they neither use up an early-bird spot nor count
 * toward the catch-up median.
 */

/**
 * First members through the door get extra points. The event value is still the
 * floor — this only adds a short race on top so a GBM is not a row of ties.
 *
 * Member arrival 0 (first) → +5, then +4 … +1, then the base alone.
 */
export const EARLY_BIRD_MAX_BONUS = 5;

/** Extra for coming back: +2 per streak level, five levels, so +10 at most. */
export const STREAK_STEP = 2;
export const STREAK_CAP = 10;
export const STREAK_MAX_LEVEL = STREAK_CAP / STREAK_STEP;

/** A member behind the median closes 1/CATCH_UP_SHARE of the gap per check-in. */
export const CATCH_UP_SHARE = 2;

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

/** Median of the totals; the mean of the middle two when the count is even. */
export function medianOf(values: readonly number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Help for a member who is behind the pack: half the gap to the median, rounded
 * up, never more than one event's base. Nobody to compare to, or at or above
 * the median, gets nothing.
 */
export function catchUpBonus(
  base: number,
  ownTotal: number,
  medianTotal: number | null,
) {
  if (medianTotal === null || ownTotal >= medianTotal) return 0;
  return Math.min(
    Math.max(base, 0),
    Math.ceil((medianTotal - ownTotal) / CATCH_UP_SHARE),
  );
}

export type CheckInScoreInput = {
  /** The event's pointsValue. At or below 0 nobody earns anything. */
  base: number;
  /** Role (ADMIN / SUPER_ADMIN) at scoring time. */
  isOfficer: boolean;
  /** Members already in this event, officers not counted. */
  priorMemberArrivals: number;
  /** From `streakLevel`; only members use it. */
  streakLevel: number;
  /** This person's live total before this check-in. */
  ownTotal: number;
  /**
   * Median live total of the other non-officer members who have at least one
   * live check-in; null when there is nobody else yet.
   */
  medianTotal: number | null;
};

export function scoreCheckIn(input: CheckInScoreInput) {
  if (input.base <= 0) return 0;
  if (input.isOfficer) return input.base;
  return (
    pointsForArrival(input.base, input.priorMemberArrivals) +
    streakBonus(input.streakLevel) +
    catchUpBonus(input.base, input.ownTotal, input.medianTotal)
  );
}
