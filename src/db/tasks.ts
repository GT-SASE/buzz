/**
 * Task reads and writes. Each write repeats its checks in the update's filters, so a
 * change made between a permission check and the write stops the write.
 *
 * A task is never undeleted here. The only write to `deleted_at` needs it to be null
 * already, and sets a timestamp, and every other write also needs it null. A task
 * deleted along with its event therefore stays deleted.
 */

import type { DateOnly } from "../lib/dates.ts";
import { isSnowflake } from "../lib/snowflake.ts";
import type { DbClient } from "./client.ts";
import { rest } from "./internal.ts";
import { refused, type DbResult } from "./errors.ts";
import {
  cappedList,
  exactlyOne,
  noRows,
  oneOrNone,
  rowList,
  type CappedList,
  type RowList,
} from "./result.ts";
import {
  parseLiveTaskChoice,
  parseOpenTask,
  parseTask,
  parseTaskChoice,
  parseTaskId,
  type LiveTaskChoice,
  type OpenTask,
  type TaskChoice,
  type TaskRow,
} from "./types.ts";
import {
  MAX_TASK_DESCRIPTION_LENGTH,
  idPrefixRange,
  isDbDate,
  isIdPrefix,
  isInstant,
  isSearchTerm,
  isStoredText,
  isTimestampText,
  isUuid,
  searchPattern,
} from "./validate.ts";

const MAX_TASKS = 100;
/** Enforced by a trigger on tasks: see the task quotas migration. */
export const MAX_TASKS_PER_EVENT = 100;
/** New tasks and reassignments together. Enforced by triggers: see the same migration. */
export const MAX_TASK_ACTIONS_PER_OFFICER_PER_DAY = 50;
/** Discord's limit for autocomplete choices. */
const MAX_CHOICES = 25;

export interface TaskKey {
  guildId: string;
  taskId: string;
}

function isTaskKey({ guildId, taskId }: TaskKey): boolean {
  return isSnowflake(guildId) && isUuid(taskId);
}

/**
 * An edit names the version it was based on: the `updated_at` the caller read. The
 * database sets that column on every change and the bot's role cannot write it, so
 * if another edit got in first, this one matches no row and fails as `not_found`
 * instead of overwriting it.
 */
export interface TaskEditKey extends TaskKey {
  expectedUpdatedAt: string;
}

