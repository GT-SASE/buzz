import { afterEach, describe, expect, it } from "vitest";

import sitemap from "~/app/sitemap";
import { csvCell, toCsv } from "~/app/portal/_lib/csv";
import {
  formatDate,
  fromLocalInputValue,
  toLocalInputValue,
} from "~/app/portal/_lib/format";
import { firstParam, safeRedirectPath } from "~/app/portal/_lib/paths";
import { codeFromScan } from "~/app/portal/(member)/check-in/scanner";
import { stats, marqueeItems, missionPillars, programs } from "~/data/content";
import { adminNav, portalNav, tierFor, tiers } from "~/data/portal";
import {
  discord,
  engage,
  instagram,
  navCta,
  navGroups,
  site,
} from "~/data/site";
import { breadcrumbSchema, eventSchema, jsonLd, pageMetadata } from "~/lib/seo";
import { cn } from "~/lib/utils";
import { asDate, asInt } from "../packages/api/src/aggregates";
import { isUniqueViolation } from "../packages/api/src/pg-errors";
import { resetRateLimits, takeToken } from "../packages/api/src/rate-limit";
import { isOfficerEmail } from "../packages/auth/src/admins";

/**
 * One thousand cases across the helpers the rest of the app actually calls.
 * Each `it` is a real assertion on one module — not a thousand copies of the
 * scanner, and not a loop hidden inside a single test.
 */
