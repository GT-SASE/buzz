/**
 * Negative totals sit above everyone else, most-negative first. Points come
 * from the check-in sum; this only reorders the board.
 */
type BoardRow = {
  userId: string;
  name: string | null;
  totalPoints: number;
  totalEvents: number;
};

export function crownLeaderboard(rows: BoardRow[], viewerId: string) {
  const named = rows.map((row) => ({
    userId: row.userId,
    name: row.name ?? "Member",
    totalPoints: row.totalPoints,
    totalEvents: row.totalEvents,
  }));

  const negatives = named
    .filter((row) => row.totalPoints < 0)
    .sort(
      (a, b) =>
        a.totalPoints - b.totalPoints || a.userId.localeCompare(b.userId),
    );
  const rest = named.filter((row) => row.totalPoints >= 0);

  return [...negatives, ...rest].map((row, index) => ({
    userId: row.userId,
    rank: index + 1,
    name: row.name,
    totalPoints: row.totalPoints,
    totalEvents: row.totalEvents,
    isYou: row.userId === viewerId,
  }));
}
