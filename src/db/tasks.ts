/**
 * Task reads and writes. Each write repeats its checks in the update's filters, so a
 * change made between a permission check and the write stops the write.
 *
 * A task is never undeleted here. The only write to `deleted_at` needs it to be null
 * already, and sets a timestamp, and every other write also needs it null. A task
 * deleted along with its event therefore stays deleted.
 */

import { DISCORD_LIMITS } from "../discord/safe-text.ts";
import type { DateOnly } from "../lib/dates.ts";
import { isSnowflake } from "../lib/snowflake.ts";
import type { DbClient } from "./client.ts";
import {
  callFunction,
  capped,
  changedRow,
  firstRow,
  nullAsNotFound,
  query,
  sql,
} from "./internal.ts";
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
const MAX_CHOICES = DISCORD_LIMITS.autocompleteChoices;

/** The columns of a `TaskRow`. */
const TASK_COLUMNS = sql`id, event_id, guild_id, assignee_id, description, due_date,
  status, completed_at, created_by, deleted_at, updated_at`;

/** Tasks as `t` with their events as `e`, which are in the same guild by the foreign key. */
const TASKS_AND_EVENTS = sql`tasks t join events e
  on e.id = t.event_id and e.guild_id = t.guild_id`;

/** The task is live and its event is live and open. */
const ON_OPEN_EVENT = sql`t.deleted_at is null and e.status = 'active'
  and e.deleted_at is null`;

