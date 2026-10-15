import { describe, expect, it } from "vitest";

import {
  rescorePoints,
  type RescoreCheckIn,
  type RescoreEvent,
  type RescoreRole,
} from "../packages/api/src/rescore-points";

const DAY = 24 * 60 * 60 * 1000;
const at = (day: number, minute = 0) =>
  new Date(Date.UTC(2030, 0, 1) + day * DAY + minute * 60_000);

function event(
  id: string,
  day: number,
  pointsValue = 10,
  archived = false,
): RescoreEvent {
  return {
    id,
    startsAt: at(day),
    pointsValue,
    archivedAt: archived ? at(100) : null,
  };
}

function checkIn(
  id: string,
  eventId: string,
  userId: string,
  day: number,
  minute: number,
  pointsEarned = 0,
): RescoreCheckIn {
  return {
    id,
    eventId,
    userId,
    checkedInAt: at(day, minute),
    pointsEarned,
    method: "code",
  };
}

const roles = (entries: Record<string, RescoreRole>) =>
  new Map(Object.entries(entries));

const pointsById = (rows: { id: string; newPoints: number }[]) =>
  Object.fromEntries(rows.map((row) => [row.id, row.newPoints]));

const events = [event("E1", 1), event("E2", 2)];
const checkIns = [
  checkIn("c1", "E1", "O", 1, 0),
  checkIn("c2", "E1", "A", 1, 1),
  checkIn("c3", "E1", "B", 1, 2),
  checkIn("c4", "E2", "A", 2, 1),
  checkIn("c5", "E2", "B", 2, 2),
];

