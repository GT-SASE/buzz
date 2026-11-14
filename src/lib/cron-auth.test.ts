import { describe, expect, it } from "bun:test";
import { isCronAuthorized } from "./cron-auth.ts";

const SECRET = "s".repeat(32);

describe("isCronAuthorized", () => {
  it("accepts the bearer value of the secret", () => {
    expect(isCronAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it.each([
    ["no header", null],
    ["a wrong secret", `Bearer ${"t".repeat(32)}`],
    ["a longer secret", `Bearer ${SECRET}x`],
    ["the bare secret", SECRET],
    ["padding", ` Bearer ${SECRET}`],
  ])("refuses %s", (_label, header) => {
    expect(isCronAuthorized(header, SECRET)).toBe(false);
  });

  it.each([
    ["unset", undefined],
    ["31 characters", "s".repeat(31)],
    ["short once trimmed", ` ${"s".repeat(31)} `.padEnd(40)],
  ])("refuses everything when the secret is %s", (_label, secret) => {
    for (const header of ["Bearer undefined", "Bearer ", null]) {
      expect(isCronAuthorized(header, secret)).toBe(false);
    }
  });

  it("matches a secret stored with a trailing newline, but not a padded header", () => {
    expect(isCronAuthorized(`Bearer ${SECRET}`, `${SECRET}\n`)).toBe(true);
    expect(isCronAuthorized(`Bearer ${SECRET}\n`, `${SECRET}\n`)).toBe(false);
  });
});
