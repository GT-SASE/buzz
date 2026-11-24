/**
 * Task reads and writes. Each write repeats its checks in the update's filters, so a
 * change made between a permission check and the write stops the write.
 *
 * A task is never undeleted here. The only write to `deleted_at` needs it to be null
 * already, and sets a timestamp, and every other write also needs it null. A task
 * deleted along with its event therefore stays deleted.
 */

import { and, asc, eq, gte, ilike, isNull, lte, type SQL } from "drizzle-orm";
import { DISCORD_LIMITS } from "../discord/safe-text.ts";
import type { DateOnly } from "../lib/dates.ts";
import { isSnowflake } from "../lib/snowflake.ts";
import type { DbClient } from "./client.ts";
import { updateRecorded } from "./history.ts";
import {
  capped,
  changedRow,
  firstRow,
  nullAsNotFound,
  read,
  transact,
} from "./internal.ts";
import { admitReassignment, admitTask } from "./rules.ts";
import { events, taskReassignments, tasks } from "./schema.ts";
import { refused, type DbResult } from "./errors.ts";
import type {
  CappedList,
  LiveTaskChoice,
  OpenTask,
  TaskChoice,
  TaskRow,
} from "./types.ts";
import {
  MAX_TASK_DESCRIPTION_LENGTH,
  idPrefixRange,
  isDbDate,
  isSearchTerm,
  isStoredText,
  isUuid,
  searchPattern,
} from "./validate.ts";

const MAX_TASKS = 100;

/** The columns of a `TaskRow`. */
const TASK_ROW = {
  id: tasks.id,
  event_id: tasks.eventId,
  guild_id: tasks.guildId,
  assignee_id: tasks.assigneeId,
  description: tasks.description,
  due_date: tasks.dueDate,
  status: tasks.status,
  completed_at: tasks.completedAt,
  created_by: tasks.createdBy,
  deleted_at: tasks.deletedAt,
  updated_at: tasks.updatedAt,
};

const TASK_CHOICE = {
  id: tasks.id,
  description: tasks.description,
  due_date: tasks.dueDate,
};
const LIVE_TASK_CHOICE = { ...TASK_CHOICE, status: tasks.status };

/** The task is live and its event is live and open. */
const onOpenEvent = (): SQL | undefined =>
  and(
    isNull(tasks.deletedAt),
    eq(events.status, "active"),
    isNull(events.deletedAt),
  );

/** Tasks with their events, which are in the same guild by the foreign key. */
const taskEvent = and(
  eq(events.id, tasks.eventId),
  eq(events.guildId, tasks.guildId),
);

export interface TaskKey {
  guildId: string;
  taskId: string;
}

function isTaskKey({ guildId, taskId }: TaskKey): boolean {
  return isSnowflake(guildId) && isUuid(taskId);
}

/**
 * An edit names the version it was based on: the `updated_at` the caller read. The
 * database sets that column on every change, so if another edit got in first, this one
 * matches no row and fails as `not_found` instead of overwriting it.
 */
export interface TaskEditKey extends TaskKey {
  expectedUpdatedAt: string;
}

export interface NewTask {
  guildId: string;
  eventId: string;
  assigneeId: string;
  actorId: string;
  description: string;
  dueDate: DateOnly;
}

/**
 * Fails as `parent_unavailable` if the event is closed or deleted, as
 * `event_task_limit` if the event is full, and as `actor_task_limit` if this officer
 * has reached the daily limit. Any later change to the task but a soft delete also fails
 * as `parent_unavailable` once its event is closed.
 */
export async function createTask(
  db: DbClient,
  { guildId, eventId, assigneeId, actorId, description, dueDate }: NewTask,
): Promise<DbResult<TaskRow>> {
  if (
    !isStoredText(description, MAX_TASK_DESCRIPTION_LENGTH) ||
    !isDbDate(dueDate)
  ) {
    return refused();
  }
  return changedRow(
    await transact(db, async (tx) => {
      await admitTask(tx, { eventId, guildId, actorId });
      return (await tx
        .insert(tasks)
        .values({
          eventId,
          guildId,
          assigneeId,
          description,
          dueDate,
          createdBy: actorId,
        })
        .returning(TASK_ROW)) as TaskRow[];
    }),
  );
}

