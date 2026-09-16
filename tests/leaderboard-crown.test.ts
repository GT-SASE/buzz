import { describe, expect, it } from "vitest";

import {
  adjustmentFor,
  crownLeaderboard,
  LEADERBOARD_CROWN,
} from "../packages/api/src/leaderboard-crown";

describe("crownLeaderboard", () => {
  const rest = [
    {
      userId: "a",
      name: "Ada",
      email: "ada@gatech.edu",
      totalPoints: 40,
      totalEvents: 5,
    },
    {
      userId: "t",
      name: null,
      email: LEADERBOARD_CROWN.email,
      totalPoints: 80,
      totalEvents: 3,
    },
    {
      userId: "k",
      name: "Kyle Jiang",
      email: "kylej87us@gmail.com",
      totalPoints: 50,
      totalEvents: 2,
    },
  ];

  it("lists negative totals first, Tiffany at the floor", () => {
    const board = crownLeaderboard(rest, { id: "a" });
    expect(board[0]).toMatchObject({
      name: "Tiffany Jia",
      rank: 1,
      totalPoints: -1000,
      totalEvents: 3,
    });
    expect(board[1]).toMatchObject({
      name: "Kyle Jiang",
      rank: 2,
      totalPoints: -50,
      totalEvents: 2,
    });
    expect(board[2]).toMatchObject({ name: "Ada", rank: 3, totalPoints: 40 });
  });

  it("still lists them when they have never checked in", () => {
    const board = crownLeaderboard(rest.slice(0, 1), {
      id: "t",
      email: LEADERBOARD_CROWN.email,
    });
    expect(board[0]).toMatchObject({
      name: "Tiffany Jia",
      rank: 1,
      totalPoints: -1000,
      totalEvents: 0,
      isYou: true,
    });
    expect(board[1]).toMatchObject({
      name: "Kyle Jiang",
      rank: 2,
      totalPoints: -100,
      totalEvents: 0,
    });
  });

  it("takes 100 off Kyle's earned total", () => {
    const board = crownLeaderboard(
      [
        {
          userId: "k",
          name: "Kyle Jiang",
          email: "kylej87us@gmail.com",
          totalPoints: 250,
          totalEvents: 4,
        },
      ],
      { id: "k", email: "kylej87us@gmail.com" },
    );
    expect(board.find((row) => row.name === "Kyle Jiang")).toMatchObject({
      totalPoints: 150,
      isYou: true,
    });
  });

  it("matches Tiffany by email", () => {
    expect(adjustmentFor({ email: "TiffanyJia99@gmail.com" })?.name).toBe(
      "Tiffany Jia",
    );
  });
});
