import { describe, expect, it } from "vitest";
import {
  HOSTILE_TEXT,
  INVISIBLE_TEXT,
  UNSTORABLE_TEXT,
} from "../../test/support/hostile-text.ts";
import { plainTextValue, safeTextValue } from "../discord/safe-text.ts";
import {
  hasInviteOrMaskedLink,
  normaliseEventName,
  parseEventDate,
  parsePickupTime,
} from "./input.ts";

describe("parsePickupTime", () => {
  it.each([
    ["5:30 PM", "17:30"],
    ["5:30pm", "17:30"],
    ["5 pm", "17:00"],
    ["5:30 p.m.", "17:30"],
    [" 11:15 AM ", "11:15"],
    ["12:00 AM", "00:00"],
    ["12:30 PM", "12:30"],
    ["17:30", "17:30"],
    ["09:05", "09:05"],
    ["00:00", "00:00"],
  ])("reads %j as %s", (typed, stored) => {
    expect(parsePickupTime(typed)).toEqual({ ok: true, time: stored });
  });

  it.each([
    "5:30",
    "13:00 PM",
    "24:00",
    "17:60",
    "0:30 AM",
    "half five",
    "",
    "5:30 PM tomorrow",
    "1".repeat(40),
  ])("refuses %j", (typed) => {
    const parsed = parsePickupTime(typed);

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && safeTextValue(parsed.problem)).toContain(
      "Enter the pickup time",
    );
  });

  it("refuses a value that is not text", () => {
    expect(parsePickupTime(1730).ok).toBe(false);
    expect(parsePickupTime(undefined).ok).toBe(false);
  });
});

const ZONE = "America/New_York";
// 04:30 UTC on the 16th is still the 15th in New York.
const NOW = new Date("2026-11-16T04:30:00.000Z");

describe("hasInviteOrMaskedLink", () => {
  it.each([
    "discord.gg/abc",
    "Social [log in](https://evil.example)",
    "disc\u034Ford.gg/x",
    "discord\uFE00.gg/x",
  ])("finds one in %j", (name) => {
    expect(hasInviteOrMaskedLink(name)).toBe(true);
  });

  it.each(["Fall Social", "Budget (draft) [v2]", 42, undefined])(
    "finds none in %j",
    (name) => {
      expect(hasInviteOrMaskedLink(name)).toBe(false);
    },
  );
});

describe("normaliseEventName", () => {
  it("keeps an ordinary name as it is", () => {
    expect(normaliseEventName("Fall Social & Mixer 2026!")?.name).toBe(
      "Fall Social & Mixer 2026!",
    );
  });

  it("gives the same text to the database and to the post title", () => {
    const named = normaliseEventName("Café ☕ night");

    expect(named?.name).toBe("Café ☕ night");
    expect(plainTextValue(named?.title as never)).toBe(named?.name);
  });

  it.each(HOSTILE_TEXT)("leaves nothing live in: %s", (_label, text) => {
    const name = normaliseEventName(text)?.name;

    if (name !== undefined) {
      // No character here can open a mention, link, domain or markdown.
      expect(name).not.toMatch(/[@<>#[\]`|*_~:/\\.]/u);
      expect(name).not.toMatch(/[\n\r\u2028\u202A-\u202E\u2066-\u2069\u200B]/u);
    }
  });

  it.each(HOSTILE_TEXT)("settles after one pass: %s", (_label, text) => {
    const once = normaliseEventName(text)?.name;

    if (once !== undefined) {
      expect(normaliseEventName(once)?.name).toBe(once);
    }
  });

  it.each(INVISIBLE_TEXT)("refuses %s", (_label, text) => {
    expect(normaliseEventName(text)).toBeUndefined();
  });

  it.each(UNSTORABLE_TEXT)(
    "refuses %s rather than storing it",
    (_label, text) => {
      expect(normaliseEventName(text)).toBeUndefined();
    },
  );

  it.each([[undefined], [null], [5], [{}], [["a"]]])(
    "refuses the non-text value %j",
    (value) => {
      expect(normaliseEventName(value)).toBeUndefined();
    },
  );

  it("refuses punctuation with no letters", () => {
    expect(normaliseEventName("@#:/")).toBeUndefined();
  });

  it("counts length in the stricter unit, at the boundary", () => {
    const fits = "😀".repeat(50);

    expect(normaliseEventName(fits)?.name).toBe(fits);
    expect(normaliseEventName("😀".repeat(51))).toBeUndefined();
    expect(normaliseEventName("x".repeat(100))?.name).toHaveLength(100);
    expect(normaliseEventName("x".repeat(101))).toBeUndefined();
  });
});

describe("parseEventDate", () => {
  it("reads both forms in the guild's zone", () => {
    expect(parseEventDate("2026-11-20", ZONE, NOW)).toEqual({
      ok: true,
      date: "2026-11-20",
    });
    expect(parseEventDate(" 11/15 ", ZONE, NOW)).toEqual({
      ok: true,
      date: "2026-11-15",
    });
  });

  it("uses the guild's today, not the server's", () => {
    expect(parseEventDate("2026-11-15", ZONE, NOW).ok).toBe(true);
    expect(parseEventDate("2026-11-15", "Asia/Tokyo", NOW).ok).toBe(false);
    expect(parseEventDate("2026-11-14", ZONE, NOW).ok).toBe(false);
  });

  it("explains a past date differently from a bad one", () => {
    const past = parseEventDate("2020-01-01", ZONE, NOW);
    const bad = parseEventDate("soon", ZONE, NOW);

    expect(!past.ok && safeTextValue(past.problem)).toContain("passed");
    expect(!bad.ok && safeTextValue(bad.problem)).toContain("isn't valid");
  });

  it.each([
    "infinity",
    "2026-02-30",
    "2026-13-01",
    "12345-01-01",
    "2026-11-20,x",
    "2026-11-20\u0000",
    "",
    "1".repeat(5000),
    undefined,
    5,
  ])("refuses %j", (value) => {
    expect(parseEventDate(value, ZONE, NOW).ok).toBe(false);
  });
});
