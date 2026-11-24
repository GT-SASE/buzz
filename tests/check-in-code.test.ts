import { afterEach, describe, expect, it } from "bun:test";

import {
  checkInCodeFor,
  checkInCodeIsCurrent,
  MAC_LENGTH,
  WINDOW_MS,
  windowAt,
  windowEnd,
} from "../packages/api/src/check-in-code";

const event = { id: "event-1", checkInCode: "ABCD2345" };
const other = { id: "event-2", checkInCode: "ABCD2345" };

/** A fake clock: every call states the instant it means. */
const T0 = Date.UTC(2026, 10, 24, 23, 0, 0);

describe("rotating check-in codes", () => {
  const secret = process.env.AUTH_SECRET;
  afterEach(() => {
    process.env.AUTH_SECRET = secret;
  });

  it("is the stored key followed by a MAC of the window", () => {
    const code = checkInCodeFor(event, T0);
    expect(code.startsWith("ABCD2345")).toBe(true);
    expect(code).toHaveLength(8 + MAC_LENGTH);
    expect(code).toMatch(/^[2-9A-HJKM-NP-TV-Z]+$/);
  });

  it("is the same for everyone inside one window and changes at its edge", () => {
    const start = windowAt(T0) * WINDOW_MS;
    expect(checkInCodeFor(event, start)).toBe(
      checkInCodeFor(event, start + WINDOW_MS - 1),
    );
    expect(checkInCodeFor(event, start)).not.toBe(
      checkInCodeFor(event, start + WINDOW_MS),
    );
    expect(windowEnd(start)).toBe(start + WINDOW_MS);
    expect(windowEnd(start + WINDOW_MS - 1)).toBe(start + WINDOW_MS);
  });

  it("is accepted in its own window", () => {
    const code = checkInCodeFor(event, T0);
    expect(checkInCodeIsCurrent(event, code, T0)).toBe(true);
    expect(
      checkInCodeIsCurrent(event, code, T0 + WINDOW_MS - 1 - (T0 % WINDOW_MS)),
    ).toBe(true);
  });

  it("is accepted in the next window too, the previous one from the checker's side", () => {
    const code = checkInCodeFor(event, T0);
    const nextWindow = (windowAt(T0) + 1) * WINDOW_MS;
    expect(checkInCodeIsCurrent(event, code, nextWindow)).toBe(true);
    expect(checkInCodeIsCurrent(event, code, nextWindow + WINDOW_MS - 1)).toBe(
      true,
    );
  });

  it("is refused two windows later", () => {
    const code = checkInCodeFor(event, T0);
    const twoLater = (windowAt(T0) + 2) * WINDOW_MS;
    expect(checkInCodeIsCurrent(event, code, twoLater)).toBe(false);
    expect(checkInCodeIsCurrent(event, code, twoLater + 10 * 60_000)).toBe(
      false,
    );
  });

  it("is refused before its window, so a guess at the future gains nothing", () => {
    const later = checkInCodeFor(event, T0 + 5 * WINDOW_MS);
    expect(checkInCodeIsCurrent(event, later, T0)).toBe(false);
  });

  it("is refused for another event, even one with the same stored key", () => {
    const code = checkInCodeFor(event, T0);
    expect(checkInCodeIsCurrent(other, code, T0)).toBe(false);
  });

  it("refuses the bare stored key, which is what every old poster carries", () => {
    expect(checkInCodeIsCurrent(event, "ABCD2345", T0)).toBe(false);
    expect(
      checkInCodeIsCurrent(event, "ABCD2345" + "2".repeat(MAC_LENGTH), T0),
    ).toBe(false);
  });

  it("refuses a code of the wrong length either side", () => {
    const code = checkInCodeFor(event, T0);
    expect(checkInCodeIsCurrent(event, code.slice(0, -1), T0)).toBe(false);
    expect(checkInCodeIsCurrent(event, code + "2", T0)).toBe(false);
  });

  it("changes with the server secret", () => {
    const before = checkInCodeFor(event, T0);
    process.env.AUTH_SECRET = "a-different-secret-a-different-secret-0000";
    expect(checkInCodeFor(event, T0)).not.toBe(before);
    expect(checkInCodeIsCurrent(event, before, T0)).toBe(false);
  });

  it("fails closed without a secret instead of signing with a constant", () => {
    delete process.env.AUTH_SECRET;
    expect(() => checkInCodeFor(event, T0)).toThrow(/not configured/);
  });
});
