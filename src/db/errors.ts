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

/**
 * Reads only the SQLSTATE from a failed statement, never its message, which can quote
 * the statement, its parameters or the failing row. An error the server raised has a
 * severity. Neon's driver also throws `NeonDbError` with none when the request itself
 * failed, such as a network error, an HTTP error or an abort, and that is `unavailable`.
 * Anything else is a fault in the code, such as a TypeError, and is `unexpected` so that
 * it is not retried as an outage.
 */
export function failureFromError(error: unknown): DbFailure {
  if (typeof error !== "object" || error === null) {
    return failure("unexpected");
  }
  const { code, severity, name } = error as {
    code?: unknown;
    severity?: unknown;
    name?: unknown;
  };
  if (typeof severity !== "string") {
    return failure(name === "NeonDbError" ? "unavailable" : "unexpected");
  }
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
