import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";

import {
  isValidPageSlug,
  PAGE_SLUG_MAX,
  pageSlugProblem,
  RESERVED_PAGE_SLUGS,
  slugFromTitle,
} from "../../packages/api/src/page-slug";

describe("pageSlugProblem", () => {
  it.each(["spring-kickoff", "a", "2026", "tech-talk-2"])(
    "accepts %s",
    (slug) => {
      expect(pageSlugProblem(slug)).toBeNull();
    },
  );

  it.each([
    "",
    "Spring",
    "-lead",
    "trail-",
    "double--hyphen",
    "has space",
    "under_score",
    "dot.dot",
    "slash/es",
    "café",
    "a".repeat(PAGE_SLUG_MAX + 1),
  ])("rejects %j", (slug) => {
    expect(isValidPageSlug(slug)).toBe(false);
  });

  it("allows exactly the maximum length", () => {
    expect(isValidPageSlug("a".repeat(PAGE_SLUG_MAX))).toBe(true);
  });

  it("rejects a reserved route name", () => {
    expect(pageSlugProblem("about")).toMatch(/already a page/);
    expect(isValidPageSlug("website-team")).toBe(false);
    expect(isValidPageSlug("sitemap")).toBe(false);
  });
});

describe("slugFromTitle", () => {
  it("kebab-cases a title", () => {
    expect(slugFromTitle("Spring Kickoff 2026!")).toBe("spring-kickoff-2026");
  });

  it("drops accents and stray punctuation", () => {
    expect(slugFromTitle("  Café -- Night  ")).toBe("cafe-night");
  });

  it("stays valid when truncated", () => {
    const slug = slugFromTitle("word ".repeat(30));
    expect(slug.length).toBeLessThanOrEqual(PAGE_SLUG_MAX);
    expect(isValidPageSlug(slug)).toBe(true);
  });
});

/**
 * Next resolves a static folder before `[slug]`, so a route that is added
 * without being reserved would silently hide any page published at its name.
 */
describe("reserved slugs track the app router", () => {
  const appDir = resolve(import.meta.dirname, "../../sites/web/src/app");
  const metadataFiles = new Set([
    "apple-icon",
    "favicon",
    "icon",
    "manifest",
    "opengraph-image",
    "robots",
    "sitemap",
    "twitter-image",
  ]);

  function topLevelSegments(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name.startsWith("(")) {
        return entry.isDirectory()
          ? topLevelSegments(resolve(dir, entry.name))
          : [];
      }
      if (entry.isDirectory()) {
        return /^[_[@]/.test(entry.name) ? [] : [entry.name];
      }
      const stem = entry.name.replace(/\.[^.]+$/, "");
      return metadataFiles.has(stem) ? [stem] : [];
    });
  }

  it("reserves every top-level route folder and metadata file", () => {
    const segments = topLevelSegments(appDir);
    expect(segments).toContain("about");
    expect(segments).toContain("sitemap");
    const missing = segments.filter((name) => !RESERVED_PAGE_SLUGS.has(name));
    expect(missing).toEqual([]);
  });
});
