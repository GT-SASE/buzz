/**
 * What the /task subcommands share: reading their options and rendering a task. Every
 * value read here came from a signed payload but is still hostile text or an unchecked
 * ID, so nothing leaves without a check or an escape.
 */

import { createHash } from "node:crypto";
import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { commandOptionValue } from "../discord/interactions.ts";
import type { AutocompleteChoice, MessageInput } from "../discord/outbound.ts";
import {
  DISCORD_LIMITS,
  escapeUserText,
  plainLabel,
  safe,
  SafeTextError,
} from "../discord/safe-text.ts";
import type { PlainText, SafeText } from "../discord/safe-text.ts";
import { getEvent } from "../db/events.ts";
import type { DbResult } from "../db/errors.ts";
import { searchOpenEventsByIdPrefix } from "../db/task-events.ts";
import {
  getTask,
  searchLiveTasksByIdPrefix,
  searchOpenTasksByIdPrefix,
  searchOwnOpenTasksByIdPrefix,
} from "../db/tasks.ts";
import { isIdPrefix, isUuid } from "../db/validate.ts";
import type { EventRow, TaskRow, TaskStatus } from "../db/types.ts";
import type { DateOnly } from "../lib/dates.ts";
import { escapedName, lines } from "../handlers/render.ts";
import { valueOf, type FinishContext } from "../handlers/router.ts";
import { authorize, isOfficer } from "../lib/permissions.ts";
import type { TaskScopedAction } from "../lib/permissions.ts";

/** A task's text in a reply or a post: the rest of the message must still fit. */
const DESCRIPTION_SHOWN = 1500;
const SHORT_ID_LENGTH = 8;
/** A picker shows the ID and date first, then as much of the text as fits. */
const PICKER_TEXT_LENGTH = 70;

/** The router's fixed refusal, for one decided after the reply has gone. */
export const REFUSED_TEXT = safe`You can't do that, or it doesn't exist.`;

/** For text that names no row. It matched nothing by ID, so it reveals nothing. */
export const PICK_FROM_LIST = safe`Pick a choice from the list, or enter the whole short ID the bot shows.`;

export const EVENT_CLOSED = safe`This task's event is closed or deleted, so the task can't be changed.`;

/** Redraws an event's overview message after a task changes. Says if it is now right. */
export type RefreshOverview = (
  event: EventRow,
  ctx: FinishContext,
) => Promise<boolean>;

export interface TaskDependencies {
  readonly refreshOverview: RefreshOverview;
}

const POST_NOT_UPDATED = safe`The change is saved, but I couldn't update the task list in the event's post, so it's out of date. If AutoMod may have refused a task's wording, that task needs editing. Otherwise the next change tries again.`;

/**
 * A task's change is already saved, so a failed redraw must not undo its reply. It adds
 * a line instead, unless the event has no post to be out of date.
 */
export async function refreshAfterChange(
  { refreshOverview }: TaskDependencies,
  event: EventRow,
  ctx: FinishContext,
): Promise<SafeText | undefined> {
  let current = false;
  try {
    current = await refreshOverview(event, ctx);
  } catch (error) {
    console.error(
      `Overview refresh failed: ${error instanceof Error ? error.name : "unknown error"}`,
    );
  }
  return current || event.thread_status !== "active"
    ? undefined
    : POST_NOT_UPDATED;
}

export function message(content: SafeText): MessageInput {
  return { content, mentionUserIds: [] };
}

/** A reply with any extra lines the officer needs, one to a line. */
export function messageWithNotes(
  reply: SafeText,
  ...notes: readonly (SafeText | undefined)[]
): MessageInput {
  const present = notes.filter((note) => note !== undefined);
  return message(lines([reply, ...present]) ?? reply);
}

export function stringOption(
  payload: unknown,
  name: string,
): string | undefined {
  const value = commandOptionValue(
    payload,
    name,
    ApplicationCommandOptionType.String,
  );
  return typeof value === "string" ? value : undefined;
}

/** Short, because it travels in a custom_id, and only ever compared with a fresh one. */
const FINGERPRINT_LENGTH = 16;

/** Names one version of a row, for a button that must act on the version it showed. */
export function versionFingerprint(updatedAt: string): string {
  return createHash("sha256")
    .update(updatedAt)
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}

/** The bot's whole short ID, as someone might copy it. A shorter start is not enough. */
function typedShortId(raw: string): string | undefined {
  const id = raw.trim().toLowerCase();
  return id.length === SHORT_ID_LENGTH && isIdPrefix(id) ? id : undefined;
}

