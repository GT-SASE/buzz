/**
 * Shapes the board rows the database ranked. The SQL window (points desc,
 * earlier first check-in, user id) is the ranking and `rank` is its row
 * number, so a viewer outside the top N still gets their true place.
 *
 * A member who hides their name arrives with `name: null` and keeps their
 * rank: dropping the row would shift everyone below up a place and make the
 * viewer's own rank disagree with the board.
 */
type BoardRow = {
  userId: string;
  rank: number;
  name: string | null;
  hidden: boolean;
  totalPoints: number;
  totalEvents: number;
};

export function shapeLeaderboard(
  rows: BoardRow[],
  viewerId: string,
  limit: number,
) {
  const shaped = rows.map((row) => ({
    rank: row.rank,
    name: row.hidden ? null : (row.name ?? "Member"),
    anonymous: row.hidden,
    totalPoints: row.totalPoints,
    totalEvents: row.totalEvents,
    isYou: row.userId === viewerId,
  }));
  const you = shaped.find((row) => row.isYou);

  return {
    top: shaped.filter((row) => row.rank <= limit),
    you: you
      ? {
          rank: you.rank,
          totalPoints: you.totalPoints,
          totalEvents: you.totalEvents,
        }
      : null,
  };
}
