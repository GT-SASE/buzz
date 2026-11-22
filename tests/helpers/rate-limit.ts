import { rateLimits } from "../../packages/db/src/schema";

const counts = new Map<string, number>();

/** Forget every count, as a fresh database would. */
export function resetRateLimits() {
  counts.clear();
}

/**
 * Router tests hand the procedure a fake `db` built for the query under test.
 * The limiter writes to its own table through that same handle, so this lets a
 * fake keep counting in memory without learning the limiter's queries: only
 * `insert` and `delete` aimed at the limiter's table are answered here, and
 * everything else reaches the wrapped fake untouched. The real SQL is covered
 * by `rate-limit.integration.test.ts`.
 */
export function withMemoryLimiter<T>(fake: T): T {
  const db = fake as object;
  const forward = (method: "insert" | "delete", table: unknown) =>
    (Reflect.get(db, method) as (table: unknown) => unknown).call(db, table);

  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "insert") {
        return (table: unknown) =>
          table === rateLimits
            ? {
                values: (row: { key: string; windowStart: Date }) => ({
                  onConflictDoUpdate: () => ({
                    returning: () => {
                      const id = `${row.key}@${row.windowStart.getTime()}`;
                      const count = (counts.get(id) ?? 0) + 1;
                      counts.set(id, count);
                      return Promise.resolve([{ count }]);
                    },
                  }),
                }),
              }
            : forward("insert", table);
      }
      if (property === "delete") {
        return (table: unknown) =>
          table === rateLimits
            ? { where: () => Promise.resolve() }
            : forward("delete", table);
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as T;
}