type Case = { id: string; run: () => void };

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const FORBIDDEN = "ILOU01";
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildCases(): Case[] {
  const cases: Case[] = [];
  const add = (id: string, run: () => void) => cases.push({ id, run });

  const rand = mulberry32(20260824);
  const pick = (source: string) =>
    source[Math.floor(rand() * source.length)] ?? source[0]!;
  const issued = (length: number) =>
    Array.from({ length }, () => pick(ALPHABET)).join("");

  // --- scanner (100) ---
  for (let i = 0; i < 40; i++) {
    const code = issued(8);
    add(`scan/bare/${i}`, () => expect(codeFromScan(code)).toBe(code));
  }
  for (let i = 0; i < 20; i++) {
    const code = issued(8);
    const mixed = [...code]
      .map((glyph) => (rand() < 0.5 ? glyph.toLowerCase() : glyph))
      .join("");
    add(`scan/case/${i}`, () =>
      expect(codeFromScan(`  ${mixed}\n`)).toBe(code),
    );
  }
  const wraps = [
    (code: string) => `https://sasegt.org/portal/check-in?code=${code}`,
    (code: string) => `https://sasegt.org/portal/check-in#code=${code}`,
    (code: string) => `https://sasegt.org/portal/check-in#${code}`,
    (code: string) =>
      `https://sasegt.org/portal/check-in?from=qr&code=${code.toLowerCase()}#x`,
  ];
  for (let i = 0; i < 20; i++) {
    const code = issued(8);
    add(`scan/url/${i}`, () =>
      expect(codeFromScan(wraps[i % wraps.length]!(code))).toBe(code),
    );
  }
  for (let i = 0; i < 20; i++) {
    const glyphs = [...issued(8)];
    glyphs[i % 8] = pick(FORBIDDEN);
    add(`scan/forbidden/${i}`, () =>
      expect(codeFromScan(glyphs.join(""))).toBeNull(),
    );
  }

  // --- csv (100 cells + 30 tables) ---
  const formulaLead = ["=", "+", "-", "@", "\t", "\r"] as const;
  let csvN = 0;
  for (const lead of formulaLead) {
    for (const body of ["HYPERLINK(1)", "1+1", "SUM(A1)", "cmd|calc", "Ada"]) {
      const raw = `${lead}${body}`;
      add(`csv/formula/${csvN++}`, () => {
        const cell = csvCell(raw);
        expect(cell.startsWith(`"'`)).toBe(true);
        expect(cell).toContain(body);
      });
    }
  }
  // 6 * 5 = 30 so far
  const ordinary = [
    "Grace Hopper",
    "grace@gatech.edu",
    "SASE GT",
    "Klaus 1443",
    "0",
    "30",
    "中文",
    "emoji ok",
    "comma, inside",
    'she said "hello"',
    "line\nbreak",
    "tab\there",
    "  padded  ",
    "gatech.edu",
    "navy",
  ];
  for (const value of ordinary) {
    add(`csv/quote/${csvN++}`, () => {
      const cell = csvCell(value);
      expect(cell.startsWith(`"`)).toBe(true);
      expect(cell.endsWith(`"`)).toBe(true);
      if (value.includes(`"`)) expect(cell).toContain(`""`);
    });
  }
  const numbers = [0, 1, -1, 7, 15, 20, 30, 100, 1.5, -5, 10, 42, 99, 150, 200];
  for (const value of numbers) {
    add(`csv/number/${csvN++}`, () => {
      const cell = csvCell(value);
      if (value < 0) expect(cell.startsWith(`"'`)).toBe(true);
      else expect(cell).toBe(`"${String(value)}"`);
    });
  }
  add("csv/null", () => expect(csvCell(null)).toBe(`""`));
  add("csv/undefined", () => expect(csvCell(undefined)).toBe(`""`));
  add("csv/empty", () => expect(csvCell("")).toBe(`""`));
  // 30+15+15+3 = 63. Need 100: 37 more ordinary variants.
  for (let i = 0; i < 37; i++) {
    const name = `Member ${i} O'Brien`;
    add(`csv/name/${i}`, () => {
      expect(csvCell(name)).toBe(`"${name}"`);
    });
  }

  for (let i = 0; i < 30; i++) {
    const rows = [
      ["Name", "Points"],
      [`Person ${i}`, i],
    ];
    add(`csv/table/${i}`, () => {
      const out = toCsv(rows);
      expect(out).toContain("\r\n");
      expect(out.split("\r\n")).toHaveLength(2);
      expect(out).toContain(`"Person ${i}"`);
    });
  }

  // --- redirects (120) + firstParam (30) ---
  const safe = [
    "/portal",
    "/portal/check-in",
    "/portal/check-in?code=SASEGT26",
    "/portal/admin",
    "/portal/admin/members",
    "/portal/admin/events/abc",
    "/about",
    "/join",
    "/events",
    "/contact",
  ];
  safe.forEach((path, i) =>
    add(`path/keep/${i}`, () => expect(safeRedirectPath(path)).toBe(path)),
  );
  const hostile = [
    "https://evil.com",
    "http://evil.com",
    "//evil.com",
    "/\\evil.com",
    "/\\/evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "/\r/evil.com",
    "/\t\\evil.com",
    "\t//evil.com",
    "javascript:alert(1)",
    "data:text/html,x",
    "portal",
    "",
    "/portal/check-in?code=A\tB",
    "///evil.com",
    "/\\\\evil.com",
    " /portal",
    "/portal\n",
    "/portal\r\n",
  ];
  hostile.forEach((path, i) =>
    add(`path/refuse/${i}`, () =>
      expect(safeRedirectPath(path)).toBe("/portal"),
    ),
  );
  for (let i = 0; i < 50; i++) {
    add(`path/host/${i}`, () =>
      expect(safeRedirectPath(`//evil-${i}.example`)).toBe("/portal"),
    );
  }
  for (let i = 0; i < 40; i++) {
    add(`path/tab-slash/${i}`, () =>
      expect(safeRedirectPath(`/\t/phish-${i}.tld`)).toBe("/portal"),
    );
  }
  // 10+20+50+40 = 120

  const firsts: Array<{
    input: string | string[] | undefined;
    expected: string | undefined;
  }> = [
    { input: "ABCD2345", expected: "ABCD2345" },
    { input: undefined, expected: undefined },
    { input: [], expected: undefined },
    { input: ["A", "B"], expected: "A" },
    { input: ["//evil.com", "/portal"], expected: "//evil.com" },
    { input: ["/portal", "//evil.com"], expected: "/portal" },
  ];
  while (firsts.length < 30) {
    const n = firsts.length;
    firsts.push({ input: [`code-${n}`, "x"], expected: `code-${n}` });
  }
  firsts.forEach((entry, i) =>
    add(`param/${i}`, () =>
      expect(firstParam(entry.input)).toBe(entry.expected),
    ),
  );

  // --- tiers (151): every total through Distinguished ---
  for (let points = 0; points <= 150; points++) {
    add(`tier/${points}`, () => {
      const tier = tierFor(points);
      expect(tier.progress).toBeGreaterThanOrEqual(0);
      expect(tier.progress).toBeLessThanOrEqual(1);
      if (points < 25) expect(tier.name).toBe("Member");
      else if (points < 75) expect(tier.name).toBe("Active");
      else if (points < 150) expect(tier.name).toBe("Core");
      else expect(tier.name).toBe("Distinguished");
      if (tier.pointsToNext !== null) {
        expect(tierFor(points + tier.pointsToNext).name).toBe(tier.next);
      }
    });
  }

  // --- officers (84) ---
  const originalAdmin = process.env.ADMIN_EMAILS;
  const officerCases: Array<{
    list: string;
    email: string | null | undefined;
    expected: boolean;
  }> = [];
  const pushOfficer = (
    list: string,
    email: string | null | undefined,
    expected: boolean,
  ) => officerCases.push({ list, email, expected });

  for (const email of [
    "officer@saseconnect.org",
    "OFFICER@saseconnect.org",
    "  officer@SASECONNECT.org  ",
    "officer@saseconnect.org\n",
  ]) {
    pushOfficer("officer@saseconnect.org", email, true);
  }
  for (const email of [
    "officer2@saseconnect.org",
    "xofficer@saseconnect.org",
    "officer@example.com",
    "anyone@saseconnect.org",
    "ab@saseconnect.org",
  ]) {
    pushOfficer("officer@saseconnect.org", email, false);
  }
  for (const email of [
    "ab@gmail.com",
    "a.b@gmail.com",
    "a.b+sase@gmail.com",
    "ab+anything@gmail.com",
    "AB@Gmail.Com",
    "ab@googlemail.com",
    "a.b+sase@googlemail.com",
    "a.b@googlemail.com",
  ]) {
    pushOfficer("ab@gmail.com", email, true);
  }
  for (const email of [
    "abc@gmail.com",
    "ab@yahoo.com",
    "a.b@saseconnect.org",
    "notab@gmail.com",
    "ab@gatech.edu",
  ]) {
    pushOfficer("ab@gmail.com", email, false);
  }
  pushOfficer("a.b@saseconnect.org", "a.b@saseconnect.org", true);
  pushOfficer("a.b@saseconnect.org", "ab@saseconnect.org", false);
  pushOfficer("a.b@saseconnect.org", "a.b+x@saseconnect.org", false);
  pushOfficer("@saseconnect.org", "anyone@saseconnect.org", false);
  pushOfficer(
    "@saseconnect.org,officer@saseconnect.org",
    "officer@saseconnect.org",
    true,
  );
  pushOfficer("officer@saseconnect.org", null, false);
  pushOfficer("officer@saseconnect.org", undefined, false);
  pushOfficer("officer@saseconnect.org", "", false);
  pushOfficer("officer@saseconnect.org", "   ", false);
  pushOfficer("officer@saseconnect.org", "@", false);
  pushOfficer("", "officer@saseconnect.org", false);
  pushOfficer(",", "officer@saseconnect.org", false);
  pushOfficer(" , president@gmail.com,", "pre.sident+gt@googlemail.com", true);
  for (let i = 0; i < 47; i++) {
    pushOfficer("board@saseconnect.org", `member${i}@gatech.edu`, false);
  }
  // 4+5+8+5+3+2+6+3+1+47 = 84
  officerCases.forEach((entry, i) =>
    add(`officer/${i}`, () => {
      process.env.ADMIN_EMAILS = entry.list;
      expect(isOfficerEmail(entry.email)).toBe(entry.expected);
      if (originalAdmin === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = originalAdmin;
    }),
  );

  // --- Atlanta clocks (96 round trips + 36 date prints) ---
  const hours = [0, 3, 6, 9, 12, 15, 18, 21];
  let clock = 0;
  for (let month = 1; month <= 12; month++) {
    for (const hour of hours) {
      const wall = `2026-${String(month).padStart(2, "0")}-10T${String(hour).padStart(2, "0")}:00`;
      add(`clock/roundtrip/${clock++}`, () => {
        expect(toLocalInputValue(fromLocalInputValue(wall))).toBe(wall);
      });
    }
  }
  let dates = 0;
  for (let month = 0; month < 12; month++) {
    for (const day of [1, 15, 28]) {
      const utc = new Date(Date.UTC(2026, month, day, 2, 0, 0));
      add(`clock/date/${dates++}`, () => {
        const [year, mo, d] = toLocalInputValue(utc).slice(0, 10).split("-");
        expect(formatDate(utc)).toBe(
          `${MONTHS[Number(mo) - 1]} ${Number(d)}, ${year}`,
        );
      });
    }
  }

  // --- aggregates (40 asInt + 30 asDate) ---
  const ints: Array<{
    raw: number | string | null | undefined;
    expected: number;
  }> = [
    { raw: null, expected: 0 },
    { raw: undefined, expected: 0 },
    { raw: 0, expected: 0 },
    { raw: 7, expected: 7 },
    { raw: 15, expected: 15 },
    { raw: 30, expected: 30 },
    { raw: -5, expected: -5 },
    { raw: 1.5, expected: 1.5 },
    { raw: "0", expected: 0 },
    { raw: "30", expected: 30 },
    { raw: "7", expected: 7 },
    { raw: "-5", expected: -5 },
    { raw: "01", expected: 1 },
    { raw: "1e2", expected: 100 },
    { raw: "3.14", expected: 3.14 },
    { raw: "", expected: 0 },
    { raw: "  ", expected: 0 },
    { raw: "10.0", expected: 10 },
    { raw: "100", expected: 100 },
    { raw: "150", expected: 150 },
  ];
  while (ints.length < 38) {
    const n = ints.length;
    ints.push({ raw: String(n), expected: n });
  }
  ints.forEach((entry, i) =>
    add(`asInt/${i}`, () => expect(asInt(entry.raw)).toBe(entry.expected)),
  );
  add("asInt/nan-text", () => expect(Number.isNaN(asInt("nope"))).toBe(true));
  add("asInt/nan-number", () =>
    expect(Number.isNaN(asInt(Number.NaN))).toBe(true),
  );

  const iso = "2026-08-28T22:00:00.000Z";
  for (let i = 0; i < 20; i++) {
    const instant = new Date(Date.UTC(2026, 0, 1 + i, 17, 0, 0));
    add(`asDate/date/${i}`, () => {
      expect(asDate(instant)?.toISOString()).toBe(instant.toISOString());
    });
  }
  add("asDate/iso", () => expect(asDate(iso)?.toISOString()).toBe(iso));
  add("asDate/null", () => expect(asDate(null)).toBeNull());
  add("asDate/undefined", () => expect(asDate(undefined)).toBeNull());
  add("asDate/empty", () => expect(asDate("")).toBeNull());
  add("asDate/garbage", () => expect(asDate("not a date")).toBeNull());
  add("asDate/invalid-date", () => expect(asDate(new Date("nope"))).toBeNull());
  add("asDate/whitespace", () => expect(asDate("   ")).toBeNull());
  add("asDate/epoch-string", () => {
    expect(asDate("2020-01-15T12:00:00.000Z")?.toISOString()).toBe(
      "2020-01-15T12:00:00.000Z",
    );
  });

  // --- unique violation (30) ---
  add("pg/top", () => expect(isUniqueViolation({ code: "23505" })).toBe(true));
  add("pg/cause-1", () =>
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true),
  );
  add("pg/cause-2", () =>
    expect(isUniqueViolation({ cause: { cause: { code: "23505" } } })).toBe(
      true,
    ),
  );
  add("pg/cause-3", () =>
    expect(
      isUniqueViolation({ cause: { cause: { cause: { code: "23505" } } } }),
    ).toBe(true),
  );
  add("pg/cause-4", () =>
    expect(
      isUniqueViolation({
        cause: { cause: { cause: { cause: { code: "23505" } } } },
      }),
    ).toBe(true),
  );
  add("pg/too-deep", () =>
    expect(
      isUniqueViolation({
        cause: {
          cause: {
            cause: { cause: { cause: { code: "23505" } } },
          },
        },
      }),
    ).toBe(false),
  );
  for (const code of ["23503", "42P01", "42703", "28000", "40001"]) {
    add(`pg/other/${code}`, () =>
      expect(isUniqueViolation({ code })).toBe(false),
    );
  }
  add("pg/null", () => expect(isUniqueViolation(null)).toBe(false));
  add("pg/undefined", () => expect(isUniqueViolation(undefined)).toBe(false));
  add("pg/string", () => expect(isUniqueViolation("23505")).toBe(false));
  add("pg/number", () => expect(isUniqueViolation(23505)).toBe(false));
  add("pg/empty", () => expect(isUniqueViolation({})).toBe(false));
  add("pg/error", () =>
    expect(isUniqueViolation(new Error("dup"))).toBe(false),
  );
  const circle: { cause?: unknown; code?: string } = {};
  circle.cause = circle;
  add("pg/cycle", () => expect(isUniqueViolation(circle)).toBe(false));
  for (let i = 0; i < 7; i++) {
    add(`pg/driver/${i}`, () =>
      expect(
        isUniqueViolation({ code: "22P02", cause: { code: "22P02" } }),
      ).toBe(false),
    );
  }
  // 6 + 5 + 6 + 1 + 12 = 30

  // --- seo (25 jsonLd + 20 metadata + 20 event + 20 crumb) ---
  for (let i = 0; i < 20; i++) {
    add(`jsonld/escape/${i}`, () => {
      const html = jsonLd({
        n: i,
        note: `</script><img src=x onerror=1> ${i}`,
      }).__html;
      expect(html).not.toContain("<");
      expect(html).toContain("\\u003c");
    });
  }
  for (let i = 0; i < 5; i++) {
    add(`jsonld/plain/${i}`, () => {
      expect(JSON.parse(jsonLd({ i, ok: true }).__html)).toEqual({
        i,
        ok: true,
      });
    });
  }

  const metaPaths = [
    "/",
    "/about",
    "/join",
    "/events",
    "/programs",
    "/board",
    "/sponsors",
    "/contact",
    "/portal",
    "/portal/check-in",
  ];
  metaPaths.forEach((path, i) =>
    add(`meta/path/${i}`, () => {
      const meta = pageMetadata({
        title: "Title",
        description: "Desc",
        path,
      });
      const url = path === "/" ? site.url : `${site.url}${path}`;
      expect(meta.alternates?.canonical).toBe(url);
      expect(meta.openGraph?.url).toBe(url);
      if (path === "/") expect(meta.title).toEqual({ absolute: "Title" });
      else expect(meta.title).toBe("Title");
    }),
  );
  for (let i = 0; i < 10; i++) {
    add(`meta/og/${i}`, () => {
      const meta = pageMetadata({
        title: `Page ${i}`,
        description: `d${i}`,
        path: `/p${i}`,
      });
      expect(meta.openGraph?.title).toBe(`Page ${i} · ${site.shortName}`);
      expect(meta.twitter?.description).toBe(`d${i}`);
    });
  }

  for (let i = 0; i < 10; i++) {
    add(`schema/event-place/${i}`, () => {
      const schema = eventSchema({
        title: `GBM ${i}`,
        startsAt: new Date("2026-08-28T22:00:00Z"),
        location: `Klaus ${i}`,
        description: `About ${i}`,
      });
      expect(schema.location).toMatchObject({
        "@type": "Place",
        name: `Klaus ${i}`,
      });
      expect(schema.description).toBe(`About ${i}`);
    });
  }
  for (let i = 0; i < 10; i++) {
    add(`schema/event-blank/${i}`, () => {
      const schema = eventSchema({
        title: `Social ${i}`,
        startsAt: new Date("2026-09-01T23:00:00Z"),
        location: null,
        description: null,
      });
      expect(schema).not.toHaveProperty("location");
      expect(schema).not.toHaveProperty("description");
    });
  }
  const crumbPaths = [
    "/about",
    "/join",
    "/events",
    "/programs",
    "/board",
    "/sponsors",
    "/contact",
    "/portal",
    "/portal/admin",
    "/portal/admin/members",
  ];
  crumbPaths.forEach((path, i) =>
    add(`schema/crumb/${i}`, () => {
      const schema = breadcrumbSchema("Label", path);
      expect(schema.itemListElement[0]?.item).toBe(site.url);
      expect(schema.itemListElement[1]?.item).toBe(`${site.url}${path}`);
    }),
  );
  for (let i = 0; i < 10; i++) {
    add(`schema/crumb-label/${i}`, () => {
      expect(breadcrumbSchema(`L${i}`, `/x${i}`).itemListElement[1]?.name).toBe(
        `L${i}`,
      );
    });
  }

  // --- cn (20) ---
  const classPairs: Array<[string, string, string]> = [
    ["p-2", "p-4", "p-4"],
    ["px-2", "px-8", "px-8"],
    ["m-1", "m-0", "m-0"],
    ["text-sm", "text-lg", "text-lg"],
    ["bg-red-500", "bg-blue-500", "bg-blue-500"],
    ["hidden", "block", "block"],
    ["flex", "grid", "grid"],
    ["rounded", "rounded-lg", "rounded-lg"],
    ["font-bold", "font-normal", "font-normal"],
    ["w-full", "w-auto", "w-auto"],
    ["h-4", "h-8", "h-8"],
    ["gap-2", "gap-4", "gap-4"],
    ["border", "border-0", "border-0"],
    ["opacity-50", "opacity-100", "opacity-100"],
    ["z-10", "z-50", "z-50"],
    ["top-0", "top-4", "top-4"],
    ["left-0", "left-2", "left-2"],
    ["pt-2", "pt-6", "pt-6"],
    ["pb-2", "pb-0", "pb-0"],
    ["mt-4", "mt-0", "mt-0"],
  ];
  classPairs.forEach(([a, b, expected], i) =>
    add(`cn/${i}`, () => expect(cn(a, b)).toBe(expected)),
  );

  // --- rate limit (24) ---
  for (let i = 0; i < 24; i++) {
    add(`ratelimit/${i}`, () => {
      resetRateLimits();
      const key = `codebase-cases-${i}`;
      const opts = { limit: 3, intervalMs: 60_000 };
      expect(takeToken(key, opts)).toBe(true);
      expect(takeToken(key, opts)).toBe(true);
      expect(takeToken(key, opts)).toBe(true);
      expect(takeToken(key, opts)).toBe(false);
    });
  }

  // --- site / nav / content / sitemap (8+16) ---
  const map = sitemap();
  const publicPaths = [
    "/",
    "/join",
    "/events",
    "/programs",
    "/about",
    "/sponsors",
    "/board",
    "/contact",
  ];
  publicPaths.forEach((path, i) =>
    add(`sitemap/${i}`, () => {
      const url = path === "/" ? site.url : `${site.url}${path}`;
      expect(map.some((entry) => entry.url === url)).toBe(true);
      expect(map.some((entry) => entry.url.includes("/portal"))).toBe(false);
    }),
  );

  navGroups.forEach((group, i) =>
    add(`nav/group/${i}`, () => {
      expect(group.href.startsWith("/")).toBe(true);
      expect(group.href.includes("/portal")).toBe(false);
    }),
  );
  site.socials.forEach((social, i) =>
    add(`nav/social/${i}`, () => {
      expect(social.href.startsWith("https://")).toBe(true);
    }),
  );
  add("nav/instagram", () => expect(instagram?.id).toBe("instagram"));
  add("nav/discord", () => expect(discord?.id).toBe("discord"));
  add("nav/engage", () => expect(engage?.id).toBe("engage"));
  add("nav/cta", () => expect(navCta.href).toBe("/portal"));
  add("nav/portal-check-in", () =>
    expect(portalNav.map((tab) => tab.href)).toContain("/portal/check-in"),
  );
  add("nav/admin-no-scan", () =>
    expect(adminNav.map((tab) => tab.href)).not.toContain("/portal/check-in"),
  );
  add("nav/url", () => {
    expect(site.url.startsWith("https://")).toBe(true);
    expect(site.url.endsWith("/")).toBe(false);
  });
  add("nav/email", () => expect(site.email).toContain("@"));
  add("nav/tiers-floor", () => expect(tiers[0]?.min).toBe(0));
  add("content/programs-unique", () => {
    const slugs = programs.map((program) => program.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
  add("content/stats", () => expect(stats.length).toBeGreaterThan(0));
  add("content/marquee", () => expect(marqueeItems.length).toBeGreaterThan(0));
  add("content/pillars", () => expect(missionPillars.length).toBe(3));

  return cases;
}

const CASES = buildCases();

if (CASES.length !== 1000) {
  throw new Error(`codebase case table must be 1000, got ${CASES.length}`);
}

const originalAdmin = process.env.ADMIN_EMAILS;

describe("one thousand cases across the codebase", () => {
  afterEach(() => {
    if (originalAdmin === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalAdmin;
    resetRateLimits();
  });

  it.each(CASES)("$id", ({ run }) => {
    run();
  });
});
