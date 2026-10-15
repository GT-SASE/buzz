import {
  medianOf,
  scoreCheckIn,
  streakLevel,
  type CheckInScoreInput,
} from "./check-in-points";

/**
 * Replays every past check-in through the same `scoreCheckIn` the door uses,
 * in the order the door would have seen them, so history can be re-priced
 * under new rules. Pure: rows in, rows out. scripts/rescore-points.mjs does the
 * database reading and writing.
 *
 * Each row is scored with today's rules and today's roles, against the state at
 * that moment: the live point totals, member arrivals and attendance of only
 * the check-ins replayed before it, with each earlier row already carrying its
 * NEW points. That is what makes the catch-up median and the streaks agree with
 * what a live door running the new rules would have produced.
 *
 * Archived events: a row on one is scored with the same formula (its arrival
 * order is counted within its own event), but it never feeds the running
 * totals, the happenings or anyone's attendance. That mirrors the live reads,
 * where an archived event counts for nothing, so it cannot shift anybody
 * else's streak or the median. Restoring the event later keeps the points it
 * was given here.
 */

export type RescoreEvent = {
  id: string;
  startsAt: Date;
  pointsValue: number;
  archivedAt: Date | null;
};

export type RescoreCheckIn = {
  id: string;
  eventId: string;
  userId: string;
  checkedInAt: Date;
  pointsEarned: number;
  method: string;
};

export type RescoreRole = "MEMBER" | "ADMIN" | "SUPER_ADMIN";

export type RescoreRowResult = {
  id: string;
  oldPoints: number;
  newPoints: number;
};

export type RescoreUserResult = {
  userId: string;
  oldTotal: number;
  newTotal: number;
  /** Position on the leaderboard (1 = top) among users with a live check-in. */
  oldRank: number;
  newRank: number;
};

export type RescoreResult = {
  rows: RescoreRowResult[];
  users: RescoreUserResult[];
};

function isOfficer(role: RescoreRole | undefined) {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

/** Same order as member.leaderboard: points, then earliest check-in, then id. */
function rankOf(
  entries: { userId: string; total: number; firstAt: number }[],
): Map<string, number> {
  const sorted = [...entries].sort(
    (a, b) =>
      b.total - a.total ||
      a.firstAt - b.firstAt ||
      (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
  );
  return new Map(sorted.map((entry, index) => [entry.userId, index + 1]));
}

export function rescorePoints(input: {
  events: readonly RescoreEvent[];
  checkIns: readonly RescoreCheckIn[];
  /** Current role by user id; a user missing here is a MEMBER. */
  roles: ReadonlyMap<string, RescoreRole>;
}): RescoreResult {
  const eventById = new Map(input.events.map((event) => [event.id, event]));
  // Oldest first with the id breaking ties, as the live streak walk orders them.
  const liveOldestFirst = input.events
    .filter((event) => event.archivedAt === null)
    .sort(
      (a, b) =>
        a.startsAt.getTime() - b.startsAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  const ordered = [...input.checkIns].sort(
    (a, b) =>
      a.checkedInAt.getTime() - b.checkedInAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  // Live state only: a user is in `totals` once they have a live check-in.
  const totals = new Map<string, number>();
  const attended = new Map<string, Set<string>>();
  const happenings = new Set<string>();
  // Member arrivals per event (archived events included, within themselves).
  const arrivals = new Map<string, number>();

  const rows: RescoreRowResult[] = [];
  const oldTotals = new Map<string, number>();
  const firstAt = new Map<string, number>();

  for (const row of ordered) {
    const event = eventById.get(row.eventId);
    if (!event) throw new Error(`Check-in ${row.id}: unknown event`);

    const officer = isOfficer(input.roles.get(row.userId));
    const live = event.archivedAt === null;

    const score: CheckInScoreInput = {
      base: event.pointsValue,
      isOfficer: officer,
      priorMemberArrivals: arrivals.get(event.id) ?? 0,
      streakLevel: 0,
      ownTotal: totals.get(row.userId) ?? 0,
      medianTotal: null,
    };

    if (!officer && event.pointsValue > 0) {
      const before = event.startsAt.getTime();
      const past = liveOldestFirst
        .filter(
          (candidate) =>
            happenings.has(candidate.id) &&
            candidate.startsAt.getTime() < before,
        )
        .map((candidate) => candidate.id);
      score.streakLevel = streakLevel(attended.get(row.userId) ?? [], past);

      const others: number[] = [];
      for (const [userId, total] of totals) {
        if (userId !== row.userId && !isOfficer(input.roles.get(userId))) {
          others.push(total);
        }
      }
      score.medianTotal = medianOf(others);
    }

    const newPoints = scoreCheckIn(score);
    rows.push({ id: row.id, oldPoints: row.pointsEarned, newPoints });

    if (!officer) arrivals.set(event.id, (arrivals.get(event.id) ?? 0) + 1);
    if (live) {
      totals.set(row.userId, score.ownTotal + newPoints);
      oldTotals.set(
        row.userId,
        (oldTotals.get(row.userId) ?? 0) + row.pointsEarned,
      );
      if (!firstAt.has(row.userId)) {
        firstAt.set(row.userId, row.checkedInAt.getTime());
      }
      happenings.add(event.id);
      const seen = attended.get(row.userId) ?? new Set<string>();
      seen.add(event.id);
      attended.set(row.userId, seen);
    }
  }

  const userIds = [...totals.keys()];
  const oldRanks = rankOf(
    userIds.map((userId) => ({
      userId,
      total: oldTotals.get(userId) ?? 0,
      firstAt: firstAt.get(userId)!,
    })),
  );
  const newRanks = rankOf(
    userIds.map((userId) => ({
      userId,
      total: totals.get(userId) ?? 0,
      firstAt: firstAt.get(userId)!,
    })),
  );

  return {
    rows,
    users: userIds
      .map((userId) => ({
        userId,
        oldTotal: oldTotals.get(userId) ?? 0,
        newTotal: totals.get(userId) ?? 0,
        oldRank: oldRanks.get(userId)!,
        newRank: newRanks.get(userId)!,
      }))
      .sort((a, b) => a.newRank - b.newRank),
  };
}
