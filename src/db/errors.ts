/**
 * Database failures as a fixed category and a Postgres code. PostgREST also returns
 * `message`, `details` and `hint`, which can quote the failing row, so those are
 * dropped here and never reach a caller, a log line or `job_runs`.
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
  | "conflict"
  | "constraint"
  | "forbidden"
  /** The database returned a row or value this code cannot read. */
  | "bad_row"
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
  ["PGRST301", "forbidden"],
  ["PGRST302", "forbidden"],
  // Lost a lock or was cancelled: nothing was wrong with the request, so try later.
  ["40001", "unavailable"],
  ["40P01", "unavailable"],
  ["55P03", "unavailable"],
  ["57014", "unavailable"],
]);

const POSTGRES_CODE = /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/;

export function failure(
  category: DbErrorCategory,
  code: string | null = null,
): DbFailure {
  return { ok: false, error: { category, code } };
}

export function refused(): DbFailure {
  return failure("invalid_input");
}

/**
 * Reads only the code from a PostgREST error. A status of 0 means the request never
 * got an answer, and the client then fills `code` from the network error instead.
 */
export function failureFromResponse(error: unknown, status: number): DbFailure {
  if (status === 0) {
    return failure("unavailable");
  }
  const raw =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  if (typeof raw === "string" && POSTGRES_CODE.test(raw)) {
    return failure(
      CATEGORY_BY_CODE.get(raw) ??
        (status >= 500 ? "unavailable" : "unexpected"),
      raw,
    );
  }
  if (status === 401 || status === 403) {
    return failure("forbidden");
  }
  return failure(
    status === 429 || status >= 500 ? "unavailable" : "unexpected",
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