function onlyId<T extends { readonly id: string }>(
  found: DbResult<T[]>,
): string | undefined {
  const rows = valueOf(found);
  const [only] = rows;
  return rows.length === 1 ? only?.id : undefined;
}

/**
 * The task an option names. Discord can submit what was typed rather than a choice, so
 * a whole short ID counts if it finds one row among those this actor could pick. Anything
 * else with no ID in it gives undefined, for `PICK_FROM_LIST`. The result is only a name
 * for a row: `authorizedTask` still decides.
 */
export async function chosenTaskId(
  ctx: FinishContext,
  raw: string | undefined,
  { orDone = false }: { readonly orDone?: boolean } = {},
): Promise<string | undefined> {
  if (raw === undefined || isUuid(raw)) {
    return raw;
  }
  const prefix = typedShortId(raw);
  if (prefix === undefined) {
    return undefined;
  }
  const { guildId, userId } = ctx.actor;
  if (!isOfficer(ctx.actor, ctx.config)) {
    return onlyId(
      await searchOwnOpenTasksByIdPrefix(ctx.db, {
        guildId,
        assigneeId: userId,
        prefix,
      }),
    );
  }
  return orDone
    ? onlyId(await searchLiveTasksByIdPrefix(ctx.db, { guildId, prefix }))
    : onlyId(await searchOpenTasksByIdPrefix(ctx.db, { guildId, prefix }));
}

/** The same for an event, among those that can take tasks. */
export async function chosenEventId(
  ctx: FinishContext,
  raw: string,
): Promise<string | undefined> {
  if (isUuid(raw)) {
    return raw;
  }
  const prefix = typedShortId(raw);
  return prefix === undefined
    ? undefined
    : onlyId(
        await searchOpenEventsByIdPrefix(ctx.db, {
          guildId: ctx.actor.guildId,
          prefix,
        }),
      );
}

/**
 * The live task a value names, if this actor may do this to it. The value is read again
 * whoever offered it. Absent, deleted, another guild's, malformed and forbidden all
 * give null, and the caller shows `REFUSED_TEXT` for every one of them.
 */
export async function authorizedTask(
  ctx: FinishContext,
  action: TaskScopedAction,
  taskId: string | undefined,
): Promise<TaskRow | null> {
  if (taskId === undefined) {
    return null;
  }
  const read = await getTask(ctx.db, { guildId: ctx.actor.guildId, taskId });
  if (!read.ok && read.error.category === "invalid_input") {
    return null;
  }
  const task = valueOf(read);
  return authorize<TaskScopedAction>(action, ctx.actor, ctx.config, task)
    .allowed
    ? task
    : null;
}

/** The task's event, if tasks on it can still change. */
export async function openEventOf(
  ctx: FinishContext,
  task: TaskRow,
): Promise<EventRow | null> {
  const event = valueOf(
    await getEvent(ctx.db, {
      guildId: ctx.actor.guildId,
      eventId: task.event_id,
    }),
  );
  return event?.status === "active" ? event : null;
}

export function shortTaskId(taskId: string): string {
  return taskId.slice(0, SHORT_ID_LENGTH);
}

export function taskText(description: string): SafeText {
  return escapedName(description, DESCRIPTION_SHOWN);
}

export function shownDate(date: DateOnly): SafeText {
  return escapeUserText(date);
}

export function shownId(taskId: string): SafeText {
  return escapeUserText(shortTaskId(taskId));
}

/**
 * The start is fixed and has letters and digits, so a label can always be made. It
 * tells apart two rows with lookalike text, and the text is cut before cleaning so
 * that the cut cannot leave half a character behind.
 */
function pickerLabel(start: string, text: string): PlainText {
  const full = `${start} ${text.slice(0, PICKER_TEXT_LENGTH)}`;
  try {
    return plainLabel(full, DISCORD_LIMITS.autocompleteChoiceName);
  } catch (error) {
    if (error instanceof SafeTextError) {
      return plainLabel(start, DISCORD_LIMITS.autocompleteChoiceName);
    }
    throw error;
  }
}

export function taskChoice(task: {
  readonly id: string;
  readonly description: string;
  readonly due_date: DateOnly;
  readonly status?: TaskStatus;
}): AutocompleteChoice {
  const state = task.status === "done" ? "done, " : "";
  return {
    name: pickerLabel(
      `${shortTaskId(task.id)} ${state}due ${task.due_date}`,
      task.description,
    ),
    value: task.id,
  };
}

export function eventChoice(event: {
  readonly id: string;
  readonly name: string;
  readonly event_date: DateOnly;
}): AutocompleteChoice {
  return {
    name: pickerLabel(
      `${shortTaskId(event.id)} on ${event.event_date}`,
      event.name,
    ),
    value: event.id,
  };
}
