import { describe, expect, it } from "vitest";
import { isSnowflake, snowflakeTime } from "./snowflake.ts";

describe("isSnowflake", () => {
  it.each([17, 18, 19, 20])("accepts %i digits", (length) => {
    expect(isSnowflake("1".repeat(length))).toBe(true);
  });

  it.each([
    ["too short", "1".repeat(16)],
    ["too long", "1".repeat(21)],
    ["a leading zero", `0${"1".repeat(17)}`],
    ["letters", `${"1".repeat(17)}a`],
    ["a trailing newline", `${"1".repeat(18)}\n`],
    ["the guild install value sent from a DM", "0"],
    ["a number", 111_111],
    ["null", null],
    ["undefined", undefined],
  ])("refuses %s", (_label, value) => {
    expect(isSnowflake(value)).toBe(false);
  });
});

describe("snowflakeTime", () => {
  it("reads the time an ID was made", () => {
    const at = Date.UTC(2026, 10, 4);
    const id = (BigInt(at - 1420070400000) << 22n) + 5n;

    expect(snowflakeTime(id.toString())).toBe(at);
  });
});
