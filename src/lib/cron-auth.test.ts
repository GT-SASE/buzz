import { describe, expect, it } from "vitest";
import { isCronAuthorized } from "./cron-auth.ts";

const SECRET = "s".repeat(32);

describe("isCronAuthorized", () => {
  it("accepts the bearer value of the secret", () => {
    expect(isCronAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it.each([
    ["no header", null],
    ["an empty header", ""],
    ["a wrong secret", `Bearer ${"t".repeat(32)}`],
    ["a longer secret", `Bearer ${SECRET}x`],
    ["a shorter secret", `Bearer ${SECRET.slice(1)}`],
    ["the bare secret", SECRET],
    ["another scheme", `Basic ${SECRET}`],
    ["a lower-case scheme", `bearer ${SECRET}`],
    ["a repeated header", `Bearer ${SECRET}, Bearer ${SECRET}`],
    ["padding", ` Bearer ${SECRET}`],
    ["Bearer undefined", "Bearer undefined"],
  ])("refuses %s", (_label, header) => {
    expect(isCronAuthorized(header, SECRET)).toBe(false);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["31 characters", "s".repeat(31)],
    ["only spaces", " ".repeat(40)],
    ["short once trimmed", ` ${"s".repeat(31)} `.padEnd(40)],
  ])("refuses everything when the secret is %s", (_label, secret) => {
    for (const header of [
      "Bearer undefined",
      "Bearer ",
      "Bearer",
      `Bearer ${String(secret)}`,
      null,
    ]) {
      expect(isCronAuthorized(header, secret)).toBe(false);
    }
  });

  it.each([
    ["a trailing newline", `${SECRET}\n`],
    ["a trailing CRLF", `${SECRET}\r\n`],
    ["surrounding spaces", `  ${SECRET} `],
  ])("matches a secret stored with %s", (_label, stored) => {
    expect(isCronAuthorized(`Bearer ${SECRET}`, stored)).toBe(true);
  });

  it.each([
    ["the padded secret", `Bearer ${SECRET}\n`],
    ["a padded header", ` Bearer ${SECRET}`],
    ["a wrong secret", `Bearer ${"t".repeat(32)}`],
  ])("still refuses %s when the secret has a newline", (_label, header) => {
    expect(isCronAuthorized(header, `${SECRET}\n`)).toBe(false);
  });

  it("accepts a secret of exactly 32 characters", () => {
    const secret = "a".repeat(32);
    expect(isCronAuthorized(`Bearer ${secret}`, secret)).toBe(true);
  });

  it("refuses a secret literally named undefined, however it is padded", () => {
    const secret = "undefined".padEnd(32, "x");
    expect(isCronAuthorized("Bearer undefined", secret)).toBe(false);
  });
});
