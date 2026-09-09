import { describe, expect, it } from "vitest";

import { codeFromScan } from "~/app/portal/(member)/check-in/scanner";
import {
  checkInQrUrl,
  CHECK_IN_QR_RENDER,
} from "~/app/portal/_components/check-in-qr";
import { tiers, tierFor, mentorshipTierFor } from "~/data/portal";
import { site } from "~/data/site";

const top = tiers[tiers.length - 1]!;

describe("tiers", () => {
  /**
   * `tierFor` walks the table once and keeps the LAST band it clears plus the
   * FIRST it does not (`next ??=`). Both of those are only the right answers
   * while the table is sorted ascending, and nothing in the type enforces it —
   * a board that appends a retuned band to the end of the array instead of
   * inserting it in order would break every card on the portal without
   * touching a line of `tierFor`.
   */
  it("is sorted ascending and starts at zero", () => {
    expect(tiers[0].min).toBe(0);
    const mins = tiers.map((tier) => tier.min);
    expect(mins).toEqual([...mins].sort((a, b) => a - b));
    expect(new Set(mins).size).toBe(mins.length);
  });
});

describe("tierFor", () => {
  it("names the highest band the total actually clears", () => {
    for (let index = 0; index < tiers.length; index++) {
      const floor = tiers[index]!;
      expect(tierFor(floor.min).name).toBe(floor.name);
      expect(tierFor(floor.min).level).toBe(index + 1);
      const next = tiers[index + 1];
      if (next) {
        expect(tierFor(next.min - 1).name).toBe(floor.name);
      }
    }
  });

  it("points at the band above, never one already cleared", () => {
    for (let index = 0; index < tiers.length - 1; index++) {
      const floor = tiers[index]!;
      const next = tiers[index + 1]!;
      expect(tierFor(floor.min).next).toBe(next.name);
      expect(tierFor(next.min - 1).next).toBe(next.name);
    }
  });

  it("counts the points still owed to that next band", () => {
    for (let index = 0; index < tiers.length - 1; index++) {
      const floor = tiers[index]!;
      const next = tiers[index + 1]!;
      expect(tierFor(floor.min).pointsToNext).toBe(next.min - floor.min);
      expect(tierFor(next.min - 1).pointsToNext).toBe(1);
    }
  });

  /**
   * The arithmetic invariant behind the "N points to Active" line on the card:
   * earning exactly that many more has to land you in exactly that band. An
   * off-by-one anywhere in the loop shows up here and nowhere else, because
   * every individual number above still looks plausible on its own.
   */
  it("promises a promotion that earning pointsToNext actually delivers", () => {
    for (let points = 0; points <= top.min + 10; points++) {
      const tier = tierFor(points);
      if (tier.pointsToNext === null) {
        expect(tier.next).toBeUndefined();
        continue;
      }
      expect(tier.pointsToNext).toBeGreaterThan(0);
      expect(tierFor(points + tier.pointsToNext).name).toBe(tier.next);
    }
  });

  it("runs progress from 0 at the floor of a band to just under 1 at its top", () => {
    for (let index = 0; index < tiers.length - 1; index++) {
      const floor = tiers[index]!;
      const next = tiers[index + 1]!;
      const width = next.min - floor.min;
      expect(tierFor(floor.min).progress).toBe(0);
      expect(tierFor(next.min - 1).progress).toBeCloseTo((width - 1) / width, 10);
    }
  });

  it("stops at the top band instead of inventing another one", () => {
    for (const points of [top.min, top.min + 1, 900, Number.MAX_SAFE_INTEGER]) {
      const tier = tierFor(points);
      expect(tier.name).toBe(top.name);
      expect(tier.next).toBeUndefined();
      expect(tier.pointsToNext).toBeNull();
      expect(tier.progress).toBe(1);
    }
  });

  /**
   * `totalPoints` is a coalesced SUM, so a single hand-edited or corrected
   * check-in row can hand this function a total below the lowest band. It must
   * degrade to the bottom tier rather than throw on the member's own card,
   * which is the one page they cannot route around.
   */
  it("does not throw on a nonsense total", () => {
    expect(() => tierFor(-5)).not.toThrow();
    expect(() => tierFor(Number.NaN)).not.toThrow();
    expect(() => tierFor(-Number.MAX_SAFE_INTEGER)).not.toThrow();
    expect(tierFor(-5).name).toBe(tiers[0]!.name);
  });

  /**
   * The field's own contract is "0-1 through the current band", and the card
   * feeds it straight into `width: ${Math.round(progress * 100)}%`. Anything
   * outside 0..1 is a bar drawn outside its track or a dropped declaration.
   */
  it("keeps progress inside 0..1", () => {
    const samples = [
      0,
      1,
      ...tiers.map((tier) => tier.min),
      top.min - 1,
      top.min,
      500,
    ];
    for (const points of samples) {
      const { progress } = tierFor(points);
      expect(progress).toBeGreaterThanOrEqual(0);
      expect(progress).toBeLessThanOrEqual(1);
    }

    expect(tierFor(-5).progress).toBeGreaterThanOrEqual(0);
  });
});

describe("mentorshipTierFor", () => {
  it("never shares a band with the event card", () => {
    expect(mentorshipTierFor(0).name).toBe("Signed up");
    expect(mentorshipTierFor(9).name).toBe("Signed up");
    expect(mentorshipTierFor(10).name).toBe("Meeting");
    expect(mentorshipTierFor(29).name).toBe("Meeting");
    expect(mentorshipTierFor(30).name).toBe("Kin");
    expect(mentorshipTierFor(0).next).toBe("Meeting");
    expect(mentorshipTierFor(10).pointsToNext).toBe(20);
  });
});

