/**
 * Shapes the board rows the database ranked. `rank` is SQL `rank()` on points,
 * so ties share a place and the next place skips (1, 1, 1, 4); a viewer
 * outside the top N still gets their true one. Which tied members fill the
 * last of the N rows is the stable order points desc, earlier first check-in,
 * user id, and `position` is where a row sits in it.
 *
 * A member who hides their name arrives with `name: null` and keeps their
 * rank: dropping the row would shift everyone below up a place and make the
 * viewer's own rank disagree with the board.
 */
type BoardRow = {
  userId: string;
  /** Competition rank: members tied on points share it (1, 1, 1, 4). */
  rank: number;
  /** Place in the stable listing order, 1-based. The `limit` cuts here. */
  position: number;
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
    top: shaped.filter((_, index) => rows[index]!.position <= limit),
    you: you
      ? {
          rank: you.rank,
          totalPoints: you.totalPoints,
          totalEvents: you.totalEvents,
        }
      : null,
  };
}
