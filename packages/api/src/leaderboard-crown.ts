/**
 * Display totals that are not the raw check-in sum. Negative totals sit above
 * everyone else, most-negative first.
 */
export const LEADERBOARD_ADJUSTMENTS = [
  {
    name: "Tiffany Jia",
    email: "tiffanyjia99@gmail.com",
    setTo: -1000,
  },
  {
    name: "Kyle Jiang",
    email: "kylej87us@gmail.com",
    delta: -100,
  },
] as const;

export const LEADERBOARD_CROWN = LEADERBOARD_ADJUSTMENTS[0];

type BoardRow = {
  userId: string;
  name: string | null;
  email?: string | null;
  totalPoints: number;
  totalEvents: number;
};

function emailKey(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

export function adjustmentFor(row: {
  name?: string | null;
  email?: string | null;
}) {
  const email = emailKey(row.email);
  const name = (row.name ?? "").trim().toLowerCase();
  return LEADERBOARD_ADJUSTMENTS.find(
    (entry) =>
      (email && email === entry.email) || name === entry.name.toLowerCase(),
  );
}

function adjustedPoints(earned: number, adj: ReturnType<typeof adjustmentFor>) {
  if (!adj) return earned;
  if ("setTo" in adj) return adj.setTo;
  return earned + adj.delta;
}

function scoreRow(row: BoardRow): BoardRow & { name: string } {
  const adj = adjustmentFor(row);
  return {
    userId: row.userId,
    name: adj?.name ?? row.name ?? "Member",
    email: row.email,
    totalPoints: adjustedPoints(row.totalPoints, adj),
    totalEvents: row.totalEvents,
  };
}

export function crownLeaderboard(
  rows: BoardRow[],
  viewer: { id: string; email?: string | null },
) {
  const scored = rows.map(scoreRow);
  const seen = new Set(
    scored
      .map((row) => adjustmentFor(row)?.email)
      .filter((email): email is string => Boolean(email)),
  );

  for (const adj of LEADERBOARD_ADJUSTMENTS) {
    if (seen.has(adj.email)) continue;
    scored.push(
      scoreRow({
        userId: "",
        name: adj.name,
        email: adj.email,
        totalPoints: 0,
        totalEvents: 0,
      }),
    );
  }

  const negatives = scored
    .filter((row) => row.totalPoints < 0)
    .sort(
      (a, b) =>
        a.totalPoints - b.totalPoints || a.userId.localeCompare(b.userId),
    );
  const rest = scored.filter((row) => row.totalPoints >= 0);
  const ordered = [...negatives, ...rest];
  const viewerAdj = adjustmentFor({ email: viewer.email });

  return ordered.map((row, index) => ({
    userId: row.userId,
    rank: index + 1,
    name: row.name,
    totalPoints: row.totalPoints,
    totalEvents: row.totalEvents,
    isYou:
      (row.userId !== "" && row.userId === viewer.id) ||
      (viewerAdj !== undefined && adjustmentFor(row) === viewerAdj),
  }));
}
