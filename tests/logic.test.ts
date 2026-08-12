import { afterEach, describe, expect, it } from "vitest";

import { codeFromScan } from "~/app/portal/(member)/check-in/scanner";
import { tiers, tierFor } from "~/data/portal";
import { isOfficerEmail } from "../packages/auth/src/admins";

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
    expect(tierFor(0).name).toBe("Member");
    expect(tierFor(24).name).toBe("Member");
    expect(tierFor(25).name).toBe("Active");
    expect(tierFor(74).name).toBe("Active");
    expect(tierFor(75).name).toBe("Core");
    expect(tierFor(149).name).toBe("Core");
    expect(tierFor(150).name).toBe("Distinguished");
  });

  it("points at the band above, never one already cleared", () => {
    expect(tierFor(0).next).toBe("Active");
    expect(tierFor(24).next).toBe("Active");
    expect(tierFor(25).next).toBe("Core");
    expect(tierFor(74).next).toBe("Core");
    expect(tierFor(75).next).toBe("Distinguished");
    expect(tierFor(149).next).toBe("Distinguished");
  });

  it("counts the points still owed to that next band", () => {
    expect(tierFor(0).pointsToNext).toBe(25);
    expect(tierFor(24).pointsToNext).toBe(1);
    expect(tierFor(25).pointsToNext).toBe(50);
    expect(tierFor(74).pointsToNext).toBe(1);
    expect(tierFor(75).pointsToNext).toBe(75);
    expect(tierFor(149).pointsToNext).toBe(1);
  });

  /**
   * The arithmetic invariant behind the "N points to Active" line on the card:
   * earning exactly that many more has to land you in exactly that band. An
   * off-by-one anywhere in the loop shows up here and nowhere else, because
   * every individual number above still looks plausible on its own.
   */
  it("promises a promotion that earning pointsToNext actually delivers", () => {
    for (let points = 0; points <= 160; points++) {
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
    expect(tierFor(0).progress).toBe(0);
    expect(tierFor(24).progress).toBeCloseTo(0.96, 10);
    expect(tierFor(25).progress).toBe(0);
    expect(tierFor(50).progress).toBeCloseTo(0.5, 10);
    expect(tierFor(74).progress).toBeCloseTo(0.98, 10);
    expect(tierFor(75).progress).toBe(0);
    expect(tierFor(149).progress).toBeCloseTo(74 / 75, 10);
  });

  it("stops at the top band instead of inventing another one", () => {
    for (const points of [150, 151, 900, Number.MAX_SAFE_INTEGER]) {
      const tier = tierFor(points);
      expect(tier.name).toBe("Distinguished");
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
   *
   * Note what it reports today besides the name: `next` is also "Member" and
   * `pointsToNext` is 5, i.e. "5 points to the tier you are already in".
   */
  it("does not throw on a nonsense total", () => {
    expect(() => tierFor(-5)).not.toThrow();
    expect(() => tierFor(Number.NaN)).not.toThrow();
    expect(() => tierFor(-Number.MAX_SAFE_INTEGER)).not.toThrow();
    expect(tierFor(-5).name).toBe("Member");
  });

  /**
   * The field's own contract is "0-1 through the current band", and the card
   * feeds it straight into `width: ${Math.round(progress * 100)}%`. Anything
   * outside 0..1 is a bar drawn outside its track or a dropped declaration.
   */
  it("keeps progress inside 0..1", () => {
    for (const points of [0, 1, 24, 25, 74, 75, 149, 150, 500]) {
      const { progress } = tierFor(points);
      expect(progress).toBeGreaterThanOrEqual(0);
      expect(progress).toBeLessThanOrEqual(1);
    }

    // `Math.min` caps the ceiling; nothing holds the floor, and below the
    // lowest band the divisor `next.min - current.min` is 0 as well.
    expect(tierFor(-5).progress).toBeGreaterThanOrEqual(0);
  });
});

describe("isOfficerEmail", () => {
  const original = process.env.ADMIN_EMAILS;

  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = original;
  });

  it("matches an exact address and nothing else", () => {
    process.env.ADMIN_EMAILS = "officer@saseconnect.org";
    expect(isOfficerEmail("officer@saseconnect.org")).toBe(true);
    expect(isOfficerEmail("officer2@saseconnect.org")).toBe(false);
    expect(isOfficerEmail("officer@example.com")).toBe(false);
    expect(isOfficerEmail("xofficer@saseconnect.org")).toBe(false);
  });

  it("ignores case and surrounding whitespace on both sides", () => {
    process.env.ADMIN_EMAILS = "  Officer@SaseConnect.ORG ,  ";
    expect(isOfficerEmail("OFFICER@saseconnect.org")).toBe(true);
    expect(isOfficerEmail("  officer@SASECONNECT.org\n")).toBe(true);
  });

  /**
   * One Google account, several spellings. A member who signs in as
   * `a.b+sase@gmail.com` is the same inbox as the `ab@gmail.com` on the
   * allowlist, and an officer typing their own address into ADMIN_EMAILS with
   * their usual dots must not lock themselves out of the admin nav.
   */
  it("treats gmail dots and +tags as one inbox, in both directions", () => {
    process.env.ADMIN_EMAILS = "ab@gmail.com";
    expect(isOfficerEmail("a.b+sase@gmail.com")).toBe(true);
    expect(isOfficerEmail("a.b@gmail.com")).toBe(true);
    expect(isOfficerEmail("ab+anything@gmail.com")).toBe(true);
    expect(isOfficerEmail("ab@googlemail.com")).toBe(true);
    expect(isOfficerEmail("a.b+sase@googlemail.com")).toBe(true);

    process.env.ADMIN_EMAILS = "a.b+sase@gmail.com";
    expect(isOfficerEmail("ab@gmail.com")).toBe(true);
    expect(isOfficerEmail("abc@gmail.com")).toBe(false);
  });

  /**
   * The dot rule is a Gmail rule. Applying it everywhere would make
   * `a.b@saseconnect.org` and `ab@saseconnect.org` the same person on a domain
   * where they are two different mailboxes — that is a privilege grant to
   * whoever registers the other spelling.
   */
  it("does not strip dots or +tags outside gmail", () => {
    process.env.ADMIN_EMAILS = "a.b@saseconnect.org";
    expect(isOfficerEmail("a.b@saseconnect.org")).toBe(true);
    expect(isOfficerEmail("ab@saseconnect.org")).toBe(false);
    expect(isOfficerEmail("a.b+x@saseconnect.org")).toBe(false);
  });

  /**
   * Domain wildcards used to promote every account on a domain to ADMIN. Exact
   * addresses only — an `@domain` entry is ignored, not expanded.
   */
  it("ignores domain wildcard entries", () => {
    process.env.ADMIN_EMAILS = "@saseconnect.org";
    expect(isOfficerEmail("anyone@saseconnect.org")).toBe(false);

    process.env.ADMIN_EMAILS = "@saseconnect.org,officer@saseconnect.org";
    expect(isOfficerEmail("anyone@saseconnect.org")).toBe(false);
    expect(isOfficerEmail("officer@saseconnect.org")).toBe(true);
  });

  it("takes a missing or empty address as not an officer", () => {
    process.env.ADMIN_EMAILS = "officer@saseconnect.org";
    expect(isOfficerEmail(null)).toBe(false);
    expect(isOfficerEmail(undefined)).toBe(false);
    expect(isOfficerEmail("")).toBe(false);
    expect(isOfficerEmail("   ")).toBe(false);
    expect(isOfficerEmail("@")).toBe(false);
  });

  it("reads several comma-separated entries and skips blank ones", () => {
    process.env.ADMIN_EMAILS = " , president@gmail.com,";
    expect(isOfficerEmail("pre.sident+gt@googlemail.com")).toBe(true);
    expect(isOfficerEmail("someone@example.com")).toBe(false);
  });

  /**
   * The allowlist is read on every call, not captured at import. Hoisting it
   * to a module constant would be an easy "optimisation" that breaks the
   * server actions this runs inside, where the module outlives a config
   * change, and would break this test first.
   */
  it("re-reads ADMIN_EMAILS on every call", () => {
    process.env.ADMIN_EMAILS = "first@saseconnect.org";
    expect(isOfficerEmail("first@saseconnect.org")).toBe(true);
    expect(isOfficerEmail("second@saseconnect.org")).toBe(false);

    process.env.ADMIN_EMAILS = "second@saseconnect.org";
    expect(isOfficerEmail("first@saseconnect.org")).toBe(false);
    expect(isOfficerEmail("second@saseconnect.org")).toBe(true);
  });

  /**
   * Fail closed: unset or empty ADMIN_EMAILS promotes nobody. The first
   * officer is set via env or a deliberate database edit.
   */
  it("promotes nobody when ADMIN_EMAILS is unset or empty", () => {
    delete process.env.ADMIN_EMAILS;
    expect(isOfficerEmail("aamoghsawantt@gmail.com")).toBe(false);
    expect(isOfficerEmail("officer@saseconnect.org")).toBe(false);

    process.env.ADMIN_EMAILS = "";
    expect(isOfficerEmail("officer@saseconnect.org")).toBe(false);

    process.env.ADMIN_EMAILS = ",";
    expect(isOfficerEmail("officer@saseconnect.org")).toBe(false);

    process.env.ADMIN_EMAILS = "officer@saseconnect.org";
    expect(isOfficerEmail("officer@saseconnect.org")).toBe(true);
  });
});

