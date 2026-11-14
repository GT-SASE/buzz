import { describe, expect, it } from "bun:test";
import { fakeId } from "../../test/support/ids.ts";
import {
  recordingSql,
  serverError,
  unavailable,
} from "../../test/support/sql-client.ts";
import { getGuildConfig } from "./guild-config.ts";
import { claimInteraction } from "./interaction-claims.ts";
import { markTaskDoneAsOfficer } from "./tasks.ts";
import { createDbClient, withDeadline } from "./client.ts";
import { errorSummary, failureFromError } from "./errors.ts";
import { capped, changedRow, sql } from "./internal.ts";
import {
  MAX_SEARCH_LENGTH,
  isDbDate,
  isSearchTerm,
  isStoredText,
  isUuid,
  searchPattern,
} from "./validate.ts";

const UUID = "11111111-2222-4333-8444-555555555555";

describe("client", () => {
  it("abandons a query at its deadline, aborts it and reports it as unavailable", async () => {
    let signal: AbortSignal | undefined;
    const db = withDeadline(
      createDbClient((_text, _params, given) => {
        signal = given;
        return new Promise<never>(() => undefined);
      }),
      10,
    );
    const started = Date.now();
    expect(await getGuildConfig(db, { guildId: fakeId() })).toEqual({
      ok: false,
      error: { category: "unavailable", code: null },
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(signal?.aborted).toBe(true);
  });

  it("never sends a statement twice, read or write, whatever the failure", async () => {
    for (const error of [
      serverError("57P01"),
      unavailable(),
      new TypeError(),
    ]) {
      const read = recordingSql(() => error);
      await getGuildConfig(createDbClient(read.sql), {
        guildId: fakeId(),
      });
      expect(read.calls).toHaveLength(1);

      const write = recordingSql(() => error);
      await markTaskDoneAsOfficer(createDbClient(write.sql), {
        guildId: fakeId(),
        taskId: UUID,
        now: new Date(),
      });
      expect(write.calls).toHaveLength(1);

      const call = recordingSql(() => error);
      await claimInteraction(createDbClient(call.sql), {
        interactionId: fakeId(),
      });
      expect(call.calls).toHaveLength(1);
    }
  });
});

describe("the sql tag", () => {
  it("sends every value as a parameter, never as text", () => {
    const hostile = "x'); DROP TABLE public.tasks; --";
    const query = sql`select id from tasks where description = ${hostile} and guild_id = ${"1"}`;
    expect(query.text).toBe(
      "select id from tasks where description = $1 and guild_id = $2",
    );
    expect(query.params).toEqual([hostile, "1"]);
  });
});

describe("rows", () => {
  it("caps a list and says when there were more rows", () => {
    expect(capped({ ok: true, value: [1, 2, 3] }, 2)).toEqual({
      ok: true,
      value: { rows: [1, 2], truncated: true },
    });
    expect(capped({ ok: true, value: [1, 2] }, 2)).toEqual({
      ok: true,
      value: { rows: [1, 2], truncated: false },
    });
  });

  it("treats a write that changed no row as not found, and two as unexpected", () => {
    expect(changedRow({ ok: true, value: [] })).toEqual({
      ok: false,
      error: { category: "not_found", code: null },
    });
    expect(changedRow({ ok: true, value: [1, 2] })).toEqual({
      ok: false,
      error: { category: "unexpected", code: null },
    });
    expect(changedRow({ ok: true, value: [1] })).toEqual({
      ok: true,
      value: 1,
    });
  });
});

describe("errors from the driver", () => {
  const text = "row text";

  it("keeps only a category and the SQLSTATE of a server error", () => {
    const error = Object.assign(new Error(`failing row contains ${text}`), {
      code: "23514",
      severity: "ERROR",
      detail: text,
    });
    expect(failureFromError(error)).toEqual({
      ok: false,
      error: { category: "constraint", code: "23514" },
    });
    expect(errorSummary(failureFromError(error).error)).toBe(
      "constraint:23514",
    );
  });

  it.each([
    ["CF409", "stale_version"],
    ["CF429", "event_task_limit"],
    ["23505", "conflict"],
    ["42501", "forbidden"],
    ["57014", "unavailable"],
    ["42601", "unexpected"],
  ] as const)("maps %s to %s", (code, category) => {
    expect(
      failureFromError(
        Object.assign(new Error(text), { code, severity: "ERROR" }),
      ).error,
    ).toEqual({ category, code });
  });

  it.each([
    ["a network failure", unavailable()],
    [
      "an HTTP error",
      Object.assign(new Error(`Server error (HTTP status 502): ${text}`), {
        name: "NeonDbError",
      }),
    ],
  ])("reports %s as unavailable, with no code or text", (_name, error) => {
    const result = failureFromError(error);
    expect(result.error).toEqual({ category: "unavailable", code: null });
  });

  it.each([
    ["a TypeError", new TypeError(text)],
    ["a value that is not an error", text],
  ])("reports %s as unexpected, with no code", (_name, error) => {
    const result = failureFromError(error);
    expect(result.error).toEqual({ category: "unexpected", code: null });
  });
});

describe("input checks", () => {
  it("accepts a UUID and refuses near misses", () => {
    expect(isUuid(UUID)).toBe(true);
    for (const value of [
      `${UUID} `,
      `${UUID}\n`,
      "AAAAAAAA-2222-4333-8444-555555555555",
      7,
    ]) {
      expect(isUuid(value)).toBe(false);
    }
  });

  it.each([
    ["2000-01-01", true],
    ["9999-12-31", true],
    ["1999-12-31", false],
    ["2030-02-30", false],
    ["infinity", false],
    ["2030-01-01T00:00:00Z", false],
  ])("treats the date %s as %p", (value, expected) => {
    expect(isDbDate(value)).toBe(expected);
  });

  it("refuses blank text, NUL, lone surrogates and overlong text", () => {
    expect(isStoredText("ok", 10)).toBe(true);
    expect(isStoredText("  ", 10)).toBe(false);
    expect(isStoredText("a\u0000b", 10)).toBe(false);
    expect(isStoredText("a\ud800b", 10)).toBe(false);
    expect(isStoredText("12345678901", 10)).toBe(false);
    // An astral character counts as two.
    expect(isStoredText("\u{1F389}".repeat(6), 10)).toBe(false);
  });

  it("refuses search terms with NUL or a lone surrogate", () => {
    expect(isSearchTerm("a,b)c")).toBe(true);
    expect(isSearchTerm("a\u0000")).toBe(false);
    expect(isSearchTerm("\ud800")).toBe(false);
  });

  it.each([
    ["50%", "%50\\%%"],
    ["a_b", "%a\\_b%"],
    ["a\\b", "%a\\\\b%"],
  ])("builds a literal pattern from %j", (term, pattern) => {
    expect(searchPattern(term)).toBe(pattern);
  });

  it("caps the term in code points without splitting a pair", () => {
    const pattern = searchPattern("\u{1F389}".repeat(MAX_SEARCH_LENGTH + 50));
    expect(pattern.isWellFormed()).toBe(true);
    expect(Array.from(pattern.slice(1, -1))).toHaveLength(MAX_SEARCH_LENGTH);
  });
});
