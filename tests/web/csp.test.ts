import { describe, expect, it } from "bun:test";

import { contentSecurityPolicy } from "../../sites/web/csp";
import { uptimeDataUrl } from "../../sites/web/src/lib/uptime";

function directive(policy: string, name: string) {
  return policy
    .split("; ")
    .find((part) => part.startsWith(`${name} `))
    ?.split(" ")
    .slice(1);
}

describe("content security policy", () => {
  it("lets requests reach this origin and the uptime host only", () => {
    expect(directive(contentSecurityPolicy(true), "connect-src")).toEqual([
      "'self'",
      new URL(uptimeDataUrl).origin,
    ]);
  });

  it("keeps https: images so Markdown pages can embed them", () => {
    expect(directive(contentSecurityPolicy(true), "img-src")).toEqual([
      "'self'",
      "data:",
      "blob:",
      "https:",
    ]);
  });

  it("allows eval and the Vercel debug script only in development", () => {
    expect(directive(contentSecurityPolicy(true), "script-src")).toEqual([
      "'self'",
      "'unsafe-inline'",
    ]);
    const dev = directive(contentSecurityPolicy(false), "script-src");
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain("https://va.vercel-scripts.com");
  });

  it("stays locked down everywhere else", () => {
    const policy = contentSecurityPolicy(true);
    expect(directive(policy, "default-src")).toEqual(["'self'"]);
    expect(directive(policy, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(policy, "form-action")).toEqual(["'self'"]);
  });
});
