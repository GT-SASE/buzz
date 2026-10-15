import { describe, expect, it } from "vitest";

import { rankLeaderboard } from "../packages/api/src/leaderboard-rank";

describe("rankLeaderboard", () => {
  it("ranks by position, highest points first, negatives at the bottom", () => {
    const board = rankLeaderboard(
      [
        { userId: "a", name: "Ada", totalPoints: 40, totalEvents: 5 },
        { userId: "b", name: "Bea", totalPoints: 30, totalEvents: 4 },
        { userId: "k", name: "Kyle Jiang", totalPoints: -67, totalEvents: 3 },
      ],
      "b",
    );
    expect(board.map((row) => [row.name, row.rank])).toEqual([
      ["Ada", 1],
      ["Bea", 2],
      ["Kyle Jiang", 3],
    ]);
    expect(board[1]?.isYou).toBe(true);
    expect(board[0]?.isYou).toBe(false);
  });

  it("falls back to Member when the account has no name", () => {
    const board = rankLeaderboard(
      [{ userId: "x", name: null, totalPoints: 10, totalEvents: 1 }],
      "x",
    );
    expect(board[0]?.name).toBe("Member");
  });
});