function isTaskEditKey(key: TaskEditKey): boolean {
  return isTaskKey(key) && isTimestampText(key.expectedUpdatedAt);
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
    !isSnowflake(guildId) ||
    !isUuid(eventId) ||
    !isSnowflake(assigneeId) ||
    !isSnowflake(actorId) ||
    !isStoredText(description, MAX_TASK_DESCRIPTION_LENGTH) ||
    !isDbDate(dueDate)
  ) {
    return refused();
  }
  return exactlyOne(
    await rest(db)
      .from("tasks")
      .insert({
        event_id: eventId,
        guild_id: guildId,
        assignee_id: assigneeId,
        description,
        due_date: dueDate,
        created_by: actorId,
      })
      .select(
        "id,event_id,guild_id,assignee_id,description,due_date,status,completed_at,created_by,deleted_at,updated_at",
      ),
    parseTask,
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
  return oneOrNone(
    await rest(db)
      .from("tasks")
      .select(
        "id,event_id,guild_id,assignee_id,description,due_date,status,completed_at,created_by,deleted_at,updated_at",
      )
      .eq("id", key.taskId)
      .eq("guild_id", key.guildId)
      .is("deleted_at", null)
      .limit(1),
    parseTask,
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
  if (!isSnowflake(guildId) || !isSnowflake(assigneeId)) {
    return refused();
  }
  return cappedList(
    await rest(db)
      .from("tasks")
      .select("id,event_id,description,due_date,events!inner(name)")
      .eq("guild_id", guildId)
      .eq("assignee_id", assigneeId)
      .eq("status", "open")
      .is("deleted_at", null)
      .eq("events.status", "active")
      .is("events.deleted_at", null)
      .order("due_date")
      .order("id")
      .limit(MAX_TASKS + 1),
    parseOpenTask,
    MAX_TASKS,
  );
}

export interface OpenTaskCount {
  readonly count: number;
  /** True if there are more than `count`: the rows are capped, not all counted. */
  readonly truncated: boolean;
}

/** The open tasks of a forum's live events, for the warning before it is removed. */
export async function countOpenTasksInChannel(
  db: DbClient,
  { guildId, channelId }: { guildId: string; channelId: string },
): Promise<DbResult<OpenTaskCount>> {
  if (!isSnowflake(guildId) || !isSnowflake(channelId)) {
    return refused();
  }
  const list = cappedList(
    await rest(db)
      .from("tasks")
      .select("id,events!inner(channel_id)")
      .eq("guild_id", guildId)
      .eq("status", "open")
      .is("deleted_at", null)
      .eq("events.channel_id", channelId)
      .is("events.deleted_at", null)
      .limit(MAX_TASKS + 1),
    parseTaskId,
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
  if (!isSnowflake(guildId) || !isUuid(eventId)) {
    return refused();
  }
  return cappedList(
    await rest(db)
      .from("tasks")
      .select(
        "id,event_id,guild_id,assignee_id,description,due_date,status,completed_at,created_by,deleted_at,updated_at",
      )
      .eq("guild_id", guildId)
      .eq("event_id", eventId)
      .is("deleted_at", null)
      .order("status")
      .order("due_date")
      .order("id")
      .limit(MAX_TASKS + 1),
    parseTask,
    MAX_TASKS,
  );
}

/** Autocomplete across a guild's open tasks on open events, for officers. */
export async function searchOpenTasks(
  db: DbClient,
  { guildId, term }: { guildId: string; term: string },
): Promise<DbResult<RowList<TaskChoice>>> {
  if (!isSnowflake(guildId) || !isSearchTerm(term)) {
    return refused();
  }
  return rowList(
    await rest(db)
      .from("tasks")
      .select("id,description,due_date,events!inner(id)")
      .eq("guild_id", guildId)
      .eq("status", "open")
      .is("deleted_at", null)
      .eq("events.status", "active")
      .is("events.deleted_at", null)
      .ilike("description", searchPattern(term))
      .order("due_date")
      .order("id")
      .limit(MAX_CHOICES),
    parseTaskChoice,
  );
}

/**
 * Autocomplete for /task delete: done tasks count towards an event's limit, so they can
 * be picked as well. Open ones come first, as the likelier choice.
 */
export async function searchLiveTasks(
  db: DbClient,
  { guildId, term }: { guildId: string; term: string },
): Promise<DbResult<RowList<LiveTaskChoice>>> {
  if (!isSnowflake(guildId) || !isSearchTerm(term)) {
    return refused();
  }
  return rowList(
    await rest(db)
      .from("tasks")
      .select("id,description,due_date,status,events!inner(id)")
      .eq("guild_id", guildId)
      .is("deleted_at", null)
      .eq("events.status", "active")
      .is("events.deleted_at", null)
      .ilike("description", searchPattern(term))
      .order("status")
      .order("due_date")
      .order("id")
      .limit(MAX_CHOICES),
    parseLiveTaskChoice,
  );
}

/** The same by the start of a task's ID. */
export async function searchLiveTasksByIdPrefix(
  db: DbClient,
  { guildId, prefix }: { guildId: string; prefix: string },
): Promise<DbResult<RowList<LiveTaskChoice>>> {
  if (!isSnowflake(guildId) || !isIdPrefix(prefix)) {
    return refused();
  }
  const { low, high } = idPrefixRange(prefix);
  return rowList(
    await rest(db)
      .from("tasks")
      .select("id,description,due_date,status,events!inner(id)")
      .eq("guild_id", guildId)
      .is("deleted_at", null)
      .eq("events.status", "active")
      .is("events.deleted_at", null)
      .gte("id", low)
      .lte("id", high)
      .order("id")
      .limit(MAX_CHOICES),
    parseLiveTaskChoice,
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
): Promise<DbResult<RowList<TaskChoice>>> {
  if (
    !isSnowflake(guildId) ||
    !isSnowflake(assigneeId) ||
    !isSearchTerm(term)
  ) {
    return refused();
  }
  return rowList(
    await rest(db)
      .from("tasks")
      .select("id,description,due_date,events!inner(id)")
      .eq("guild_id", guildId)
      .eq("assignee_id", assigneeId)
      .eq("status", "open")
      .is("deleted_at", null)
      .eq("events.status", "active")
      .is("events.deleted_at", null)
      .ilike("description", searchPattern(term))
      .order("due_date")
      .order("id")
      .limit(MAX_CHOICES),
    parseTaskChoice,
  );
}

/** Autocomplete by the start of a task's ID, across a guild's open tasks on open events. */
export async function searchOpenTasksByIdPrefix(
  db: DbClient,
  { guildId, prefix }: { guildId: string; prefix: string },
): Promise<DbResult<RowList<TaskChoice>>> {
  if (!isSnowflake(guildId) || !isIdPrefix(prefix)) {
    return refused();
  }
  const { low, high } = idPrefixRange(prefix);
  return rowList(
    await rest(db)
      .from("tasks")
      .select("id,description,due_date,events!inner(id)")
      .eq("guild_id", guildId)
      .eq("status", "open")
      .is("deleted_at", null)
      .eq("events.status", "active")
      .is("events.deleted_at", null)
      .gte("id", low)
      .lte("id", high)
      .order("id")
      .limit(MAX_CHOICES),
    parseTaskChoice,
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
): Promise<DbResult<RowList<TaskChoice>>> {
  if (
    !isSnowflake(guildId) ||
    !isSnowflake(assigneeId) ||
    !isIdPrefix(prefix)
  ) {
    return refused();
  }
  const { low, high } = idPrefixRange(prefix);
  return rowList(
    await rest(db)
      .from("tasks")
      .select("id,description,due_date,events!inner(id)")
      .eq("guild_id", guildId)
      .eq("assignee_id", assigneeId)
      .eq("status", "open")
      .is("deleted_at", null)
      .eq("events.status", "active")
      .is("events.deleted_at", null)
      .gte("id", low)
      .lte("id", high)
      .order("id")
      .limit(MAX_CHOICES),
    parseTaskChoice,
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
  if (!isTaskKey(key) || !isSnowflake(key.assigneeId) || !isInstant(key.now)) {
    return refused();
  }
  return exactlyOne(
    await rest(db)
      .from("tasks")
      .update({ status: "done", completed_at: key.now.toISOString() })
      .eq("id", key.taskId)
      .eq("guild_id", key.guildId)
      .eq("assignee_id", key.assigneeId)
      .eq("status", "open")
      .is("deleted_at", null)
      .select(
        "id,event_id,guild_id,assignee_id,description,due_date,status,completed_at,created_by,deleted_at,updated_at",
      ),
    parseTask,
  );
}

/** Marks any open task in the guild done. Only for a caller checked as an officer. */
export async function markTaskDoneAsOfficer(
  db: DbClient,
  key: TaskKey & { now: Date },
): Promise<DbResult<TaskRow>> {
  if (!isTaskKey(key) || !isInstant(key.now)) {
    return refused();
  }
  return exactlyOne(
    await rest(db)
      .from("tasks")
      .update({ status: "done", completed_at: key.now.toISOString() })
      .eq("id", key.taskId)
      .eq("guild_id", key.guildId)
      .eq("status", "open")
      .is("deleted_at", null)
      .select(
        "id,event_id,guild_id,assignee_id,description,due_date,status,completed_at,created_by,deleted_at,updated_at",
      ),
    parseTask,
  );
}

export async function reassignTask(
  db: DbClient,
  key: TaskEditKey & { assigneeId: string },
): Promise<DbResult<TaskRow>> {
  if (!isTaskEditKey(key) || !isSnowflake(key.assigneeId)) {
    return refused();
  }
  return exactlyOne(
    await rest(db)
      .from("tasks")
      .update({ assignee_id: key.assigneeId })
      .eq("id", key.taskId)
      .eq("guild_id", key.guildId)
      .eq("updated_at", key.expectedUpdatedAt)
      .eq("status", "open")
      .is("deleted_at", null)
      .select(
        "id,event_id,guild_id,assignee_id,description,due_date,status,completed_at,created_by,deleted_at,updated_at",
      ),
    parseTask,
  );
}

export async function setTaskDescription(
  db: DbClient,
  key: TaskEditKey & { description: string },
): Promise<DbResult<TaskRow>> {
  if (
    !isTaskEditKey(key) ||
    !isStoredText(key.description, MAX_TASK_DESCRIPTION_LENGTH)
  ) {
    return refused();
  }
  return exactlyOne(
    await rest(db)
      .from("tasks")
      .update({ description: key.description })
      .eq("id", key.taskId)
      .eq("guild_id", key.guildId)
      .eq("updated_at", key.expectedUpdatedAt)
      .eq("status", "open")
      .is("deleted_at", null)
      .select(
        "id,event_id,guild_id,assignee_id,description,due_date,status,completed_at,created_by,deleted_at,updated_at",
      ),
    parseTask,
  );
}

/**
 * Sets all three editable fields in one write, so an edit of several either lands
 * whole or not at all. The caller passes the values it read for any left unchanged,
 * which is safe because the write only matches that version of the row.
 */
export async function editTask(
  db: DbClient,
  key: TaskEditKey & {
    description: string;
    dueDate: DateOnly;
    assigneeId: string;
  },
): Promise<DbResult<TaskRow>> {
  if (
    !isTaskEditKey(key) ||
    !isStoredText(key.description, MAX_TASK_DESCRIPTION_LENGTH) ||
    !isDbDate(key.dueDate) ||
    !isSnowflake(key.assigneeId)
  ) {
    return refused();
  }
  return exactlyOne(
    await rest(db)
      .from("tasks")
      .update({
        description: key.description,
        due_date: key.dueDate,
        assignee_id: key.assigneeId,
      })
      .eq("id", key.taskId)
      .eq("guild_id", key.guildId)
      .eq("updated_at", key.expectedUpdatedAt)
      .eq("status", "open")
      .is("deleted_at", null)
      .select(
        "id,event_id,guild_id,assignee_id,description,due_date,status,completed_at,created_by,deleted_at,updated_at",
      ),
    parseTask,
  );
}

/** Moving a due date re-arms the task's reminders, because the log is keyed by date. */
export async function setTaskDueDate(
  db: DbClient,
  key: TaskEditKey & { dueDate: DateOnly },
): Promise<DbResult<TaskRow>> {
  if (!isTaskEditKey(key) || !isDbDate(key.dueDate)) {
    return refused();
  }
  return exactlyOne(
    await rest(db)
      .from("tasks")
      .update({ due_date: key.dueDate })
      .eq("id", key.taskId)
      .eq("guild_id", key.guildId)
      .eq("updated_at", key.expectedUpdatedAt)
      .eq("status", "open")
      .is("deleted_at", null)
      .select(
        "id,event_id,guild_id,assignee_id,description,due_date,status,completed_at,created_by,deleted_at,updated_at",
      ),
    parseTask,
  );
}

/**
 * Counts a reassignment against the officer's limit, before the task changes. Fails as
 * `actor_task_limit` once the officer has used it up.
 */
export async function recordReassignment(
  db: DbClient,
  {
    guildId,
    actorId,
    taskId,
  }: { guildId: string; actorId: string; taskId: string },
): Promise<DbResult<null>> {
  if (!isSnowflake(guildId) || !isSnowflake(actorId) || !isUuid(taskId)) {
    return refused();
  }
  return noRows(
    await rest(db)
      .from("task_reassignments")
      .insert({ guild_id: guildId, actor_id: actorId, task_id: taskId }),
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
  if (!isTaskEditKey(key) || !isInstant(key.now)) {
    return refused();
  }
  return exactlyOne(
    await rest(db)
      .from("tasks")
      .update({ deleted_at: key.now.toISOString() })
      .eq("id", key.taskId)
      .eq("guild_id", key.guildId)
      .eq("updated_at", key.expectedUpdatedAt)
      .is("deleted_at", null)
      .select(
        "id,event_id,guild_id,assignee_id,description,due_date,status,completed_at,created_by,deleted_at,updated_at",
      ),
    parseTask,
  );
}

/** Soft-deletes one live task. A task already deleted fails as `not_found`. */
export async function softDeleteTask(
  db: DbClient,
  key: TaskKey & { now: Date },
): Promise<DbResult<TaskRow>> {
  if (!isTaskKey(key) || !isInstant(key.now)) {
    return refused();
  }
  return exactlyOne(
    await rest(db)
      .from("tasks")
      .update({ deleted_at: key.now.toISOString() })
      .eq("id", key.taskId)
      .eq("guild_id", key.guildId)
      .is("deleted_at", null)
      .select(
        "id,event_id,guild_id,assignee_id,description,due_date,status,completed_at,created_by,deleted_at,updated_at",
      ),
    parseTask,
  );
}
