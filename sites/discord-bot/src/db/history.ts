/**
 * Every update of the seven tracked tables, with what its triggers used to do around it:
 * the old row kept in `row_versions`, `updated_at` moved when something changed, a deleted
 * row kept deleted, a closed event kept closed, and nothing changed under a closed or
 * deleted event. The rows are locked first, the old version is read under the lock, and
 * the history is written after the update, in the same transaction.
 *
 * While the triggers still exist, they write the history row inside the update and this
 * writes the same row after it; the unique index on `row_versions` makes that one row.
 * The trigger's goes first, which is why this never goes before the update.
 */

import {
  and,
  eq,
  getTableColumns,
  getTableName,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import type { PgTable, SelectedFields } from "drizzle-orm/pg-core";
import type { BotTx } from "./client.ts";
import { raise } from "./internal.ts";
import {
  eventStepAssignees,
  eventSteps,
  events,
  guildConfig,
  managedChannels,
  rowVersions,
  setupDrafts,
  tasks,
  timezoneNames,
} from "./schema.ts";

export type TrackedTable =
  | typeof events
  | typeof tasks
  | typeof eventSteps
  | typeof eventStepAssignees
  | typeof guildConfig
  | typeof managedChannels
  | typeof setupDrafts;

/** The columns that name a row of each tracked table, in the order a history row joins them. */
const KEY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  events: ["id"],
  tasks: ["id"],
  event_steps: ["event_id", "kind"],
  event_step_assignees: ["id"],
  guild_config: ["guild_id"],
  managed_channels: ["guild_id", "channel_id"],
  setup_drafts: ["guild_id"],
};

type JsonRow = Record<string, unknown>;

/** `event_id` as the column's property is written, `eventId`. */
const camel = (column: string): string =>
  column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());

/** The row as the database's to_jsonb makes it, which is what a history row holds. */
function rowJson(table: PgTable): SQL<JsonRow> {
  // A whole-row reference names the table alone, without its schema.
  return sql<JsonRow>`to_jsonb(${sql.identifier(getTableName(table))})`;
}

/** The text a history row names its row by: the key columns, joined with `:`. */
export function rowIdOf(tableName: string, row: JsonRow): string {
  const keys = KEY_COLUMNS[tableName];
  if (keys === undefined) {
    throw new TypeError(`${tableName} keeps no history`);
  }
  return keys.map((key) => String(row[key])).join(":");
}

/** The same row, apart from `updated_at`, which a change moves and is not itself a change. */
function sameRow(before: JsonRow, after: JsonRow): boolean {
  const strip = (row: JsonRow): string =>
    JSON.stringify(
      Object.entries(row)
        .filter(([key]) => key !== "updated_at")
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  return strip(before) === strip(after);
}

/** Fails as the trigger did if the event a task sits under is closed or deleted. */
export async function requireOpenEvent(
  tx: BotTx,
  eventId: string,
  guildId: string,
): Promise<void> {
  const [event] = await tx
    .select({ status: events.status, deletedAt: events.deletedAt })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.guildId, guildId)))
    .for("share");
  if (
    event !== undefined &&
    (event.status === "closed" || event.deletedAt !== null)
  ) {
    raise("CF410", "event is closed or deleted");
  }
}

/** Fails as the trigger did unless the guild's time zone is one the server knows. */
export async function requireKnownTimezone(
  tx: BotTx,
  timezone: string,
): Promise<void> {
  const [known] = await tx
    .select({ name: timezoneNames.name })
    .from(timezoneNames)
    .where(eq(timezoneNames.name, timezone))
    .limit(1);
  if (known === undefined) {
    raise("22023", "unknown timezone");
  }
}

/**
 * Updates the rows of a tracked table that match `where`, and returns what `returning`
 * names of each. `set` is Drizzle's, by property name. Nothing matching is an empty list.
 * Raises what the table's triggers raised: 42501 for undoing a deletion or reopening a
 * closed event, CF410 for a change under a closed or deleted event, 22023 for an unknown
 * time zone.
 */
export async function updateRecorded<R extends SelectedFields>(
  tx: BotTx,
  table: TrackedTable,
  set: Record<string, unknown>,
  where: SQL | undefined,
  returning: R,
): Promise<Record<keyof R, unknown>[]> {
  const pgTable = table as PgTable;
  const name = getTableName(pgTable);
  const columns = getTableColumns(pgTable) as Record<string, SQLWrapper>;
  const changes = Object.keys(set);

  const before = await tx
    .select({ row: rowJson(pgTable) })
    .from(pgTable)
    .where(where)
    // As an update locks, and in a fixed order, so writers over the same rows queue.
    .orderBy(
      ...(KEY_COLUMNS[name] ?? []).map((key) => columns[camel(key)] as SQL),
    )
    .for("no key update");
  if (before.length === 0) {
    return [];
  }

  if (name === "tasks") {
    const touched = ["assigneeId", "description", "dueDate", "status"];
    if (changes.some((key) => touched.includes(key))) {
      const seen = new Set<string>();
      for (const { row } of before) {
        const key = `${String(row.event_id)}:${String(row.guild_id)}`;
        if (!seen.has(key)) {
          seen.add(key);
          await requireOpenEvent(
            tx,
            String(row.event_id),
            String(row.guild_id),
          );
        }
      }
    }
  }
  if (
    name === "guild_config" &&
    typeof set.timezone === "string" &&
    before.some(({ row }) => row.timezone !== set.timezone)
  ) {
    await requireKnownTimezone(tx, set.timezone);
  }

  // updated_at moves only if something else does, as the trigger decided.
  const stamped: Record<string, unknown> = { ...set };
  if ("updatedAt" in columns && !changes.includes("updatedAt")) {
    const differs = changes.map(
      (key) => sql`${columns[key]} is distinct from ${set[key]}`,
    );
    stamped.updatedAt = sql`case when ${sql.join(differs, sql` or `)} then now() else ${columns.updatedAt} end`;
  }

  const after = await tx
    .update(pgTable)
    .set(stamped as never)
    .where(where)
    .returning({ ...returning, __row: rowJson(pgTable) } as SelectedFields);

  const history: (typeof rowVersions.$inferInsert)[] = [];
  const oldRows = new Map(
    before.map(({ row }) => [rowIdOf(name, row), row] as const),
  );
  for (const result of after as { __row: JsonRow }[]) {
    const row = result.__row;
    const old = oldRows.get(rowIdOf(name, row));
    if (old === undefined) {
      continue;
    }
    if (
      (name === "tasks" || name === "events") &&
      changes.includes("deletedAt") &&
      old.deleted_at !== null &&
      old.deleted_at !== row.deleted_at
    ) {
      raise("42501", "a deleted row stays deleted");
    }
    if (
      name === "events" &&
      changes.includes("status") &&
      old.status === "closed" &&
      old.status !== row.status
    ) {
      raise("42501", "a closed event stays closed");
    }
    if (!sameRow(old, row)) {
      history.push({
        sourceTable: name,
        operation: "UPDATE",
        rowId: rowIdOf(name, old),
        oldRow: old,
      });
    }
  }
  if (history.length > 0) {
    await tx.insert(rowVersions).values(history).onConflictDoNothing();
  }

  return after.map((result: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(result).filter(([key]) => key !== "__row"),
    ),
  ) as Record<keyof R, unknown>[];
}