/** A live task in this guild. An ID from another guild looks like an unknown ID. */
export async function getTask(
  db: DbClient,
  key: TaskKey,
): Promise<DbResult<TaskRow | null>> {
  if (!isTaskKey(key)) {
    return refused();
  }
  return firstRow(
    await read(
      db,
      (orm) =>
        orm
          .select(TASK_ROW)
          .from(tasks)
          .where(
            and(
              eq(tasks.id, key.taskId),
              eq(tasks.guildId, key.guildId),
              isNull(tasks.deletedAt),
            ),
          )
          .limit(1) as unknown as Promise<TaskRow[]>,
    ),
  );
}

/**
 * One member's open tasks in one guild, soonest first, with each event's name. A task
 * on a closed or deleted event is finished with, so it is left out.
 */
export async function listOpenTasksForAssignee(
  db: DbClient,
  { guildId, assigneeId }: { guildId: string; assigneeId: string },
): Promise<DbResult<CappedList<OpenTask>>> {
  return capped(
    await read(
      db,
      (orm) =>
        orm
          .select({
            id: tasks.id,
            event_id: tasks.eventId,
            description: tasks.description,
            due_date: tasks.dueDate,
            event_name: events.name,
          })
          .from(tasks)
          .innerJoin(events, taskEvent)
          .where(
            and(
              eq(tasks.guildId, guildId),
              eq(tasks.assigneeId, assigneeId),
              eq(tasks.status, "open"),
              onOpenEvent(),
            ),
          )
          .orderBy(asc(tasks.dueDate), asc(tasks.id))
          .limit(MAX_TASKS + 1) as unknown as Promise<OpenTask[]>,
    ),
    MAX_TASKS,
  );
}

export interface OpenTaskCount {
  readonly count: number;
  /** True if there are more than `count`: the rows are capped, not all counted. */
  readonly truncated: boolean;
}

/** The open tasks of a forum's active events, for the warning before it is removed. */
export async function countOpenTasksInChannel(
  db: DbClient,
  { guildId, channelId }: { guildId: string; channelId: string },
): Promise<DbResult<OpenTaskCount>> {
  const list = capped(
    await read(db, (orm) =>
      orm
        .select({ id: tasks.id })
        .from(tasks)
        .innerJoin(events, taskEvent)
        .where(
          and(
            eq(tasks.guildId, guildId),
            eq(tasks.status, "open"),
            isNull(tasks.deletedAt),
            eq(events.channelId, channelId),
            isNull(events.deletedAt),
            eq(events.status, "active"),
          ),
        )
        .limit(MAX_TASKS + 1),
    ),
    MAX_TASKS,
  );
  return list.ok
    ? {
        ok: true,
        value: {
          count: list.value.rows.length,
          truncated: list.value.truncated,
        },
      }
    : list;
}

/**
 * Every live task on one event, open ones first, then the soonest. The list is capped,
 * so this decides what is left out: never an open task in favour of finished ones.
 */
export async function listEventTasks(
  db: DbClient,
  { guildId, eventId }: { guildId: string; eventId: string },
): Promise<DbResult<CappedList<TaskRow>>> {
  return capped(
    await read(
      db,
      (orm) =>
        orm
          .select(TASK_ROW)
          .from(tasks)
          .where(
            and(
              eq(tasks.guildId, guildId),
              eq(tasks.eventId, eventId),
              isNull(tasks.deletedAt),
            ),
          )
          .orderBy(asc(tasks.status), asc(tasks.dueDate), asc(tasks.id))
          .limit(MAX_TASKS + 1) as unknown as Promise<TaskRow[]>,
    ),
    MAX_TASKS,
  );
}

/** A choice list over tasks on open events, narrowed by `also` and put in `order`. */
function choices<T>(
  db: DbClient,
  columns: typeof TASK_CHOICE | typeof LIVE_TASK_CHOICE,
  also: (SQL | undefined)[],
  order: SQL[],
): Promise<DbResult<T[]>> {
  return read(
    db,
    (orm) =>
      orm
        .select(columns)
        .from(tasks)
        .innerJoin(events, taskEvent)
        .where(and(...also, onOpenEvent()))
        .orderBy(...order)
        .limit(DISCORD_LIMITS.autocompleteChoices) as unknown as Promise<T[]>,
  );
}

/** Autocomplete across a guild's open tasks on open events, for officers. */
export async function searchOpenTasks(
  db: DbClient,
  { guildId, term }: { guildId: string; term: string },
): Promise<DbResult<TaskChoice[]>> {
  if (!isSearchTerm(term)) {
    return refused();
  }
  return choices<TaskChoice>(
    db,
    TASK_CHOICE,
    [
      eq(tasks.guildId, guildId),
      eq(tasks.status, "open"),
      ilike(tasks.description, searchPattern(term)),
    ],
    [asc(tasks.dueDate), asc(tasks.id)],
  );
}

