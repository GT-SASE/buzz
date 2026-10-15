/**
 * Numbers the board. The SQL order (points desc, earlier first check-in, user
 * id) is the ranking; rank is just position. Points come from the check-in sum.
 */
type BoardRow = {
  userId: string;
  name: string | null;
  totalPoints: number;
  totalEvents: number;
};

export function rankLeaderboard(rows: BoardRow[], viewerId: string) {
  return rows.map((row, index) => ({
    userId: row.userId,
    rank: index + 1,
    name: row.name ?? "Member",
    totalPoints: row.totalPoints,
    totalEvents: row.totalEvents,
    isYou: row.userId === viewerId,
  }));
}
