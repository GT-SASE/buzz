import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TEST_ORIGIN,
  TEST_SECRET_KEY,
  mockPostgrest,
  testSnowflake,
} from "../../test/support/mock-postgrest.ts";
import { ConfigError } from "../lib/config-error.ts";
import type { DateOnly } from "../lib/dates.ts";
import type { EventResource, TaskResource } from "../lib/permissions.ts";
import {
  INTERACTION_DEADLINE_MS,
  createDbClient,
  withDeadline,
  type DbClient,
} from "./client.ts";
import { errorSummary, failureFromResponse } from "./errors.ts";
import { rest } from "./internal.ts";
import { cappedList, oneOrNone, rowList } from "./result.ts";
import { parseJobRun, parseTask, type Database } from "./types.ts";
import {
  MAX_SEARCH_LENGTH,
  isDbDate,
  isSearchTerm,
  isSnowflakeList,
  isStoredText,
  isTimestampText,
  isUuid,
  keysetAfter,
  searchPattern,
  snowflakeList,
  uuidList,
} from "./validate.ts";

const UUID = "11111111-2222-4333-8444-555555555555";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("client", () => {
  const settings = { url: TEST_ORIGIN, secretKey: TEST_SECRET_KEY };

  it("sends the key only in the apikey header, to the REST path", async () => {
    const { db, requests } = mockPostgrest();
    await rest(db).from("guild_config").select("guild_id").limit(1);
    expect(requests[0]?.rawTarget).toBe(
      "/rest/v1/guild_config?select=guild_id&limit=1",
    );
    expect(requests[0]?.headers.get("apikey")).toBe(TEST_SECRET_KEY);
    expect(requests[0]?.headers.get("authorization")).toBeNull();
    expect(requests[0]?.headers.get("accept-profile")).toBe("public");
  });

  it("refuses redirects and sets a timeout on every request", async () => {
    const send = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("[]", { status: 200 })),
    );
    const db = createDbClient({ ...settings, fetch: send });
    await rest(db).from("guild_config").select("guild_id").limit(1);
    const init = send.mock.calls[0]?.[1];
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("abandons a request at its deadline and reports it as unavailable", async () => {
    const send: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason as Error);
        });
      });
    const db = withDeadline(createDbClient({ ...settings, fetch: send }), 10);
    const result = oneOrNone(
      await rest(db).from("tasks").select("id").limit(1),
      parseTask,
    );
    expect(result).toEqual({
      ok: false,
      error: { category: "unavailable", code: null },
    });
  });

  it("keeps interaction calls inside Discord's first reply window", () => {
    expect(INTERACTION_DEADLINE_MS).toBeLessThan(2500);
  });

  it.each([0, -1, 1.5, Number.NaN, 8001])(
    "refuses the deadline %d",
    (deadline) => {
      const db = createDbClient(settings);
      expect(() => withDeadline(db, deadline)).toThrow(RangeError);
    },
  );

  it("gives code outside src/db nothing to query with", () => {
    const db: DbClient = createDbClient(settings);
    // @ts-expect-error the client is opaque outside src/db
    expect(db.from).toBeUndefined();
    // @ts-expect-error the client is opaque outside src/db
    expect(db.rpc).toBeUndefined();
  });

  it("refuses an object that is not a client", () => {
    expect(() => rest({} as DbClient)).toThrow(TypeError);
  });

  it("does not retry a failed read", async () => {
    const send = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("{}", { status: 503 })),
    );
    const db = createDbClient({ ...settings, fetch: send });
    await rest(db).from("guild_config").select("guild_id").limit(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    "http://project.example.test",
    "https://user:pass@project.example.test",
    "https://project.example.test/rest/v1",
    "https://project.example.test?x=1",
    "not a url",
  ])("refuses the URL %s without quoting it", (url) => {
    expect(() => createDbClient({ ...settings, url })).toThrow(ConfigError);
  });

  it.each(["anon-key", "sb_publishable_abc", "sb_secret_", "sb_secret_a b"])(
    "refuses the key %s without quoting it",
    (secretKey) => {
      try {
        createDbClient({ ...settings, secretKey });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).not.toContain(secretKey);
      }
    },
  );

  it("refuses to run where a browser global exists", () => {
    vi.stubGlobal("window", {});
    expect(() => createDbClient(settings)).toThrow("server-side only");
  });

  it("reads settings on first use, not on import, and reuses one client", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    const { getDb } = await import("./client.ts");
    expect(() => getDb()).toThrow("SUPABASE_URL");

    vi.stubEnv("SUPABASE_URL", TEST_ORIGIN);
    expect(() => getDb()).toThrow("SUPABASE_SECRET_KEY");

    vi.stubEnv("SUPABASE_SECRET_KEY", TEST_SECRET_KEY);
    expect(getDb()).toBe(getDb());
  });
});

