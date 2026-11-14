import { describe, expect, it } from "bun:test";
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
    ["5 pm", "17:00"],
    ["12:00 AM", "00:00"],
    ["17:30", "17:30"],
  ])("reads %j as %s", (typed, stored) => {
    expect(parsePickupTime(typed)).toEqual({ ok: true, time: stored });
  });

  it.each(["5:30", "13:00 PM", "24:00", "half five", 1730])(
    "refuses %j",
    (typed) => {
      const parsed = parsePickupTime(typed);

      expect(parsed.ok).toBe(false);
      expect(!parsed.ok && safeTextValue(parsed.problem)).toContain(
        "Enter the pickup time",
      );
    },
  );
});

describe("hasInviteOrMaskedLink", () => {
  it.each([
    "discord.gg/abc",
    "Social [log in](https://evil.example)",
    "disc\u034Ford.gg/x",
    "discord\uFE00.gg/x",
  ])("finds one in %j", (name) => {
    expect(hasInviteOrMaskedLink(name)).toBe(true);
  });

  it.each(["Fall Social", "Budget (draft) [v2]"])(
    "finds none in %j",
    (name) => {
      expect(hasInviteOrMaskedLink(name)).toBe(false);
    },
  );
});

describe("normaliseEventName", () => {
  it("keeps an ordinary name, and gives the post title the same text", () => {
    const named = normaliseEventName("Café ☕ night & Mixer 2026!");

    expect(named?.name).toBe("Café ☕ night & Mixer 2026!");
    expect(plainTextValue(named?.title as never)).toBe(named?.name ?? "");
  });

  it.each(HOSTILE_TEXT)("leaves nothing live in: %s", (_label, text) => {
    const name = normaliseEventName(text)?.name;

    if (name !== undefined) {
      // No character here can open a mention, link, domain or markdown.
      expect(name).not.toMatch(/[@<>#[\]`|*_~:/\\.]/u);
      expect(name).not.toMatch(/[\n\r\u2028\u202A-\u202E\u2066-\u2069\u200B]/u);
      expect(normaliseEventName(name)?.name).toBe(name);
    }
  });

  it.each([...INVISIBLE_TEXT, ...UNSTORABLE_TEXT, ["punctuation", "@#:/"]])(
    "refuses %s",
    (_label, text) => {
      expect(normaliseEventName(text)).toBeUndefined();
    },
  );

  it("counts length in the stricter unit, at the boundary", () => {
    expect(normaliseEventName("😀".repeat(50))?.name).toBe("😀".repeat(50));
    expect(normaliseEventName("😀".repeat(51))).toBeUndefined();
    expect(normaliseEventName("x".repeat(101))).toBeUndefined();
  });
});

describe("parseEventDate", () => {
  const ZONE = "America/New_York";
  // 04:30 UTC on the 16th is still the 15th in New York.
  const NOW = new Date("2026-11-16T04:30:00.000Z");

  it("reads both forms against the guild's today, not the server's", () => {
    const parsed: unknown = parseEventDate(" 11/15 ", ZONE, NOW);
    expect(parsed).toEqual({
      ok: true,
      date: "2026-11-15",
    });
    expect(parseEventDate("2026-11-15", ZONE, NOW).ok).toBe(true);
    expect(parseEventDate("2026-11-15", "Asia/Tokyo", NOW).ok).toBe(false);
  });

  it("explains a past date differently from a bad one", () => {
    const past = parseEventDate("2020-01-01", ZONE, NOW);
    const bad = parseEventDate("2026-02-30", ZONE, NOW);

    expect(!past.ok && safeTextValue(past.problem)).toContain("passed");
    expect(!bad.ok && safeTextValue(bad.problem)).toContain("isn't valid");
  });
});