describe("codeFromScan", () => {
  it("pulls the code out of a full check-in URL", () => {
    expect(
      codeFromScan("https://sasegt.org/portal/check-in?code=ABCD2345"),
    ).toBe("ABCD2345");
    expect(
      codeFromScan("https://sasegt.org/portal/check-in?code=abcd2345"),
    ).toBe("ABCD2345");
    expect(
      codeFromScan(
        "https://sasegt.org/portal/check-in?from=qr&code=abcd2345#x",
      ),
    ).toBe("ABCD2345");
    expect(
      codeFromScan("https://sasegt.org/portal/check-in#code=ABCD2345"),
    ).toBe("ABCD2345");
    expect(codeFromScan("https://sasegt.org/portal/check-in#ABCD2345")).toBe(
      "ABCD2345",
    );
  });

  it("accepts a bare code in either case, with the scanner's whitespace", () => {
    expect(codeFromScan("ABCD2345")).toBe("ABCD2345");
    expect(codeFromScan("abcd2345")).toBe("ABCD2345");
    expect(codeFromScan("  abcd2345\n")).toBe("ABCD2345");
    // A QR reader hands back the URL with the same trailing newline.
    expect(codeFromScan("  https://sasegt.org/check-in?code=abcd2345 \n")).toBe(
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
    expect(codeFromScan("https://sasegt.org/portal/check-in")).toBeNull();
    expect(codeFromScan("https://sasegt.org/portal/check-in?code=")).toBeNull();
    expect(codeFromScan("https://sasegt.org/events")).toBeNull();
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
    expect(
      codeFromScan("https://sasegt.org/portal/check-in?code=ABC"),
    ).toBeNull();
    // The glyphs the generator never issues are refused here as well.
    expect(
      codeFromScan("https://sasegt.org/portal/check-in?code=SASE0GT2"),
    ).toBeNull();
  });

  /** A genuine check-in URL still works, which is the branch's whole job. */
  it("still takes the code out of the officer's own QR", () => {
    expect(
      codeFromScan("https://sasegt.org/portal/check-in?code=ABCD2345"),
    ).toBe("ABCD2345");
  });
});