const TASK_CHOICE = sql`t.id, t.description, t.due_date`;
const LIVE_TASK_CHOICE = sql`t.id, t.description, t.due_date, t.status`;

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
    await query<TaskRow>(
      db,
      sql`insert into tasks
        (event_id, guild_id, assignee_id, description, due_date, created_by)
      values (${eventId}, ${guildId}, ${assigneeId}, ${description}, ${dueDate},
        ${actorId})
      returning ${TASK_COLUMNS}`,
    ),
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
    await query<TaskRow>(
      db,
      sql`select ${TASK_COLUMNS} from tasks
      where id = ${key.taskId} and guild_id = ${key.guildId} and deleted_at is null
      limit 1`,
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
    await query<OpenTask>(
      db,
      sql`select t.id, t.event_id, t.description, t.due_date, e.name as event_name
      from ${TASKS_AND_EVENTS}
      where t.guild_id = ${guildId} and t.assignee_id = ${assigneeId}
        and t.status = 'open' and ${ON_OPEN_EVENT}
      order by t.due_date, t.id limit ${MAX_TASKS + 1}`,
    ),
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
  const list = capped(
    await query(
      db,
      sql`select t.id from ${TASKS_AND_EVENTS}
      where t.guild_id = ${guildId} and t.status = 'open' and t.deleted_at is null
        and e.channel_id = ${channelId} and e.deleted_at is null
      limit ${MAX_TASKS + 1}`,
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
    await query<TaskRow>(
      db,
      sql`select ${TASK_COLUMNS} from tasks
      where guild_id = ${guildId} and event_id = ${eventId} and deleted_at is null
      order by status, due_date, id limit ${MAX_TASKS + 1}`,
    ),
    MAX_TASKS,
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
  return await query<TaskChoice>(
    db,
    sql`select ${TASK_CHOICE} from ${TASKS_AND_EVENTS}
      where t.guild_id = ${guildId} and t.status = 'open'
        and t.description ilike ${searchPattern(term)} and ${ON_OPEN_EVENT}
      order by t.due_date, t.id limit ${MAX_CHOICES}`,
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
  return await query<LiveTaskChoice>(
    db,
    sql`select ${LIVE_TASK_CHOICE} from ${TASKS_AND_EVENTS}
      where t.guild_id = ${guildId}
        and t.description ilike ${searchPattern(term)} and ${ON_OPEN_EVENT}
      order by t.status, t.due_date, t.id limit ${MAX_CHOICES}`,
  );
}

/** The same by the start of a task's ID. */
export async function searchLiveTasksByIdPrefix(
  db: DbClient,
  { guildId, prefix }: { guildId: string; prefix: string },
): Promise<DbResult<LiveTaskChoice[]>> {
  const { low, high } = idPrefixRange(prefix);
  return await query<LiveTaskChoice>(
    db,
    sql`select ${LIVE_TASK_CHOICE} from ${TASKS_AND_EVENTS}
      where t.guild_id = ${guildId} and t.id >= ${low} and t.id <= ${high} and ${ON_OPEN_EVENT}
      order by t.id limit ${MAX_CHOICES}`,
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
  return await query<TaskChoice>(
    db,
    sql`select ${TASK_CHOICE} from ${TASKS_AND_EVENTS}
      where t.guild_id = ${guildId} and t.assignee_id = ${assigneeId}
        and t.status = 'open' and t.description ilike ${searchPattern(term)} and ${ON_OPEN_EVENT}
      order by t.due_date, t.id limit ${MAX_CHOICES}`,
  );
}

/** Autocomplete by the start of a task's ID, across a guild's open tasks on open events. */
export async function searchOpenTasksByIdPrefix(
  db: DbClient,
  { guildId, prefix }: { guildId: string; prefix: string },
): Promise<DbResult<TaskChoice[]>> {
  const { low, high } = idPrefixRange(prefix);
  return await query<TaskChoice>(
    db,
    sql`select ${TASK_CHOICE} from ${TASKS_AND_EVENTS}
      where t.guild_id = ${guildId} and t.status = 'open'
        and t.id >= ${low} and t.id <= ${high} and ${ON_OPEN_EVENT}
      order by t.id limit ${MAX_CHOICES}`,
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
  return await query<TaskChoice>(
    db,
    sql`select ${TASK_CHOICE} from ${TASKS_AND_EVENTS}
      where t.guild_id = ${guildId} and t.assignee_id = ${assigneeId}
        and t.status = 'open' and t.id >= ${low} and t.id <= ${high} and ${ON_OPEN_EVENT}
      order by t.id limit ${MAX_CHOICES}`,
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
  return changedRow(
    await query<TaskRow>(
      db,
      sql`update tasks set status = 'done', completed_at = ${key.now.toISOString()}
      where id = ${key.taskId} and guild_id = ${key.guildId}
        and assignee_id = ${key.assigneeId} and status = 'open' and deleted_at is null
      returning ${TASK_COLUMNS}`,
    ),
  );
}

/** Marks any open task in the guild done. Only for a caller checked as an officer. */
export async function markTaskDoneAsOfficer(
  db: DbClient,
  key: TaskKey & { now: Date },
): Promise<DbResult<TaskRow>> {
  return changedRow(
    await query<TaskRow>(
      db,
      sql`update tasks set status = 'done', completed_at = ${key.now.toISOString()}
      where id = ${key.taskId} and guild_id = ${key.guildId} and status = 'open'
        and deleted_at is null
      returning ${TASK_COLUMNS}`,
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
    await callFunction<TaskRow | null>(
      db,
      sql`select public.edit_task(p_task_id => ${key.taskId},
        p_guild_id => ${key.guildId},
        p_expected_updated_at => ${key.expectedUpdatedAt},
        p_description => ${key.description}, p_due_date => ${key.dueDate},
        p_assignee_id => ${key.assigneeId}, p_actor_id => ${key.actorId}) as value`,
    ),
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
  return changedRow(
    await query<TaskRow>(
      db,
      sql`update tasks set deleted_at = ${key.now.toISOString()}
      where id = ${key.taskId} and guild_id = ${key.guildId}
        and updated_at = ${key.expectedUpdatedAt} and deleted_at is null
      returning ${TASK_COLUMNS}`,
    ),
  );
}

/** Soft-deletes one live task. A task already deleted fails as `not_found`. */
export async function softDeleteTask(
  db: DbClient,
  key: TaskKey & { now: Date },
): Promise<DbResult<TaskRow>> {
  return changedRow(
    await query<TaskRow>(
      db,
      sql`update tasks set deleted_at = ${key.now.toISOString()}
      where id = ${key.taskId} and guild_id = ${key.guildId} and deleted_at is null
      returning ${TASK_COLUMNS}`,
    ),
  );
}