describe("codeFromScan", () => {
  it("pulls the code out of a full check-in URL", () => {
    expect(codeFromScan(`${site.url}/portal/check-in?code=ABCD2345`)).toBe(
      "ABCD2345",
    );
    expect(codeFromScan(`${site.url}/portal/check-in?code=abcd2345`)).toBe(
      "ABCD2345",
    );
    expect(
      codeFromScan(`${site.url}/portal/check-in?from=qr&code=abcd2345#x`),
    ).toBe("ABCD2345");
    expect(codeFromScan(`${site.url}/portal/check-in#code=ABCD2345`)).toBe(
      "ABCD2345",
    );
    expect(codeFromScan(`${site.url}/portal/check-in#ABCD2345`)).toBe(
      "ABCD2345",
    );
  });

  it("accepts a bare code in either case, with the scanner's whitespace", () => {
    expect(codeFromScan("ABCD2345")).toBe("ABCD2345");
    expect(codeFromScan("abcd2345")).toBe("ABCD2345");
    expect(codeFromScan("  abcd2345\n")).toBe("ABCD2345");
    // A QR reader hands back the URL with the same trailing newline.
    expect(codeFromScan(`  ${site.url}/check-in?code=abcd2345 \n`)).toBe(
      "ABCD2345",
    );
  });

  it("takes the length bounds inclusively", () => {
    expect(codeFromScan("ABC234")).toBe("ABC234");
    expect(codeFromScan("ABCDEFGHJK23")).toBe("ABCDEFGHJK23");
    expect(codeFromScan("ABC23")).toBeNull();
    expect(codeFromScan("ABCDEFGHJK234")).toBeNull();
    expect(codeFromScan("")).toBeNull();
  });

  /**
   * The one job of the alphabet check: an unrelated QR in the room must be a
   * miss, not a guess fired at the check-in endpoint.
   */
  it("rejects a payload that is not a code", () => {
    expect(codeFromScan(`${site.url}/portal/check-in`)).toBeNull();
    expect(codeFromScan(`${site.url}/portal/check-in?code=`)).toBeNull();
    expect(codeFromScan(`${site.url}/events`)).toBeNull();
    expect(codeFromScan("WIFI:S=GTGuest;T=WPA;P=hunter2;;")).toBeNull();
    expect(codeFromScan("tel:+14045550100")).toBeNull();
    expect(codeFromScan("BEGIN:VCARD")).toBeNull();
    expect(codeFromScan("ABCD 2345")).toBeNull();
    expect(codeFromScan("ABCD-2345")).toBeNull();
  });

  /**
   * The generator's alphabet is `23456789ABCDEFGHJKMNPQRSTVWXYZ`
   * (packages/api/src/routers/event.ts) — Crockford-style, with no I, L, O, U,
   * 0 or 1, because members read these off a projector. A code containing one
   * of those glyphs cannot have been issued, so accepting it is exactly the
   * misread this function exists to stop.
   */
  it("rejects the ambiguous glyphs the generator never issues", () => {
    expect(codeFromScan("SASE0GT2")).toBeNull();
    expect(codeFromScan("SASE1GT2")).toBeNull();
    expect(codeFromScan("SASEIGT2")).toBeNull();
    expect(codeFromScan("SASEOGT2")).toBeNull();
    expect(codeFromScan("SASEUGT2")).toBeNull();
    expect(codeFromScan("SASELGT2")).toBeNull();
  });

  /**
   * The URL branch used to return the `code` parameter verbatim, from any
   * origin: any QR anywhere carrying a `?code=` — an OAuth callback, a coupon
   * link taped to the same wall — became a check-in attempt. One short enough
   * to fail the procedure's `z.string().min(4)` came back as a raw ZodError
   * blob rendered at the member.
   *
   * It is held to the same alphabet as a bare code now, so a payload the
   * generator could never have issued is a miss and the scanner keeps looking
   * rather than firing a request.
   */
  it("applies the alphabet to a code parameter too, whatever the origin", () => {
    expect(
      codeFromScan("https://example.com/callback?code=hello-world-01"),
    ).toBeNull();
    expect(codeFromScan("https://example.com/?code=x")).toBeNull();
    // Too short for the procedure to accept, which is what produced the raw
    // ZodError; it never leaves the client now.
    expect(codeFromScan(`${site.url}/portal/check-in?code=ABC`)).toBeNull();
    // The glyphs the generator never issues are refused here as well.
    expect(
      codeFromScan(`${site.url}/portal/check-in?code=SASE0GT2`),
    ).toBeNull();
  });

  /** A genuine check-in URL still works, which is the branch's whole job. */
  it("still takes the code out of the officer's own QR", () => {
    expect(codeFromScan(`${site.url}/portal/check-in?code=ABCD2345`)).toBe(
      "ABCD2345",
    );
    expect(checkInQrUrl(site.url, "ABCD2345")).toBe(
      `${site.url}/portal/check-in#code=ABCD2345`,
    );
    expect(CHECK_IN_QR_RENDER.color).toEqual({
      dark: "#000000ff",
      light: "#ffffffff",
    });
    expect(CHECK_IN_QR_RENDER.margin).toBeGreaterThanOrEqual(4);
  });
});

