import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { site } from "~/data/site";

describe("vercel deploy", () => {
  it("pins Google's callback to the public origin", () => {
    const proxy = `${site.url}/api/auth`;
    const vercel = JSON.parse(
      readFileSync("sites/web/vercel.json", "utf8"),
    ) as { env?: { AUTH_REDIRECT_PROXY_URL?: string } };
    expect(vercel.env?.AUTH_REDIRECT_PROXY_URL).toBe(proxy);

    const auth = readFileSync("packages/auth/src/index.ts", "utf8");
    expect(auth).toContain(`"${proxy}"`);

    const example = readFileSync(".env.example", "utf8");
    expect(example).toContain(`AUTH_REDIRECT_PROXY_URL="${proxy}"`);
  });

  it("applies committed migrations before the Next build", () => {
    const vercel = JSON.parse(
      readFileSync("sites/web/vercel.json", "utf8"),
    ) as { buildCommand: string; installCommand: string };
    expect(vercel.buildCommand).toContain("pnpm vercel-build");
    expect(vercel.installCommand).toContain("frozen-lockfile");
    // drizzle-kit lives in @buzz/db devDependencies; a production-mode
    // install would drop it and the migrate step would fail the deploy.
    expect(vercel.installCommand).toContain("--prod=false");

    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["vercel-build"]).toBe("node scripts/vercel-build.mjs");

    const script = readFileSync("scripts/vercel-build.mjs", "utf8");
    expect(script).toContain("pnpm db:migrate");

    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain("pnpm vercel-build");

    const journal = readFileSync(
      "packages/db/drizzle/meta/_journal.json",
      "utf8",
    );
    expect(journal).toContain("0002_wandering_queen_noir");
  });
});
