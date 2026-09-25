import { describe, expect, it } from "vitest";

import sitemap from "~/app/sitemap";
import { marqueeItems, programs } from "~/data/content";
import { adminNav, portalNav } from "~/data/portal";
import { committeesPublic } from "~/data/committees";
import { navCta, navGroups, site } from "~/data/site";
import { breadcrumbSchema, eventSchema, jsonLd, pageMetadata } from "~/lib/seo";
import { cn } from "~/lib/utils";
import { asDate, asInt } from "../packages/api/src/aggregates";
import {
  isUniqueViolation,
  isUndefinedTable,
} from "../packages/api/src/pg-errors";

describe("asInt", () => {
  it("reads numeric strings the driver returns", () => {
    expect(asInt("30")).toBe(30);
    expect(asInt("-5")).toBe(-5);
    expect(asInt("3.14")).toBe(3.14);
  });

  it("reads null, undefined and blank as zero", () => {
    expect(asInt(null)).toBe(0);
    expect(asInt(undefined)).toBe(0);
    expect(asInt("  ")).toBe(0);
  });

  it("does not hide text that is not a number", () => {
    expect(Number.isNaN(asInt("nope"))).toBe(true);
  });
});

describe("asDate", () => {
  it("passes a Date and an ISO string through", () => {
    const iso = "2026-08-28T22:00:00.000Z";
    expect(asDate(new Date(iso))?.toISOString()).toBe(iso);
    expect(asDate(iso)?.toISOString()).toBe(iso);
  });

  it("returns null for missing or unparseable values", () => {
    expect(asDate(null)).toBeNull();
    expect(asDate("")).toBeNull();
    expect(asDate("not a date")).toBeNull();
    expect(asDate(new Date("nope"))).toBeNull();
  });
});

describe("pg errors", () => {
  it("stops looking past four levels of cause", () => {
    expect(
      isUniqueViolation({
        cause: { cause: { cause: { cause: { code: "23505" } } } },
      }),
    ).toBe(true);
    expect(
      isUniqueViolation({
        cause: { cause: { cause: { cause: { cause: { code: "23505" } } } } },
      }),
    ).toBe(false);
  });

  it("recognises an undefined table and nothing else", () => {
    expect(isUndefinedTable({ code: "42P01" })).toBe(true);
    expect(isUndefinedTable({ code: "23505" })).toBe(false);
  });
});

describe("seo", () => {
  it("escapes markup inside JSON-LD", () => {
    const html = jsonLd({ note: "</script><img src=x onerror=1>" }).__html;
    expect(html).not.toContain("<");
    expect(html).toContain("\\u003c");
  });

  it("gives the home page an absolute title and the site URL", () => {
    const meta = pageMetadata({ title: "Title", description: "d", path: "/" });
    expect(meta.title).toEqual({ absolute: "Title" });
    expect(meta.alternates?.canonical).toBe(site.url);
  });

  it("gives an inner page its canonical URL and branded OG title", () => {
    const meta = pageMetadata({
      title: "Page",
      description: "d",
      path: "/join",
    });
    expect(meta.title).toBe("Page");
    expect(meta.alternates?.canonical).toBe(`${site.url}/join`);
    expect(meta.openGraph?.url).toBe(`${site.url}/join`);
    expect(meta.openGraph?.title).toBe(`Page · ${site.shortName}`);
  });

  it("adds a Place to an event only when it has a location", () => {
    const placed = eventSchema({
      title: "GBM",
      startsAt: new Date("2026-08-28T22:00:00Z"),
      location: "Klaus",
      description: "About",
    });
    expect(placed.location).toMatchObject({ "@type": "Place", name: "Klaus" });

    const blank = eventSchema({
      title: "Social",
      startsAt: new Date("2026-09-01T23:00:00Z"),
      location: null,
      description: null,
    });
    expect(blank).not.toHaveProperty("location");
    expect(blank).not.toHaveProperty("description");
  });

  it("builds a breadcrumb from home to the page", () => {
    const schema = breadcrumbSchema("Board", "/board");
    expect(schema.itemListElement[0]?.item).toBe(site.url);
    expect(schema.itemListElement[1]).toMatchObject({
      name: "Board",
      item: `${site.url}/board`,
    });
  });
});

describe("cn", () => {
  it("lets the later Tailwind class win a conflict", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
});

describe("site map and navigation", () => {
  it("lists every public page and no portal page", () => {
    const urls = sitemap().map((entry) => entry.url);
    for (const path of ["/join", "/events", "/about", "/board", "/contact"]) {
      expect(urls).toContain(`${site.url}${path}`);
    }
    expect(urls).toContain(site.url);
    expect(urls.some((url) => url.includes("/portal"))).toBe(false);
  });

  it("keeps the public nav on public pages", () => {
    for (const group of navGroups) {
      expect(group.href.startsWith("/")).toBe(true);
      expect(group.href.includes("/portal")).toBe(false);
    }
    expect(navCta.href).toBe("/portal");
  });

  it("links socials over https and has no trailing slash on the site URL", () => {
    for (const social of site.socials) {
      expect(social.href.startsWith("https://")).toBe(true);
    }
    expect(site.url.startsWith("https://")).toBe(true);
    expect(site.url.endsWith("/")).toBe(false);
  });

  it("puts check-in in the member nav and keeps committees admin-only", () => {
    const member = portalNav.map((tab) => tab.href);
    const admin = adminNav.map((tab) => tab.href);
    expect(member).toContain("/portal/check-in");
    expect(member).not.toContain("/portal/committees");
    expect(admin).not.toContain("/portal/check-in");
    expect(admin).toContain("/portal/admin/committees");
    expect(committeesPublic).toBe(false);
  });
});

describe("content", () => {
  it("gives every program a unique slug", () => {
    const slugs = programs.map((program) => program.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("keeps the archived Taste of SASE out of live copy", () => {
    expect(marqueeItems).not.toContain("Taste of SASE");
    const copy = programs.flatMap((program) => [program.body, program.detail]);
    expect(copy.some((text) => text.includes("Taste of SASE"))).toBe(false);
  });
});
