/**
 * The one renderer for an event's overview, and the one way to bring a posted
 * overview up to date. Every stored string goes through the render boundary here, so
 * a name or task written long ago is as inert as one written today. No overview pings
 * anybody: assignees and step owners are shown by mention and `mentionUserIds` stays
 * empty.
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
import { getEventWorkflow } from "../db/event-steps.ts";
import { listEventTasks } from "../db/tasks.ts";
import type { EventRow, EventWorkflow, TaskRow } from "../db/types.ts";
import { escapedName, lines } from "../handlers/render.ts";
import { checklistLines, stepButtonRows } from "./steps.ts";

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
 *
 * Given the event's workflow, it also shows the checklist, and on an active event the
 * buttons for the steps still open. It always sets `components`, so an edit takes away
 * the buttons of steps done since, and a closed event, or one drawn with no workflow, is
 * left with no buttons at all. A redraw whose workflow read failed leaves `components`
 * out instead, so an active event keeps the buttons it has.
 */
export function renderOverview(
  event: EventRow,
  tasks: OverviewTasks,
  notes: readonly SafeText[] = [],
  workflow?: EventWorkflow,
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
    ...(workflow === undefined ? [] : checklistLines(workflow)),
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
  const components =
    workflow !== undefined &&
    event.status === "active" &&
    workflow.event_id === event.id
      ? stepButtonRows(workflow)
      : [];
  return { content, mentionUserIds: [], components };
}

type WorkflowRead =
  | { readonly ok: true; readonly workflow: EventWorkflow | undefined }
  | { readonly ok: false };

async function readWorkflow(
  db: DbClient,
  event: Pick<EventRow, "id" | "guild_id">,
): Promise<WorkflowRead> {
  const read = await getEventWorkflow(db, {
    guildId: event.guild_id,
    eventId: event.id,
  });
  if (!read.ok) {
    logFailure(`workflow: ${errorSummary(read.error)}`);
    return { ok: false };
  }
  return { ok: true, workflow: read.value ?? undefined };
}

/**
 * The event's workflow for drawing its overview. A failed read is logged and gives
 * undefined, and the overview is then drawn without the checklist, to be put right by
 * the next change.
 */
export async function overviewWorkflow(
  db: DbClient,
  event: Pick<EventRow, "id" | "guild_id">,
): Promise<EventWorkflow | undefined> {
  const read = await readWorkflow(db, event);
  return read.ok ? read.workflow : undefined;
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

/**
 * What a draw showed, to tell whether anything it shows changed since: the event's own
 * fields, its tasks and its workflow. A task edited while the overview drew is caught
 * as surely as a step.
 */
function shown(
  event: EventRow,
  tasks: OverviewTasks,
  workflow: WorkflowRead,
): string {
  return JSON.stringify([
    [event.name, event.event_date, event.status, event.created_by],
    tasks.truncated,
    tasks.rows
      .map((task) => [
        task.id,
        task.status,
        task.description,
        task.due_date,
        task.assignee_id,
      ])
      .sort(),
    !workflow.ok
      ? "unread"
      : workflow.workflow === undefined
        ? "none"
        : [
            workflow.workflow.pickup_time,
            [...workflow.workflow.steps]
              .map((step) => [step.kind, step.status, step.completed_by])
              .sort(),
            workflow.workflow.assignees
              .map((assignee) => [assignee.kind, assignee.user_id])
              .sort(),
          ],
  ]);
}

/** False if nothing was drawn, else a fingerprint of what the drawn overview shows. */
type Drawn = false | { readonly shown: string };

/**
 * The overview to draw. An active event whose workflow could not be read keeps the
 * buttons it has, since an edit with no `components` leaves them as they are: taking
 * them away would leave open steps with no button until the next change. A closed event
 * always gets none.
 */
function overviewInput(
  event: EventRow,
  tasks: OverviewTasks,
  workflow: WorkflowRead,
): MessageInput {
  const input = renderOverview(
    event,
    tasks,
    [],
    workflow.ok ? workflow.workflow : undefined,
  );
  if (workflow.ok || event.status !== "active") {
    return input;
  }
  const { content, mentionUserIds } = input;
  return { content, mentionUserIds };
}

/** Draws this copy of the event in its post, if it has one. */
async function draw(
  { db, discord }: OverviewContext,
  event: EventRow,
): Promise<Drawn> {
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
  const workflow = await readWorkflow(db, event);
  const drawn = { shown: shown(event, tasks.value, workflow) };
  const input = overviewInput(event, tasks.value, workflow);
  const target = threadTarget(event.guild_id, threadId);
  if (messageId !== null) {
    try {
      await editOverview(discord, target, messageId, input);
      return drawn;
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
    return false;
  }
  return drawn;
}

/**
 * How many times a refresh draws again because the event, its tasks or its workflow
 * changed while it drew. Each change also redraws by itself, so this only covers the last one's race.
 */
const MAX_REDRAWS = 3;

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
  let event = current.value;
  if (event === null) {
    return false;
  }
  let drawn = await draw(context, event);
  // Two changes at once can each draw, and the slower edit can land last with the
  // other's older state, such as a step still open with its button. Nothing later puts
  // that right, so each refresh reads again after its edit and draws again if what it
  // showed is no longer so. A close has to win the same way: a close that commits after
  // this read draws after this edit.
  for (
    let redraws = 0;
    drawn !== false && event.status !== "closed" && redraws < MAX_REDRAWS;
    redraws++
  ) {
    const latest = await getEvent(context.db, key);
    if (!latest.ok) {
      logFailure(errorSummary(latest.error));
      return true;
    }
    if (latest.value === null) {
      return true;
    }
    if (latest.value.status !== "closed") {
      // A read that fails here says nothing new, and must not take the buttons away.
      const tasks = await listEventTasks(context.db, key);
      const workflow = await readWorkflow(context.db, latest.value);
      if (
        !tasks.ok ||
        !workflow.ok ||
        shown(latest.value, tasks.value, workflow) === drawn.shown
      ) {
        return true;
      }
    }
    event = latest.value;
    drawn = await draw(context, event);
  }
  return drawn !== false;
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
