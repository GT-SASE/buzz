/**
 * The one renderer for an event's overview, and the one way to bring a posted
 * overview up to date. Every stored string goes through the render boundary here, so
 * a name or task written long ago is as inert as one written today. No overview pings
 * anybody: assignees are shown by mention and `mentionUserIds` stays empty.
 */

import { DiscordClientError, DiscordErrorCode } from "../discord/client.ts";
import type { DiscordClient, ThreadTarget } from "../discord/client.ts";
import { channelMessage, messageEdit } from "../discord/outbound.ts";
import type { MessageInput } from "../discord/outbound.ts";
import {
  DISCORD_LIMITS,
  escapeUserText,
  isWithinLimit,
  safe,
  safeTextValue,
  userMention,
} from "../discord/safe-text.ts";
import type { SafeText } from "../discord/safe-text.ts";
import type { DbClient } from "../db/client.ts";
import { errorSummary } from "../db/errors.ts";
import {
  getEvent,
  markEventThreadMissing,
  setEventOverviewMessage,
} from "../db/events.ts";
import { listEventTasks } from "../db/tasks.ts";
import type { EventRow, TaskRow } from "../db/types.ts";
import { escapedName, lines } from "../handlers/render.ts";

// A name escapes to at most twice its 100 characters. A task line stays short so one
// long task cannot push the others out.
const EVENT_NAME_LENGTH = 200;
const TASK_TEXT_LENGTH = 200;

export function threadTarget(guildId: string, threadId: string): ThreadTarget {
  return { kind: "thread", guildId, threadId };
}

/**
 * Joins fixed lines and as many items as fit in one message. `hidden` writes the
 * closing line, and is given the number left out, so nothing is lost silently.
 */
export function fitLines(
  fixed: readonly SafeText[],
  items: readonly SafeText[],
  hidden: (count: number) => SafeText | undefined,
  limit: number = DISCORD_LIMITS.content,
): SafeText {
  const join = (parts: readonly SafeText[]) => lines(parts) ?? safe``;
  const fits = (parts: readonly SafeText[]) =>
    isWithinLimit(safeTextValue(join(parts)), limit);

  const closing = hidden(0);
  const everything = [
    ...fixed,
    ...items,
    ...(closing === undefined ? [] : [closing]),
  ];
  if (fits(everything)) {
    return join(everything);
  }
  // Measured against the closing line for all of them, which is the longest it gets.
  const worst = hidden(items.length) ?? safe``;
  const shown: SafeText[] = [];
  for (const item of items) {
    if (!fits([...fixed, ...shown, item, worst])) {
      break;
    }
    shown.push(item);
  }
  const last = hidden(items.length - shown.length);
  return join([...fixed, ...shown, ...(last === undefined ? [] : [last])]);
}

export function dateText(date: string): SafeText {
  return escapeUserText(date);
}

function taskLine(task: TaskRow): SafeText {
  const mark = task.status === "done" ? safe`✅` : safe`☐`;
  // A description with nothing visible left must not stop the rest of the overview.
  const text = escapedName(task.description, TASK_TEXT_LENGTH);
  return safe`${mark} ${userMention(task.assignee_id)} ${text} (due ${dateText(task.due_date)})`;
}

export function eventStatusText(event: Pick<EventRow, "status">): SafeText {
  return event.status === "closed" ? safe`Closed` : safe`Active`;
}

export function eventTitle(event: Pick<EventRow, "name">): SafeText {
  return escapedName(event.name, EVENT_NAME_LENGTH);
}

/** What the renderer needs: a list, and whether the database held more than that. */
export interface OverviewTasks {
  readonly rows: readonly TaskRow[];
  readonly truncated: boolean;
}

function countText(count: number): SafeText {
  return escapeUserText(String(count));
}

/**
 * The overview's text. `notes` are extra lines for the reader, kept whatever else has
 * to be cut. Open tasks come first, so the tasks hidden by the limit are the done ones.
 */
export function renderOverview(
  event: EventRow,
  tasks: OverviewTasks,
  notes: readonly SafeText[] = [],
): MessageInput {
  const open = tasks.rows.filter((task) => task.status === "open");
  const done = tasks.rows.filter((task) => task.status === "done");
  const counts = safe`Tasks: ${countText(open.length)} open, ${countText(done.length)} done${tasks.truncated ? safe`, and more` : safe``}`;
  const fixed = [
    safe`**${eventTitle(event)}**`,
    safe`Date: ${dateText(event.event_date)}`,
    safe`Status: ${eventStatusText(event)}`,
    safe`Created by ${userMention(event.created_by)}`,
    ...notes,
    tasks.rows.length === 0 && !tasks.truncated ? safe`No tasks yet.` : counts,
  ];
  const content = fitLines(fixed, [...open, ...done].map(taskLine), (count) => {
    if (count === 0 && !tasks.truncated) {
      return undefined;
    }
    return tasks.truncated
      ? safe`…and more than ${countText(count)} other tasks not shown.`
      : safe`…and ${countText(count)} more not shown.`;
  });
  return { content, mentionUserIds: [] };
}

