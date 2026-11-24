/**
 * Database failures as a fixed category and a Postgres code (SQLSTATE). The driver also
 * gives a message, a detail and a hint, which can quote the failing row or the query,
 * so those are dropped here and never reach a caller, a log line or `job_runs`.
 */

export type DbErrorCategory =
  /** Refused before any query, because an input failed validation. */
  | "invalid_input"
  /** No row matched. Absent and forbidden look the same on purpose. */
  | "not_found"
  /** A config version check failed: reload and try again. */
  | "stale_version"
  /** The channel was removed, or the event closed or deleted. */
  | "parent_unavailable"
  /** The task changed after the caller read it. */
  | "task_changed"
  /** The event already holds as many tasks as it may. */
  | "event_task_limit"
  /** This officer has created as many tasks as they may for now. */
  | "actor_task_limit"
  /** The step already has as many people as it may. */
  | "step_assignee_limit"
  /** The step waits on another: Engage picture added on Engage post. */
  | "step_not_ready"
  | "conflict"
  | "constraint"
  | "forbidden"
  | "unavailable"
  | "unexpected";

export interface DbError {
  readonly category: DbErrorCategory;
  readonly code: string | null;
}

export interface DbFailure {
  readonly ok: false;
  readonly error: DbError;
}

export type DbResult<T> = { readonly ok: true; readonly value: T } | DbFailure;

const CATEGORY_BY_CODE = new Map<string, DbErrorCategory>([
  ["CF409", "stale_version"],
  ["CF410", "parent_unavailable"],
  ["CF412", "task_changed"],
  ["CF429", "event_task_limit"],
  ["CF430", "actor_task_limit"],
  ["CF425", "step_not_ready"],
  ["CF431", "step_assignee_limit"],
  ["23505", "conflict"],
  ["23502", "constraint"],
  ["23503", "constraint"],
  ["23514", "constraint"],
  ["22023", "constraint"],
  ["22P02", "constraint"],
  ["22P05", "constraint"],
  ["22007", "constraint"],
  ["22008", "constraint"],
  ["42501", "forbidden"],
  // Lost a lock or was cancelled: nothing was wrong with the request, so try later.
  ["40001", "unavailable"],
  ["40P01", "unavailable"],
  ["55P03", "unavailable"],
  ["57014", "unavailable"],
]);

export function failure(
  category: DbErrorCategory,
  code: string | null = null,
): DbFailure {
  return { ok: false, error: { category, code } };
}

export function refused(): DbFailure {
  return failure("invalid_input");
}

/** SQLSTATE classes that say the server could not do the work now, not that it was wrong. */
const UNAVAILABLE_CLASSES = new Set(["08", "53", "57", "58", "XX"]);

/** SQLSTATE classes for a refused login or role, which look like any other refusal. */
const FORBIDDEN_CLASSES = new Set(["28"]);

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** Node's and the driver's names for a connection that could not be made or was lost. */
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);
const NETWORK_ERROR_MESSAGE =
  /^(Connection terminated|Client has encountered a connection error|timeout exceeded when trying to connect|Error connecting to database|Cannot use a pool after calling end)/;

interface ErrorLike {
  code?: unknown;
  severity?: unknown;
  name?: unknown;
  message?: unknown;
  cause?: unknown;
}

/** An error and the errors under it. Drizzle wraps a failed statement's error as `cause`. */
function chain(error: unknown): ErrorLike[] {
  const found: ErrorLike[] = [];
  let current: unknown = error;
  while (typeof current === "object" && current !== null && found.length < 5) {
    found.push(current);
    current = (current as ErrorLike).cause;
  }
  return found;
}

/**
 * Reads only the SQLSTATE from a failed statement, never its message, which can quote
 * the statement, its parameters or the failing row. An error the server raised has a
 * severity, and may sit under a wrapper that Drizzle adds. Neon's driver also throws
 * `NeonDbError` with none when the request itself failed, such as a network error, an
 * HTTP error or an abort, and a pool that cannot reach the server throws a plain error
 * with a network code or a fixed message; all of those are `unavailable`. Anything else
 * is a fault in the code, such as a TypeError, and is `unexpected` so that it is not
 * retried as an outage.
 */
export function failureFromError(error: unknown): DbFailure {
  const errors = chain(error);
  if (errors.length === 0) {
    return failure("unexpected");
  }
  const served = errors.find((item) => typeof item.severity === "string");
  if (served === undefined) {
    return failure(
      errors.some(
        (item) =>
          item.name === "NeonDbError" ||
          (typeof item.code === "string" &&
            NETWORK_ERROR_CODES.has(item.code)) ||
          (typeof item.message === "string" &&
            NETWORK_ERROR_MESSAGE.test(item.message)),
      )
        ? "unavailable"
        : "unexpected",
    );
  }
  const { code } = served;
  if (typeof code !== "string" || !SQLSTATE.test(code)) {
    return failure("unavailable");
  }
  const codeClass = code.slice(0, 2);
  return failure(
    CATEGORY_BY_CODE.get(code) ??
      (FORBIDDEN_CLASSES.has(codeClass)
        ? "forbidden"
        : UNAVAILABLE_CLASSES.has(codeClass)
          ? "unavailable"
          : "unexpected"),
    code,
  );
}

/** The only form of an error that may be stored in `job_runs.error` or logged. */
export function errorSummary(error: {
  readonly category: string;
  readonly code: string | null;
}): string {
  return error.code === null
    ? error.category
    : `${error.category}:${error.code}`;
}