/**
 * Autocomplete for /task delete: done tasks count towards an event's limit, so they can
 * be picked as well. Open ones come first, as the likelier choice.
 */
export async function searchLiveTasks(
  db: DbClient,
  { guildId, term }: { guildId: string; term: string },
): Promise<DbResult<LiveTaskChoice[]>> {
  if (!isSearchTerm(term)) {
    return refused();
  }
  return choices<LiveTaskChoice>(
    db,
    LIVE_TASK_CHOICE,
    [eq(tasks.guildId, guildId), ilike(tasks.description, searchPattern(term))],
    [asc(tasks.status), asc(tasks.dueDate), asc(tasks.id)],
  );
}

/** The same by the start of a task's ID. */
export async function searchLiveTasksByIdPrefix(
  db: DbClient,
  { guildId, prefix }: { guildId: string; prefix: string },
): Promise<DbResult<LiveTaskChoice[]>> {
  const { low, high } = idPrefixRange(prefix);
  return choices<LiveTaskChoice>(
    db,
    LIVE_TASK_CHOICE,
    [eq(tasks.guildId, guildId), gte(tasks.id, low), lte(tasks.id, high)],
    [asc(tasks.id)],
  );
}

/** Autocomplete across one member's own open tasks on open events. */
export async function searchOwnOpenTasks(
  db: DbClient,
  {
    guildId,
    assigneeId,
    term,
  }: { guildId: string; assigneeId: string; term: string },
): Promise<DbResult<TaskChoice[]>> {
  if (!isSearchTerm(term)) {
    return refused();
  }
  return choices<TaskChoice>(
    db,
    TASK_CHOICE,
    [
      eq(tasks.guildId, guildId),
      eq(tasks.assigneeId, assigneeId),
      eq(tasks.status, "open"),
      ilike(tasks.description, searchPattern(term)),
    ],
    [asc(tasks.dueDate), asc(tasks.id)],
  );
}

/** Autocomplete by the start of a task's ID, across a guild's open tasks on open events. */
export async function searchOpenTasksByIdPrefix(
  db: DbClient,
  { guildId, prefix }: { guildId: string; prefix: string },
): Promise<DbResult<TaskChoice[]>> {
  const { low, high } = idPrefixRange(prefix);
  return choices<TaskChoice>(
    db,
    TASK_CHOICE,
    [
      eq(tasks.guildId, guildId),
      eq(tasks.status, "open"),
      gte(tasks.id, low),
      lte(tasks.id, high),
    ],
    [asc(tasks.id)],
  );
}

/** Autocomplete by the start of a task's ID, across one member's own open tasks. */
export async function searchOwnOpenTasksByIdPrefix(
  db: DbClient,
  {
    guildId,
    assigneeId,
    prefix,
  }: { guildId: string; assigneeId: string; prefix: string },
): Promise<DbResult<TaskChoice[]>> {
  const { low, high } = idPrefixRange(prefix);
  return choices<TaskChoice>(
    db,
    TASK_CHOICE,
    [
      eq(tasks.guildId, guildId),
      eq(tasks.assigneeId, assigneeId),
      eq(tasks.status, "open"),
      gte(tasks.id, low),
      lte(tasks.id, high),
    ],
    [asc(tasks.id)],
  );
}

/** Changes the one task `where` names, and returns it. */
async function changeTask(
  db: DbClient,
  set: Record<string, unknown>,
  where: SQL | undefined,
): Promise<DbResult<TaskRow>> {
  return changedRow(
    await transact(
      db,
      async (tx) =>
        (await updateRecorded(
          tx,
          tasks,
          set,
          where,
          TASK_ROW,
        )) as unknown as TaskRow[],
    ),
  );
}

/**
 * Marks a member's own task done. Fails as `not_found` if the task was reassigned,
 * finished or deleted after the caller last read it.
 */
export async function markOwnTaskDone(
  db: DbClient,
  key: TaskKey & { assigneeId: string; now: Date },
): Promise<DbResult<TaskRow>> {
  return changeTask(
    db,
    { status: "done", completedAt: key.now.toISOString() },
    and(
      eq(tasks.id, key.taskId),
      eq(tasks.guildId, key.guildId),
      eq(tasks.assigneeId, key.assigneeId),
      eq(tasks.status, "open"),
      isNull(tasks.deletedAt),
    ),
  );
}