describe("rescorePoints", () => {
  it("replays through the live rules with running totals", () => {
    const { rows } = rescorePoints({
      events,
      checkIns,
      roles: roles({ O: "ADMIN" }),
    });
    expect(pointsById(rows)).toEqual({
      // Officer: base only, no early-bird spot used.
      c1: 10,
      // First member: 10 + 5, nobody else to compare to.
      c2: 15,
      // 10 + 4, plus catch-up half of (15 - 0) = 8; the officer's points are not
      // in the median.
      c3: 22,
      // 10 + 5 early + 2 streak + catch-up ceil((22 - 15) / 2) = 4.
      c4: 21,
      // 10 + 4 early + 2 streak + catch-up ceil((36 - 22) / 2) = 7.
      c5: 23,
    });
  });

  it("replays by checkedInAt then id, whatever order the rows arrive in", () => {
    const forward = rescorePoints({
      events,
      checkIns,
      roles: roles({ O: "ADMIN" }),
    });
    const shuffled = rescorePoints({
      events: [...events].reverse(),
      checkIns: [...checkIns].reverse(),
      roles: roles({ O: "ADMIN" }),
    });
    expect(pointsById(shuffled.rows)).toEqual(pointsById(forward.rows));

    // Same instant: the id decides who was first.
    const tie = rescorePoints({
      events: [event("E1", 1)],
      checkIns: [
        checkIn("b", "E1", "U2", 1, 0),
        checkIn("a", "E1", "U1", 1, 0),
      ],
      roles: roles({}),
    });
    expect(pointsById(tie.rows)).toMatchObject({ a: 15 });
    expect(pointsById(tie.rows).b).toBe(14 + 8);
  });

  it("scores today's role, not the role at the time", () => {
    const asMember = rescorePoints({ events, checkIns, roles: roles({}) });
    expect(pointsById(asMember.rows).c1).toBe(15);
    // As members O took the first spot (A: 10 + 4 early + 8 catch-up).
    expect(pointsById(asMember.rows).c2).toBe(22);
    const asOfficer = rescorePoints({
      events,
      checkIns,
      roles: roles({ O: "SUPER_ADMIN", A: "ADMIN" }),
    });
    expect(pointsById(asOfficer.rows).c1).toBe(10);
    expect(pointsById(asOfficer.rows).c2).toBe(10);
    expect(pointsById(asOfficer.rows).c4).toBe(10);
  });

  it("scores an archived event's rows but lets them feed nothing", () => {
    const archived = event("X", 0, 10, true);
    const withArchived = rescorePoints({
      events: [archived, ...events],
      checkIns: [
        checkIn("x1", "X", "A", 0, 0),
        checkIn("x2", "X", "B", 0, 1),
        ...checkIns,
      ],
      roles: roles({ O: "ADMIN" }),
    });
    const without = rescorePoints({
      events,
      checkIns,
      roles: roles({ O: "ADMIN" }),
    });
    const points = pointsById(withArchived.rows);
    // Same formula, arrival order counted inside the archived event.
    expect(points.x1).toBe(15);
    expect(points.x2).toBe(14);
    // Every live row is exactly what it was with no archived event around:
    // no streak from X, no totals in the median, no arrivals used up.
    for (const row of without.rows) expect(points[row.id]).toBe(row.newPoints);
    expect(withArchived.users).toEqual(without.users);
  });

  it("gives zero for a zero-point listing, officer or member", () => {
    const { rows } = rescorePoints({
      events: [event("Z", 1, 0)],
      checkIns: [checkIn("z1", "Z", "O", 1, 0), checkIn("z2", "Z", "A", 1, 1)],
      roles: roles({ O: "ADMIN" }),
    });
    expect(pointsById(rows)).toEqual({ z1: 0, z2: 0 });
  });

  it("reports before and after totals and ranks, best first", () => {
    const old = [10, 10, 30, 5, 5];
    const { users } = rescorePoints({
      events,
      checkIns: checkIns.map((row, i) => ({ ...row, pointsEarned: old[i]! })),
      roles: roles({ O: "ADMIN" }),
    });
    expect(users.map((u) => u.userId)).toEqual(["B", "A", "O"]);
    expect(users.map((u) => u.newRank)).toEqual([1, 2, 3]);
    const b = users.find((u) => u.userId === "B")!;
    expect(b).toMatchObject({ oldTotal: 35, newTotal: 45, oldRank: 1 });
    const a = users.find((u) => u.userId === "A")!;
    expect(a).toMatchObject({ oldTotal: 15, newTotal: 36, oldRank: 2 });
    expect(users.find((u) => u.userId === "O")).toMatchObject({
      oldTotal: 10,
      newTotal: 10,
      oldRank: 3,
      newRank: 3,
    });
  });

  it("breaks rank ties by earlier first check-in, then id", () => {
    const { users } = rescorePoints({
      events: [event("E1", 1)],
      checkIns: [
        checkIn("a", "E1", "late", 1, 5),
        checkIn("b", "E1", "early", 1, 1),
      ],
      roles: roles({ early: "ADMIN", late: "ADMIN" }),
    });
    expect(users.map((u) => u.userId)).toEqual(["early", "late"]);
  });

  it("is idempotent: re-running over its own output changes nothing", () => {
    const first = rescorePoints({
      events,
      checkIns,
      roles: roles({ O: "ADMIN" }),
    });
    const second = rescorePoints({
      events,
      checkIns: checkIns.map((row) => ({
        ...row,
        pointsEarned: pointsById(first.rows)[row.id]!,
      })),
      roles: roles({ O: "ADMIN" }),
    });
    expect(second.rows.filter((r) => r.oldPoints !== r.newPoints)).toEqual([]);
    expect(second.users.every((u) => u.oldTotal === u.newTotal)).toBe(true);
    expect(second.users.every((u) => u.oldRank === u.newRank)).toBe(true);
  });

  it("rejects a check-in on an unknown event", () => {
    expect(() =>
      rescorePoints({
        events: [],
        checkIns: [checkIn("c", "nope", "A", 1, 0)],
        roles: roles({}),
      }),
    ).toThrow(/unknown event/);
  });
});
