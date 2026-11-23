import { describe, expect, it } from "bun:test";

import { shapeLeaderboard } from "../packages/api/src/leaderboard-rank";

const row = (
  userId: string,
  rank: number,
  name: string | null,
  hidden = false,
  position = rank,
) => ({
  userId,
  rank,
  position,
  name,
  hidden,
  totalPoints: 100 - rank,
  totalEvents: 1,
});

describe("shapeLeaderboard", () => {
  it("keeps the rank the database gave, and marks the viewer", () => {
    const board = shapeLeaderboard(
      [row("a", 1, "Ada"), row("b", 2, "Bea")],
      "b",
      10,
    );
    expect(board.top.map((entry) => [entry.name, entry.rank])).toEqual([
      ["Ada", 1],
      ["Bea", 2],
    ]);
    expect(board.top[1]?.isYou).toBe(true);
    expect(board.you).toEqual({ rank: 2, totalPoints: 98, totalEvents: 1 });
  });

  it("keeps tied members on one rank and cuts at N rows by position", () => {
    const board = shapeLeaderboard(
      [
        row("a", 1, "Ada", false, 1),
        row("b", 2, "Bea", false, 2),
        row("c", 2, "Cy", false, 3),
        row("d", 2, "Di", false, 4),
        row("e", 5, "Eve", false, 5),
      ],
      "d",
      3,
    );
    expect(board.top.map((entry) => [entry.name, entry.rank])).toEqual([
      ["Ada", 1],
      ["Bea", 2],
      ["Cy", 2],
    ]);
    // The viewer is tied at 2 but past the cut: still told the shared rank.
    expect(board.you).toMatchObject({ rank: 2 });
  });

  it("falls back to Member when the account has no name", () => {
    const board = shapeLeaderboard([row("x", 1, null)], "x", 10);
    expect(board.top[0]?.name).toBe("Member");
  });

  it("sends no name for a hidden member, only their place", () => {
    const board = shapeLeaderboard(
      [row("a", 1, "Ada Lovelace", true), row("b", 2, "Bea")],
      "b",
      10,
    );
    expect(board.top[0]).toMatchObject({
      rank: 1,
      name: null,
      anonymous: true,
    });
    expect(JSON.stringify(board)).not.toContain("Ada Lovelace");
  });

  it("reports a viewer below the top N as `you` only", () => {
    const board = shapeLeaderboard(
      [row("a", 1, "Ada"), row("b", 2, "Bea"), row("z", 9, "Zed")],
      "z",
      2,
    );
    expect(board.top.map((entry) => entry.rank)).toEqual([1, 2]);
    expect(board.you).toMatchObject({ rank: 9 });
  });

  it("has no standing for a viewer who is not on the board", () => {
    expect(shapeLeaderboard([row("a", 1, "Ada")], "q", 10).you).toBeNull();
  });

  it("carries a name and totals only, never an email, id or image", () => {
    const board = shapeLeaderboard([row("a", 1, "Ada")], "q", 10);
    expect(Object.keys(board.top[0]!).sort()).toEqual([
      "anonymous",
      "isYou",
      "name",
      "rank",
      "totalEvents",
      "totalPoints",
    ]);
  });
});
