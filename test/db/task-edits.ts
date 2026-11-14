/**
 * One field of a task changed through `editTask`, the bot's only way to change a task's
 * text, date or person, with the other fields as they are now. For tests about one field.
 */

import type { DbClient } from "../../src/db/client.ts";
import { failure, type DbResult } from "../../src/db/errors.ts";
import { editTask, getTask, type TaskEditKey } from "../../src/db/tasks.ts";
import type { TaskRow } from "../../src/db/types.ts";
import type { DateOnly } from "../../src/lib/dates.ts";
import { fakeId } from "./harness.ts";

type Change = Partial<{
  description: string;
  dueDate: DateOnly;
  assigneeId: string;
}>;

async function editOne(
  db: DbClient,
  key: TaskEditKey & { actorId?: string },
  change: Change,
): Promise<DbResult<TaskRow>> {
  const current = await getTask(db, key);
  if (!current.ok) {
    return current;
  }
  if (current.value === null) {
    return failure("not_found");
  }
  return editTask(db, {
    guildId: key.guildId,
    taskId: key.taskId,
    expectedUpdatedAt: key.expectedUpdatedAt,
    actorId: key.actorId ?? fakeId(),
    description: change.description ?? current.value.description,
    dueDate: change.dueDate ?? current.value.due_date,
    assigneeId: change.assigneeId ?? current.value.assignee_id,
  });
}

export function reassignTask(
  db: DbClient,
  key: TaskEditKey & { assigneeId: string; actorId?: string },
): Promise<DbResult<TaskRow>> {
  return editOne(db, key, { assigneeId: key.assigneeId });
}

export function setTaskDescription(
  db: DbClient,
  key: TaskEditKey & { description: string; actorId?: string },
): Promise<DbResult<TaskRow>> {
  return editOne(db, key, { description: key.description });
}

export function setTaskDueDate(
  db: DbClient,
  key: TaskEditKey & { dueDate: DateOnly; actorId?: string },
): Promise<DbResult<TaskRow>> {
  return editOne(db, key, { dueDate: key.dueDate });
}

/** Gives the task to someone new, as this officer, at whatever version it is now. */
export async function reassignAs(
  db: DbClient,
  {
    guildId,
    taskId,
    actorId,
  }: { guildId: string; taskId: string; actorId: string },
): Promise<DbResult<TaskRow>> {
  const current = await getTask(db, { guildId, taskId });
  if (!current.ok) {
    return current;
  }
  if (current.value === null) {
    return failure("not_found");
  }
  return reassignTask(db, {
    guildId,
    taskId,
    actorId,
    expectedUpdatedAt: current.value.updated_at,
    assigneeId: fakeId(),
  });
}
