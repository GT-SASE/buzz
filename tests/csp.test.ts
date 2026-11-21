import { describe, expect, it } from "bun:test";

import { RESERVED_PAGE_SLUGS } from "../packages/api/src/page-slug";
import { cspHeaderRules } from "../sites/web/csp";
import { uptimeDataUrl } from "../sites/web/src/lib/uptime";

/**
 * The only source shapes the rules use: `/:path*`, `/:slug(regex)` and a literal
 * path. Next applies every matching rule in order, so the last match wins.
 */
function toRegExp(source: string) {
  const pattern = source
    .replace("/:path*", "(?:/.*)?")
    .replace(/:\w+(\(.+\))$/, "$1");
  return new RegExp(`^${pattern}$`);
}

function cspFor(path: string, isProd = true) {
  const matches = cspHeaderRules(isProd).filter((rule) =>
    toRegExp(rule.source).test(path),
  );
  return matches.at(-1)!.headers[0]!.value;
}

function directive(policy: string, name: string) {
  return policy
    .split("; ")
    .find((part) => part.startsWith(`${name} `))
    ?.split(" ")
    .slice(1);
}

const staticPages = [
  "/",
  "/about",
  "/events",
  "/board",
  "/join",
  "/portal",
  "/portal/signin",
  "/portal/events",
  "/portal/admin/members",
];

describe("content security policy", () => {
  it.each(staticPages)("%s reaches no host but its own", (path) => {
    const policy = cspFor(path);
    expect(directive(policy, "connect-src")).toEqual(["'self'"]);
    expect(directive(policy, "img-src")).toEqual(["'self'", "data:", "blob:"]);
  });

  it("lets /status read the uptime file and nothing else", () => {
    const policy = cspFor("/status");
    expect(directive(policy, "connect-src")).toEqual([
      "'self'",
      new URL(uptimeDataUrl).origin,
    ]);
    expect(directive(policy, "img-src")).not.toContain("https:");
  });

  it.each([
    "/spring-kickoff",
    "/2026",
    "/portal/admin/pages",
    "/portal/admin/pages/new",
    "/portal/admin/pages/abc123",
  ])("%s may show a Markdown image from any https host", (path) => {
    const policy = cspFor(path);
    expect(directive(policy, "img-src")).toContain("https:");
    expect(directive(policy, "connect-src")).toEqual(["'self'"]);
  });

  it("never opens images on a route a static page owns", () => {
    for (const slug of RESERVED_PAGE_SLUGS) {
      expect(directive(cspFor(`/${slug}`), "img-src")).not.toContain("https:");
    }
  });

  it("keeps https: out of connect-src on every route", () => {
    for (const path of [...staticPages, "/status", "/spring-kickoff"]) {
      expect(directive(cspFor(path), "connect-src")).not.toContain("https:");
    }
  });

  it("allows eval and the Vercel debug script only in development", () => {
    const prod = directive(cspFor("/"), "script-src");
    const dev = directive(cspFor("/", false), "script-src");
    expect(prod).toEqual(["'self'", "'unsafe-inline'"]);
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain("https://va.vercel-scripts.com");
  });
});
