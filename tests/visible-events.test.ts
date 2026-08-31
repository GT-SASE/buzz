import { describe, expect, it } from "vitest";

import { visibleEvents } from "../sites/web/src/app/portal/(member)/admin/visible-events";

const december = {
  id: "dec",
  title: "December GBM + exam destress",
  startsAt: new Date("2026-12-08T23:00:00.000Z"),
  archivedAt: null,
  isPast: false,
};

const orgFair = {
  id: "sep",
  title: "Fall Org Fair",
  startsAt: new Date("2026-09-01T15:00:00.000Z"),
  archivedAt: null,
  isPast: false,
};

const lastGbm = {
  id: "past",
  title: "April GBM",
  startsAt: new Date("2026-04-07T22:00:00.000Z"),
  archivedAt: null,
  isPast: true,
};

describe("visibleEvents", () => {
  it("puts the next open event first, not the furthest one", () => {
    const ranked = visibleEvents([december, orgFair], "Open");

    expect(ranked.map((event) => event.title)).toEqual([
      "Fall Org Fair",
      "December GBM + exam destress",
    ]);
  });

  it("keeps the newest past event at the top", () => {
    const older = {
      ...lastGbm,
      id: "older",
      title: "January GBM",
      startsAt: new Date("2026-01-16T23:00:00.000Z"),
    };

    const ranked = visibleEvents([older, lastGbm], "Past");

    expect(ranked.map((event) => event.title)).toEqual([
      "April GBM",
      "January GBM",
    ]);
  });
});