/** Marks any open task in the guild done. Only for a caller checked as an officer. */
export async function markTaskDoneAsOfficer(
  db: DbClient,
  key: TaskKey & { now: Date },
): Promise<DbResult<TaskRow>> {
  return changeTask(
    db,
    { status: "done", completedAt: key.now.toISOString() },
    and(
      eq(tasks.id, key.taskId),
      eq(tasks.guildId, key.guildId),
      eq(tasks.status, "open"),
      isNull(tasks.deletedAt),
    ),
  );
}

/**
 * Reopens a done task, for an officer's undo. Its reminders follow the due date again,
 * as for any open task. Fails as `not_found` if it is open or deleted, and as
 * `parent_unavailable` on a closed event.
 */
export async function reopenTask(
  db: DbClient,
  key: TaskKey,
): Promise<DbResult<TaskRow>> {
  return changeTask(
    db,
    { status: "open", completedAt: null },
    and(
      eq(tasks.id, key.taskId),
      eq(tasks.guildId, key.guildId),
      eq(tasks.status, "done"),
      isNull(tasks.deletedAt),
    ),
  );
}

/**
 * Sets all three editable fields in one write, so an edit of several either lands
 * whole or not at all. The caller passes the values it read for any left unchanged,
 * which is safe because the write only matches that version of the row. A new person
 * counts against the officer's daily limit in the same write: at the limit, nothing
 * changes and the edit fails as `actor_task_limit`.
 */
export async function editTask(
  db: DbClient,
  key: TaskEditKey & {
    description: string;
    dueDate: DateOnly;
    assigneeId: string;
    actorId: string;
  },
): Promise<DbResult<TaskRow>> {
  if (
    !isStoredText(key.description, MAX_TASK_DESCRIPTION_LENGTH) ||
    !isDbDate(key.dueDate)
  ) {
    return refused();
  }
  // Null when the task is not at the version read, or no longer open and live.
  return nullAsNotFound(
    await transact(db, async (tx): Promise<TaskRow | null> => {
      const [current] = await tx
        .select({ assigneeId: tasks.assigneeId })
        .from(tasks)
        .where(
          and(
            eq(tasks.id, key.taskId),
            eq(tasks.guildId, key.guildId),
            eq(tasks.updatedAt, key.expectedUpdatedAt),
            eq(tasks.status, "open"),
            isNull(tasks.deletedAt),
          ),
        )
        .for("update");
      if (current === undefined) {
        return null;
      }

      // The officer is locked and counted first, and the change refused at the limit,
      // which fails the whole edit.
      if (current.assigneeId !== key.assigneeId) {
        await admitReassignment(tx, {
          guildId: key.guildId,
          actorId: key.actorId,
        });
        await tx.insert(taskReassignments).values({
          guildId: key.guildId,
          actorId: key.actorId,
          taskId: key.taskId,
        });
      }

      const [edited] = (await updateRecorded(
        tx,
        tasks,
        {
          description: key.description,
          dueDate: key.dueDate,
          assigneeId: key.assigneeId,
        },
        eq(tasks.id, key.taskId),
        TASK_ROW,
      )) as unknown as TaskRow[];
      return edited ?? null;
    }),
  );
}

/**
 * Soft-deletes one live task, only if it is still the version the caller read. An
 * earlier edit, or a delete already done, fails as `not_found`.
 */
export async function softDeleteTaskIfUnchanged(
  db: DbClient,
  key: TaskEditKey & { now: Date },
): Promise<DbResult<TaskRow>> {
  return changeTask(
    db,
    { deletedAt: key.now.toISOString() },
    and(
      eq(tasks.id, key.taskId),
      eq(tasks.guildId, key.guildId),
      eq(tasks.updatedAt, key.expectedUpdatedAt),
      isNull(tasks.deletedAt),
    ),
  );
}

/** Soft-deletes one live task. A task already deleted fails as `not_found`. */
export async function softDeleteTask(
  db: DbClient,
  key: TaskKey & { now: Date },
): Promise<DbResult<TaskRow>> {
  return changeTask(
    db,
    { deletedAt: key.now.toISOString() },
    and(
      eq(tasks.id, key.taskId),
      eq(tasks.guildId, key.guildId),
      isNull(tasks.deletedAt),
    ),
  );
}
