import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type Metrics = {
  total: number;
  officers: number;
  withCheckIns: number;
  neverCheckedIn: number;
  activeLast30: number;
  activeThisYear: number;
  newLast30: number;
  totalPoints: number;
  averagePoints: number;
  tiers: { min: number; members: number }[];
  since: { last30: Date; schoolYear: Date };
};

const answer: { data: Metrics | null; sent: number[] } = {
  data: null,
  sent: [],
};

vi.mock("~/trpc/react", () => ({
  api: {
    member: {
      metrics: {
        useQuery: (input: { tiers: number[] }) => {
          answer.sent = input.tiers;
          return { isPending: false, error: null, data: answer.data };
        },
      },
    },
  },
}));

import { RosterMetrics } from "../sites/web/src/app/portal/(member)/admin/members/roster-metrics";

const FULL: Metrics = {
  total: 40,
  officers: 3,
  withCheckIns: 30,
  neverCheckedIn: 10,
  activeLast30: 12,
  activeThisYear: 22,
  newLast30: 5,
  totalPoints: 800,
  averagePoints: 20,
  tiers: [
    { min: 0, members: 18 },
    { min: 25, members: 14 },
    { min: 75, members: 6 },
    { min: 150, members: 2 },
  ],
  since: {
    last30: new Date("2026-08-03T00:00:00.000Z"),
    schoolYear: new Date("2026-08-01T04:00:00.000Z"),
  },
};

afterEach(() => {
  cleanup();
  answer.data = null;
  answer.sent = [];
});

describe("RosterMetrics", () => {
  it("reports the roster in figures", () => {
    answer.data = FULL;
    render(<RosterMetrics />);

    expect(
      screen.getByRole("heading", { name: "Roster at a glance" }),
    ).toBeTruthy();
    expect(screen.getByText("40")).toBeTruthy();
    expect(screen.getByText("3 officers")).toBeTruthy();
    expect(screen.getByText("22")).toBeTruthy();
    expect(
      screen.getByText("55% of the roster · 12 in the last 30 days"),
    ).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    // One decimal, so the figure does not change shape week to week.
    expect(screen.getByText("20.0")).toBeTruthy();
    expect(screen.getByText("10 never checked in")).toBeTruthy();
  });

  /** The floors are the contract between the card and the server's banding. */
  it("asks for the bands the tier table is built from", () => {
    answer.data = FULL;
    render(<RosterMetrics />);

    expect(answer.sent).toEqual([0, 25, 75, 150]);
  });

  it("names each band and gives its share of the roster", () => {
    answer.data = FULL;
    render(<RosterMetrics />);

    expect(screen.getByText("Distinguished")).toBeTruthy();
    expect(screen.getByText("150+ pts")).toBeTruthy();
    // 18 of 40 in the bottom band, 2 of 40 in the top.
    expect(screen.getByText("45%")).toBeTruthy();
    expect(screen.getByText("5%")).toBeTruthy();
  });

  /**
   * Bands are matched on their floor, not on their position in the response.
   * A count under the wrong name reads as fact and is worse than a zero.
   */
  it("shows a band the server did not answer for as empty", () => {
    answer.data = { ...FULL, tiers: [{ min: 0, members: 40 }] };
    render(<RosterMetrics />);

    const distinguished = screen.getByText("Distinguished").closest("li");
    expect(distinguished?.textContent).toContain("0");
    expect(distinguished?.textContent).not.toContain("40");
  });

  it("says nobody has signed in rather than showing four zeroes", () => {
    answer.data = {
      ...FULL,
      total: 0,
      officers: 0,
      withCheckIns: 0,
      neverCheckedIn: 0,
      activeLast30: 0,
      activeThisYear: 0,
      newLast30: 0,
      totalPoints: 0,
      averagePoints: 0,
      tiers: FULL.tiers.map((band) => ({ ...band, members: 0 })),
    };
    render(<RosterMetrics />);

    expect(screen.getByText("Nobody has signed in yet.")).toBeTruthy();
    expect(screen.queryByText("Distinguished")).toBeNull();
  });
});
