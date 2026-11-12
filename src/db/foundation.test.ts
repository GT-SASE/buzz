import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeId } from "../../test/support/ids.ts";
import {
  recordingSql,
  serverError,
  unavailable,
} from "../../test/support/sql-client.ts";
import { getGuildConfig } from "./guild-config.ts";
import { claimInteraction } from "./interaction-claims.ts";
import { markTaskDoneAsOfficer } from "./tasks.ts";
import type { DateOnly } from "../lib/dates.ts";
import { createDbClient, withDeadline } from "./client.ts";
import { errorSummary, failureFromError } from "./errors.ts";
import { capped, changedRow, sql } from "./internal.ts";
import { isoTimestamp } from "./parsers.ts";
import {
  MAX_SEARCH_LENGTH,
  isDbDate,
  isSearchTerm,
  isStoredText,
  isUuid,
  searchPattern,
} from "./validate.ts";

const UUID = "11111111-2222-4333-8444-555555555555";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

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

  it("reports a request that never reached the server as unavailable", async () => {
    const { sql: refusing } = recordingSql(() =>
      Object.assign(unavailable(), { message: "host and password" }),
    );
    const result = await getGuildConfig(createDbClient(refusing), {
      guildId: fakeId(),
    });
    expect(result).toEqual({
      ok: false,
      error: { category: "unavailable", code: null },
    });
  });

  it("reads its setting on first use, not on import", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { getDb } = await import("./client.ts");
    expect(() => getDb()).toThrow("DATABASE_URL");
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

  it("refuses a fragment that carries values", () => {
    const fragment = sql`name = ${"x"}`;
    expect(() => sql`select id from events where ${fragment}`).toThrow(
      TypeError,
    );
  });
});

describe("rows", () => {
  it("keeps a timestamp as exact ISO text, to send back as a version", () => {
    expect(isoTimestamp("2030-01-10 12:00:00.123456+00")).toBe(
      "2030-01-10T12:00:00.123456+00:00",
    );
    expect(isoTimestamp("2030-01-10 12:00:00-05:30")).toBe(
      "2030-01-10T12:00:00-05:30",
    );
  });

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
    ["CF410", "parent_unavailable"],
    ["CF412", "task_changed"],
    ["CF429", "event_task_limit"],
    ["CF430", "actor_task_limit"],
    ["CF431", "step_assignee_limit"],
    ["23505", "conflict"],
    ["42501", "forbidden"],
    ["28P01", "forbidden"],
    ["28000", "forbidden"],
    ["57014", "unavailable"],
    ["08006", "unavailable"],
    ["53300", "unavailable"],
    ["XX000", "unavailable"],
    ["42601", "unexpected"],
  ])("maps %s to %s", (code, category) => {
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
    [
      "a server error with no readable code",
      Object.assign(new Error(text), { severity: "ERROR", code: "bad" }),
    ],
  ])("reports %s as unavailable, with no code or text", (_name, error) => {
    const result = failureFromError(error);
    expect(result.error).toEqual({ category: "unavailable", code: null });
  });

  it.each([
    ["a TypeError", new TypeError(text)],
    ["a plain error with no code", new Error(text)],
    ["a value that is not an error", text],
  ])("reports %s as unexpected, with no code", (_name, error) => {
    const result = failureFromError(error);
    expect(result.error).toEqual({ category: "unexpected", code: null });
  });
});

describe("input checks", () => {
  it.each([UUID])("accepts the UUID %s", (value) => {
    expect(isUuid(value)).toBe(true);
  });

  it.each([
    "",
    "x",
    `${UUID} `,
    `${UUID},`,
    `${UUID}"`,
    "AAAAAAAA-2222-4333-8444-555555555555",
    `${UUID}\n`,
    null,
    7,
  ])("refuses the UUID %j", (value) => {
    expect(isUuid(value)).toBe(false);
  });

  it.each(["2000-01-01", "9999-12-31", "2030-02-28"])(
    "accepts the date %s",
    (value) => {
      expect(isDbDate(value)).toBe(true);
    },
  );

  it.each([
    "1999-12-31",
    "2030-02-30",
    "infinity",
    "2030-1-1",
    "2030-01-01T00:00:00Z",
    "",
  ])("refuses the date %s", (value) => {
    expect(isDbDate(value)).toBe(false);
  });

  it("refuses blank text, NUL, lone surrogates and overlong text", () => {
    expect(isStoredText("ok", 10)).toBe(true);
    expect(isStoredText("  ", 10)).toBe(false);
    expect(isStoredText("a\u0000b", 10)).toBe(false);
    expect(isStoredText("a\ud800b", 10)).toBe(false);
    expect(isStoredText("a\udc00", 10)).toBe(false);
    expect(isStoredText("12345678901", 10)).toBe(false);
  });

  it("counts an astral character as two against a limit", () => {
    expect(isStoredText("\u{1F389}".repeat(5), 10)).toBe(true);
    expect(isStoredText("\u{1F389}".repeat(6), 10)).toBe(false);
  });

  it("refuses search terms with NUL or a lone surrogate", () => {
    expect(isSearchTerm("a,b)c")).toBe(true);
    expect(isSearchTerm("")).toBe(true);
    expect(isSearchTerm("a\u0000")).toBe(false);
    expect(isSearchTerm("\ud800")).toBe(false);
  });

  it.each([
    ["plain", "%plain%"],
    ["50%", "%50\\%%"],
    ["a_b", "%a\\_b%"],
    ["a*b", "%a*b%"],
    ["a\\b", "%a\\\\b%"],
    ['a,b).c"', '%a,b).c"%'],
    ["", "%%"],
  ])("builds a literal pattern from %j", (term, pattern) => {
    expect(searchPattern(term)).toBe(pattern);
  });

  it("caps the term in code points without splitting a pair", () => {
    const pattern = searchPattern("\u{1F389}".repeat(MAX_SEARCH_LENGTH + 50));
    expect(pattern.isWellFormed()).toBe(true);
    expect(Array.from(pattern.slice(1, -1))).toHaveLength(MAX_SEARCH_LENGTH);
    expect(searchPattern("a".repeat(6000))).toHaveLength(MAX_SEARCH_LENGTH + 2);
  });

  it("brands a checked date", () => {
    const value: unknown = "2030-01-01";
    if (isDbDate(value)) {
      const date: DateOnly = value;
      expect(date).toBe("2030-01-01");
    }
  });
});
