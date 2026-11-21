import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";

import { RESERVED_PAGE_SLUGS } from "../packages/api/src/page-slug";
import { cspHeaderRules } from "../sites/web/csp";
import { uptimeDataUrl } from "../sites/web/src/lib/uptime";

/** Next's own matcher, so the sources are read exactly as the host reads them. */
const { pathToRegexp } = createRequire(
  resolve(import.meta.dirname, "../sites/web/package.json"),
)("next/dist/compiled/path-to-regexp") as {
  pathToRegexp: (
    source: string,
    keys: unknown[],
    options: { strict: boolean; sensitive: boolean; delimiter: string },
  ) => RegExp;
};

/** Every policy that applies to a path. A host may order or merge more than one. */
function policiesFor(path: string, isProd = true) {
  return cspHeaderRules(isProd)
    .filter((rule) =>
      pathToRegexp(rule.source, [], {
        strict: true,
        sensitive: false,
        delimiter: "/",
      }).test(path),
    )
    .map((rule) => rule.headers[0]!.value);
}

function cspFor(path: string, isProd = true) {
  const policies = policiesFor(path, isProd);
  expect(policies).toHaveLength(1);
  return policies[0]!;
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
  "/website-team",
  "/robots.txt",
  "/icon-192.png",
  "/_next/static/chunks/app.js",
  "/fonts/archivo-core.woff2",
  "/portal",
  "/portal/signin",
  "/portal/events",
  "/portal/admin/members",
  "/api/trpc/event.upcoming",
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

  it("gives every route exactly one policy", () => {
    const paths = [
      ...staticPages,
      "/status",
      "/spring-kickoff",
      "/portal/admin/pages/new",
      ...[...RESERVED_PAGE_SLUGS].map((slug) => `/${slug}`),
    ];
    for (const path of paths) expect(policiesFor(path)).toHaveLength(1);
  });

  it("allows eval and the Vercel debug script only in development", () => {
    const prod = directive(cspFor("/"), "script-src");
    const dev = directive(cspFor("/", false), "script-src");
    expect(prod).toEqual(["'self'", "'unsafe-inline'"]);
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain("https://va.vercel-scripts.com");
  });
});
