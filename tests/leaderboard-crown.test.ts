import { describe, expect, it } from "vitest";

import { crownLeaderboard } from "../packages/api/src/leaderboard-crown";

describe("crownLeaderboard", () => {
  const rest = [
    {
      userId: "a",
      name: "Ada",
      totalPoints: 40,
      totalEvents: 5,
    },
    {
      userId: "t",
      name: "Tiffany Jia",
      totalPoints: -2000,
      totalEvents: 3,
    },
    {
      userId: "k",
      name: "Kyle Jiang",
      totalPoints: -67,
      totalEvents: 3,
    },
  ];

  it("lists negative totals first, most-negative at rank 1", () => {
    const board = crownLeaderboard(rest, "a");
    expect(board[0]).toMatchObject({
      name: "Tiffany Jia",
      rank: 1,
      totalPoints: -2000,
    });
    expect(board[1]).toMatchObject({
      name: "Kyle Jiang",
      rank: 2,
      totalPoints: -67,
    });
    expect(board[2]).toMatchObject({ name: "Ada", rank: 3, totalPoints: 40 });
  });

  it("keeps the SQL order among non-negative totals", () => {
    const board = crownLeaderboard(
      [
        { userId: "a", name: "Ada", totalPoints: 40, totalEvents: 5 },
        { userId: "b", name: "Bea", totalPoints: 30, totalEvents: 4 },
      ],
      "b",
    );
    expect(board.map((row) => row.name)).toEqual(["Ada", "Bea"]);
    expect(board[1]?.isYou).toBe(true);
  });

  it("falls back to Member when the account has no name", () => {
    const board = crownLeaderboard(
      [{ userId: "x", name: null, totalPoints: 10, totalEvents: 1 }],
      "x",
    );
    expect(board[0]?.name).toBe("Member");
  });
});
