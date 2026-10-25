import { describe, expect, it } from "vitest";

import { barDays, summarize, type UptimeHistory } from "~/lib/uptime";

// 18:00 UTC is 14:00 in Atlanta, the same calendar day.
const now = new Date("2026-10-25T18:00:00Z");

const bucket = (checks: number, up: number, ms: number) => ({
  checks,
  up,
  totalMs: up * ms,
});

function history(overrides: Partial<UptimeHistory> = {}): UptimeHistory {
  return {
    version: 2,
    site: "https://buzzsase.vercel.app",
    checkedAt: "2026-10-25T17:55:00Z",
    checks: [
      { id: "site", name: "Public website", path: "/about" },
      { id: "auth", name: "Google sign-in", path: "/api/auth/providers" },
    ],
    latest: { site: { up: true, ms: 80 }, auth: { up: true, ms: 200 } },
    recent: [
      { at: "2026-10-25T17:45:00Z", ms: { site: 90, auth: null } },
      { at: "2026-10-25T17:55:00Z", ms: { site: 80, auth: 200 } },
    ],
    days: [
      {
        date: "2026-10-25",
        checks: 100,
        up: 99,
        byCheck: { site: bucket(100, 100, 100), auth: bucket(100, 99, 200) },
      },
      {
        date: "2026-10-24",
        checks: 100,
        up: 100,
        byCheck: { site: bucket(100, 100, 100), auth: bucket(100, 100, 300) },
      },
      // Outside the 30-day window, inside 90.
      {
        date: "2026-08-01",
        checks: 100,
        up: 0,
        byCheck: { site: bucket(100, 0, 0), auth: bucket(100, 0, 0) },
      },
    ],
    incidents: [
      // 17:45 UTC on the 25th is still the 25th in Atlanta.
      { at: "2026-10-25T17:45:00Z", id: "auth", detail: "HTTP 500" },
      // 02:00 UTC on the 25th is the evening of the 24th in Atlanta.
      { at: "2026-10-25T02:00:00Z", id: "site", detail: "No response in 10 s" },
    ],
    ...overrides,
  };
}

describe("uptime summary", () => {
  it("is up only when every check passed recently", () => {
    expect(summarize(history(), now).state).toBe("up");
    const down = history({
      latest: { site: { up: true, ms: 80 }, auth: { up: false, ms: null } },
    });
    expect(summarize(down, now).state).toBe("down");
  });

  it("reports stale once the probe has not run for a while", () => {
    const summary = summarize(
      history({ checkedAt: "2026-10-25T16:00:00Z" }),
      now,
    );
    expect(summary.state).toBe("stale");
  });

  it("weights each window by checks, not by days", () => {
    const [week, month, quarter] = summarize(history(), now).windows;
    expect(week).toEqual({ days: 7, percent: 99.5 });
    expect(month).toEqual({ days: 30, percent: 99.5 });
    expect(quarter?.percent).toBeCloseTo((199 / 300) * 100);
  });

  it("summarizes each feature on its own", () => {
    const [site, auth] = summarize(history(), now).features;
    expect(site?.averageMs).toBe(100);
    expect(auth?.averageMs).toBe(Math.round((99 * 200 + 100 * 300) / 199));
    expect(auth?.uptime).toBeCloseTo((199 / 300) * 100);
    expect(auth?.recent.map((sample) => sample.ms)).toEqual([null, 200]);
  });

  it("draws one day per bar ending today, blank where unchecked", () => {
    const { days } = summarize(history(), now);
    expect(days).toHaveLength(barDays);
    expect(days.at(-1)?.date).toBe("2026-10-25");
    expect(days.at(-1)?.percent).toBe(99);
    expect(days.at(-3)).toMatchObject({ date: "2026-10-23", percent: null });
  });

  it("files each failure under the chapter's date", () => {
    const { days } = summarize(history(), now);
    expect(days.at(-1)?.incidents).toMatchObject([
      { name: "Google sign-in", detail: "HTTP 500" },
    ]);
    expect(days.at(-2)?.incidents).toMatchObject([
      { name: "Public website", detail: "No response in 10 s" },
    ]);
  });

  it("uses the chapter's today, not UTC's", () => {
    // 01:00 UTC on the 26th is still the 25th in Atlanta.
    const late = new Date("2026-10-26T01:00:00Z");
    const summary = summarize(
      history({ checkedAt: "2026-10-26T00:55:00Z" }),
      late,
    );
    expect(summary.days.at(-1)?.date).toBe("2026-10-25");
  });

  it("has no numbers before the first check", () => {
    const summary = summarize(history({ days: [] }), now);
    expect(summary.features[0]?.averageMs).toBeNull();
    expect(summary.windows.every((window) => window.percent === null)).toBe(
      true,
    );
  });
});
