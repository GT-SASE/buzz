import { auditLog, pointsLedger } from "../../packages/db/src/schema";

type Row = Record<string, unknown>;

/** Every audit row written since the last `resetWrites()`, in order. */
export const auditRows: Row[] = [];
/** Every ledger row written since the last `resetWrites()`, in order. */
export const ledgerRows: Row[] = [];

export function resetWrites() {
  auditRows.length = 0;
  ledgerRows.length = 0;
}

/**
 * Router tests hand the procedure a fake `db` built for the query under test.
 * Audited procedures also append to `buzz_audit_log` and `buzz_points_ledger`
 * through that same handle, inside the transaction, so this answers those two
 * tables in memory and lets a test assert the rows without teaching each fake
 * the audit queries. Everything else reaches the wrapped fake untouched.
 *
 * `transaction` is wrapped too, so the handle a procedure receives inside one
 * is answered the same way. A fake with no `transaction` gets one that runs
 * the callback against itself. The real SQL, with a real rollback, is covered
 * by `audit-log.integration.test.ts`.
 */
export function withMemoryAudit<T>(fake: T): T {
  const wrap = (target: object): object =>
    new Proxy(target, {
      get(inner, property, receiver) {
        if (property === "insert") {
          return (table: unknown) => {
            const sink =
              table === auditLog
                ? auditRows
                : table === pointsLedger
                  ? ledgerRows
                  : null;
            if (!sink) {
              return (
                Reflect.get(inner, "insert") as (table: unknown) => unknown
              ).call(inner, table);
            }
            return {
              values: (values: Row | Row[]) => {
                sink.push(...(Array.isArray(values) ? values : [values]));
                return Promise.resolve();
              },
            };
          };
        }
        if (property === "transaction") {
          const own = Reflect.get(inner, "transaction") as
            | ((fn: (tx: object) => Promise<unknown>) => Promise<unknown>)
            | undefined;
          return (fn: (tx: object) => Promise<unknown>) =>
            own
              ? own.call(inner, (tx) => fn(wrap(tx)))
              : fn(receiver as object);
        }
        return Reflect.get(inner, property, receiver) as unknown;
      },
    });

  return wrap(fake as object) as T;
}