describe("errors", () => {
  const canary = "canary-row-text";
  const pgError = {
    code: "23514",
    message: `failing row contains ${canary}`,
    details: canary,
    hint: canary,
  };

  it("keeps only a category and the code", () => {
    const result = failureFromResponse(pgError, 400);
    expect(result.error).toEqual({ category: "constraint", code: "23514" });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(errorSummary(result.error)).toBe("constraint:23514");
  });

  it.each([
    ["CF409", "stale_version"],
    ["CF410", "parent_unavailable"],
    ["23505", "conflict"],
    ["42501", "forbidden"],
    ["XX000", "unexpected"],
    ["PGRST116", "unexpected"],
    ["40001", "unavailable"],
    ["40P01", "unavailable"],
    ["55P03", "unavailable"],
    ["57014", "unavailable"],
  ])("maps %s to %s", (code, category) => {
    expect(failureFromResponse({ code }, 400).error).toEqual({
      category,
      code,
    });
  });

  it("treats an unknown code on a server error as unavailable", () => {
    expect(failureFromResponse({ code: "XX000" }, 500).error).toEqual({
      category: "unavailable",
      code: "XX000",
    });
  });

  it.each([
    [401, "forbidden"],
    [403, "forbidden"],
    [429, "unavailable"],
    [500, "unavailable"],
    [503, "unavailable"],
    [400, "unexpected"],
    [404, "unexpected"],
  ])("with no code, reads status %d as %s", (status, category) => {
    expect(failureFromResponse({ message: canary }, status).error).toEqual({
      category,
      code: null,
    });
  });

  it.each([
    ["a network error's code", { code: "EPIPE", message: canary }, 0],
    ["a gateway error with no code", { message: canary }, 502],
    ["a code that is not a code", { code: canary }, 400],
  ])("drops %s", (_name, error, status) => {
    const result = failureFromResponse(error, status);
    expect(result.error.code).toBeNull();
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it("reports a rejected fetch as unavailable, with no text from the error", async () => {
    const db = createDbClient({
      url: TEST_ORIGIN,
      secretKey: TEST_SECRET_KEY,
      fetch: () => Promise.reject(new TypeError(canary)),
    });
    const result = oneOrNone(
      await rest(db).from("tasks").select("id").limit(1),
      parseTask,
    );
    expect(result).toEqual({
      ok: false,
      error: { category: "unavailable", code: null },
    });
  });
});

describe("row checks", () => {
  const goodTask = {
    id: UUID,
    event_id: UUID,
    guild_id: testSnowflake(),
    assignee_id: testSnowflake(),
    description: "Book the room",
    due_date: "2030-01-10",
    status: "open",
    completed_at: null,
    created_by: testSnowflake(),
    deleted_at: null,
    updated_at: "2030-01-01T12:00:00.123456+00:00",
  };
  const response = (data: unknown) => ({ data, error: null, status: 200 });

  it("reads a good row with a real date", () => {
    const parsed = parseTask(goodTask);
    expect(parsed).toMatchObject({
      ok: true,
      row: { id: UUID, due_date: "2030-01-10" },
    });
  });

  it.each([
    ["due_date", "2030-02-30"],
    ["due_date", "infinity"],
    ["due_date", null],
    ["status", "archived"],
    ["guild_id", "12"],
    ["id", "not-a-uuid"],
    ["completed_at", "yesterday"],
    ["description", 7],
  ])("excludes a row with %s = %j and names the field", (field, value) => {
    const list = rowList(
      response([goodTask, { ...goodTask, [field]: value }]),
      parseTask,
    );
    expect(list).toMatchObject({
      ok: true,
      value: {
        rows: [{ id: UUID }],
        excluded: [{ table: "tasks", field }],
      },
    });
  });

  it("reports an excluded row without any of its text", () => {
    const list = rowList(
      response([{ ...goodTask, description: "secret words", due_date: "bad" }]),
      parseTask,
    );
    expect(JSON.stringify(list)).not.toContain("secret words");
  });

  it("gives rows the column names authorization works from", () => {
    const parsed = parseTask(goodTask);
    if (!parsed.ok) {
      throw new Error("expected a good row");
    }
    const task: TaskResource = parsed.row;
    const event: EventResource = parsed.row;
    expect(task.assignee_id).toBe(goodTask.assignee_id);
    expect(event.deleted_at).toBeNull();
  });

  it("keeps a timestamp as the exact text, to send back as an expected value", () => {
    expect(parseTask(goodTask)).toMatchObject({
      row: { updated_at: "2030-01-01T12:00:00.123456+00:00" },
    });
  });

  it("caps a list and says when there were more rows", () => {
    const row = goodTask;
    const over = cappedList(response([row, row, row]), parseTask, 2);
    expect(over.ok && over.value.rows).toHaveLength(2);
    expect(over.ok && over.value.truncated).toBe(true);
    const exact = cappedList(response([row, row]), parseTask, 2);
    expect(exact.ok && exact.value.rows).toHaveLength(2);
    expect(exact.ok && exact.value.truncated).toBe(false);
  });

  it("reads inherited properties as missing", () => {
    const row: unknown = Object.create({ ...goodTask });
    expect(parseTask(row).ok).toBe(false);
  });

  it("excludes things that are not rows", () => {
    const list = rowList(response([null, 3, "x", []]), parseTask);
    expect(list).toMatchObject({ ok: true, value: { rows: [] } });
    expect(list.ok && list.value.excluded).toHaveLength(4);
  });

  it("treats a bad row on a read by key as a failure", () => {
    expect(oneOrNone(response([{ id: UUID }]), parseTask)).toEqual({
      ok: false,
      error: { category: "bad_row", code: null },
    });
  });

  it("treats a response that is not a list as a failure", () => {
    expect(rowList(response({ id: UUID }), parseTask).ok).toBe(false);
  });

  it("requires job results to be an object", () => {
    expect(parseJobRun({ results: [] }).ok).toBe(false);
  });

  it("types writes to the granted columns, and never a null deleted_at", () => {
    type TaskUpdate = Database["public"]["Tables"]["tasks"]["Update"];
    // @ts-expect-error a soft delete cannot be undone through this type
    const revive: TaskUpdate = { deleted_at: null };
    // @ts-expect-error a task cannot move to another guild
    const moved: TaskUpdate = { guild_id: "x" };
    expect([revive, moved]).toHaveLength(2);
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
    ["a*b", "%a\\*b%"],
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

  it.each([
    "2030-01-01T12:00:00+00:00",
    "2030-01-01T12:00:00.123456+00:00",
    "2030-01-01T12:00:00Z",
  ])("accepts the timestamp %s", (value) => {
    expect(isTimestampText(value)).toBe(true);
  });

  it.each([
    "",
    "2030-01-01",
    "yesterday",
    "2030-13-01T12:00:00Z",
    "2030-01-01T12:00:00Z,x",
    "2030-01-01T12:00:00Z\n",
    null,
  ])("refuses the timestamp %j", (value) => {
    expect(isTimestampText(value)).toBe(false);
  });

  it("builds a page position only from a checked date and ID", () => {
    expect(keysetAfter("2030-01-10", UUID)).toBe(
      `due_date.gt.2030-01-10,and(due_date.eq.2030-01-10,id.gt.${UUID})`,
    );
    expect(() => keysetAfter("2030-01-10,x", UUID)).toThrow(RangeError);
    expect(() => keysetAfter("2030-01-10", `${UUID})`)).toThrow(RangeError);
  });

  it("refuses an ID list holding a crafted value", () => {
    const good = testSnowflake();
    const crafted = 'x","y';
    expect(isSnowflakeList([good])).toBe(true);
    expect(isSnowflakeList([good, crafted])).toBe(false);
    expect(() => snowflakeList([good, crafted])).toThrow(RangeError);
    expect(() => uuidList([UUID, crafted])).toThrow(RangeError);
    expect(snowflakeList([good])).toEqual([good]);
    expect(uuidList([UUID])).toEqual([UUID]);
  });

  it("refuses a list that is too long", () => {
    const ids = Array.from({ length: 101 }, () => testSnowflake());
    expect(isSnowflakeList(ids)).toBe(false);
    expect(() => snowflakeList(ids)).toThrow(RangeError);
  });

  it("brands a checked date", () => {
    const value: unknown = "2030-01-01";
    if (isDbDate(value)) {
      const date: DateOnly = value;
      expect(date).toBe("2030-01-01");
    }
  });
});
