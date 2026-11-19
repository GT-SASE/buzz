/**
 * The one renderer for reminder messages. Everything stored reaches a message through
 * `SafeText` here, and a person is only ever shown as a mention of their ID, because
 * any member controls their own nickname.
 *
 * A reminder can go out late, after a missed run or a moved deadline, so each line
 * states the real date and the days left, never what the reminder's kind implies.
 *
 * Each task gets a Mark done button on the message where its text ends, and a message
 * holds at most five rows of buttons, so it also holds at most five tasks.
 */

import {
  DISCORD_LIMITS,
  chunkMessages,
  escapeUserText,
  safe,
  safeTextValue,
  textLength,
  truncateUserText,
  userMention,
  type Chunk,
  type ChunkLine,
  type SafeText,
} from "../discord/safe-text.ts";
import type { Part } from "../discord/outbound.ts";
import { daysBetween, type DateOnly } from "../lib/dates.ts";
import { markDoneRow } from "../tasks/done.ts";

const MAX_EVENT_NAME = 200;
// Stored text is shorter than this, so it only stops a row that got past the checks
// from filling a run's messages.
const MAX_DESCRIPTION = 8000;

const dateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  dateStyle: "medium",
});

function dayCount(days: number): SafeText {
  const count = escapeUserText(String(days));
  return days === 1 ? safe`${count} day` : safe`${count} days`;
}

/** The date and days left, worked out from the due date and never from a kind. */
export function renderDue(today: DateOnly, dueDate: DateOnly): SafeText {
  const days = daysBetween(today, dueDate);
  const date = escapeUserText(dateFormat.format(new Date(dueDate)));
  if (days === 0) {
    return safe`due today, ${date}`;
  }
  return days > 0
    ? safe`due ${date}, ${dayCount(days)} left`
    : safe`was due ${date}, ${dayCount(-days)} ago`;
}

function renderDescription(raw: string): SafeText | null {
  try {
    return truncateUserText(raw, MAX_DESCRIPTION);
  } catch {
    return null;
  }
}

export interface ReminderLineInput {
  readonly taskId: string;
  readonly assigneeId: string;
  readonly description: string;
  readonly dueDate: DateOnly;
  readonly today: DateOnly;
}

export interface RenderedLine {
  readonly line: ChunkLine;
  /** The task's Mark done button. */
  readonly row: Part<"row">;
  /** The stored text had nothing visible, so a stand-in was shown. */
  readonly usedStandIn: boolean;
}

/** Text with nothing visible still gets its reminder: only the date is known. */
export function renderReminderLine(input: ReminderLineInput): RenderedLine {
  const { taskId, assigneeId, description, dueDate, today } = input;
  const text = renderDescription(description);
  const shown = text ?? safe`(a task with no readable description)`;
  return {
    line: {
      text: safe`${userMention(assigneeId)} ${shown}: ${renderDue(today, dueDate)}`,
      mentionUserIds: [assigneeId],
    },
    row: markDoneRow(taskId, description),
    usedStandIn: text === null,
  };
}

export function renderEventHeader(eventName: string): ChunkLine {
  let text: SafeText;
  try {
    text = safe`**Task reminders: ${truncateUserText(eventName, MAX_EVENT_NAME)}**`;
  } catch {
    text = safe`**Task reminders**`;
  }
  return { text, mentionUserIds: [] };
}

function lengthOf(line: ChunkLine): number {
  return textLength(safeTextValue(line.text));
}

function joinedLength(lines: readonly ChunkLine[]): number {
  return lines.reduce(
    (total, line, index) => total + lengthOf(line) + (index === 0 ? 0 : 1),
    0,
  );
}

function fitsOneMessage(lines: readonly ChunkLine[]): boolean {
  const users = new Set(lines.flatMap((line) => line.mentionUserIds));
  return (
    joinedLength(lines) <= DISCORD_LIMITS.content &&
    users.size <= DISCORD_LIMITS.mentionedUsers
  );
}

/**
 * The messages for an event's header and lines. A line too long for one message is
 * joined to the header, so the split does not leave the header alone in a message.
 */
export function renderMessages(
  header: ChunkLine,
  lines: readonly ChunkLine[],
): Chunk[] {
  const [only, ...others] = lines;
  if (
    only !== undefined &&
    others.length === 0 &&
    !fitsOneMessage([header, only])
  ) {
    return chunkMessages([
      {
        text: safe`${header.text} ${only.text}`,
        mentionUserIds: only.mentionUserIds,
      },
    ]);
  }
  return chunkMessages([header, ...lines]);
}

/** One row of buttons per task, and a message holds this many rows. */
const MAX_TASKS_PER_MESSAGE = DISCORD_LIMITS.actionRows;

export interface Batch<T> {
  readonly items: readonly T[];
  readonly messages: readonly Chunk[];
}

/**
 * Packs an event's items into batches, in order. A batch is either several items in
 * one message or one item too long for a message, so a send's result always says what
 * happened to each item, and one long task cannot hold back the others.
 */
export function packBatches<T>(
  header: ChunkLine,
  items: readonly T[],
  lineOf: (item: T) => ChunkLine,
): Batch<T>[] {
  const batches: Batch<T>[] = [];
  let current: T[] = [];
  const flush = () => {
    if (current.length > 0) {
      batches.push({
        items: current,
        messages: renderMessages(header, current.map(lineOf)),
      });
      current = [];
    }
  };
  for (const item of items) {
    if (
      current.length >= MAX_TASKS_PER_MESSAGE ||
      !fitsOneMessage([header, ...current.map(lineOf), lineOf(item)])
    ) {
      flush();
    }
    current.push(item);
  }
  flush();
  return batches;
}