export interface OverviewContext {
  readonly db: DbClient;
  readonly discord: DiscordClient;
}

function isDiscordFailure(
  error: unknown,
  status: number,
  code: number,
): boolean {
  if (!(error instanceof DiscordClientError)) {
    return false;
  }
  const { failure } = error;
  return (
    (failure.kind === "api" || failure.kind === "channel_unavailable") &&
    failure.status === status &&
    failure.code === code
  );
}

/** A post idle past the forum's timer is archived, and Discord refuses edits in it. */
function isArchivedRefusal(error: unknown): boolean {
  return (
    error instanceof DiscordClientError &&
    error.failure.kind === "api" &&
    error.failure.code === DiscordErrorCode.ThreadArchived
  );
}

/** A send would reopen the post by itself, but an edit has to ask first. */
async function editOverview(
  discord: DiscordClient,
  target: ThreadTarget,
  messageId: string,
  input: MessageInput,
): Promise<void> {
  try {
    await discord.editMessage(target, messageId, messageEdit(input));
  } catch (error) {
    if (!isArchivedRefusal(error)) {
      throw error;
    }
    await discord.reopenThread(target);
    await discord.editMessage(target, messageId, messageEdit(input));
  }
}

function logFailure(detail: string): void {
  console.error(`Overview refresh failed: ${detail}`);
}

/** Draws this copy of the event in its post, if it has one. */
async function draw(
  { db, discord }: OverviewContext,
  event: EventRow,
): Promise<boolean> {
  const key = { guildId: event.guild_id, eventId: event.id };
  const { thread_id: threadId, overview_message_id: messageId } = event;
  if (threadId === null || event.thread_status !== "active") {
    return false;
  }
  const tasks = await listEventTasks(db, key);
  if (!tasks.ok) {
    logFailure(errorSummary(tasks.error));
    return false;
  }
  const input = renderOverview(event, tasks.value);
  const target = threadTarget(event.guild_id, threadId);
  if (messageId !== null) {
    try {
      await editOverview(discord, target, messageId, input);
      return true;
    } catch (error) {
      // Someone removed the message. Anything else is not fixed by posting again.
      if (!isDiscordFailure(error, 404, DiscordErrorCode.UnknownMessage)) {
        throw error;
      }
    }
  }
  const sent = await discord.sendMessage(target, channelMessage(input));
  const saved = await setEventOverviewMessage(db, {
    ...key,
    messageId: sent.id,
  });
  if (!saved.ok) {
    logFailure(errorSummary(saved.error));
  }
  return saved.ok;
}

async function refresh(
  context: OverviewContext,
  given: Pick<EventRow, "id" | "guild_id">,
): Promise<boolean> {
  const key = { guildId: given.guild_id, eventId: given.id };
  // Read again: the row a caller holds can be out of date, and the send targets come
  // only from what is stored for this guild.
  const current = await getEvent(context.db, key);
  if (!current.ok) {
    logFailure(errorSummary(current.error));
    return false;
  }
  const event = current.value;
  if (event === null) {
    return false;
  }
  const drawn = await draw(context, event);
  if (!drawn || event.status === "closed") {
    return drawn;
  }
  // A slow edit can land after /event close has drawn its own. Nothing redraws a closed
  // event later, so the closed state has to win here. Reading after the edit is what
  // settles it: a close that commits later than this read draws after this edit.
  const latest = await getEvent(context.db, key);
  if (!latest.ok) {
    logFailure(errorSummary(latest.error));
    return drawn;
  }
  return latest.value?.status === "closed"
    ? draw(context, latest.value)
    : drawn;
}

/**
 * Brings the event's overview up to date after a change. Never rejects, because the
 * change has already happened and a stale overview must not fail the user's action.
 * Returns whether the overview is now current. A removed forum, a missing thread or a
 * deleted event gets no post at all.
 */
export async function refreshOverview(
  context: OverviewContext,
  event: Pick<EventRow, "id" | "guild_id">,
): Promise<boolean> {
  try {
    return await refresh(context, event);
  } catch (error) {
    if (isDiscordFailure(error, 404, DiscordErrorCode.UnknownChannel)) {
      const marked = await markEventThreadMissing(context.db, {
        guildId: event.guild_id,
        eventId: event.id,
      }).catch(() => undefined);
      logFailure(`thread missing, marked: ${String(marked?.ok === true)}`);
      return false;
    }
    logFailure(
      error instanceof DiscordClientError
        ? error.failure.kind
        : error instanceof Error
          ? error.name
          : "unknown error",
    );
    return false;
  }
}
