/**
 * Marking a task done, by /task done or by the button on a message.
 *
 * The button can sit on a message everyone sees, so anyone can click it. Its custom_id
 * holds only a task ID, which names a row and grants nothing: the row is loaded and the
 * clicker checked from the click's own signed payload, with a private refusal unless
 * they are the assignee or an officer. The write then repeats the check in its filters,
 * because the task can be reassigned between that read and the write.
 */

import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { actionRow, button } from "../discord/outbound.ts";
import type { MessageInput, Part } from "../discord/outbound.ts";
import {
  DISCORD_LIMITS,
  plain,
  plainLabel,
  plainTextValue,
  safe,
  SafeTextError,
  textLength,
} from "../discord/safe-text.ts";
import type { PlainText } from "../discord/safe-text.ts";
import {
  getTask,
  markOwnTaskDone,
  markTaskDoneAsOfficer,
} from "../db/tasks.ts";
import { isUuid } from "../db/validate.ts";
import { isOfficer } from "../lib/permissions.ts";
import {
  autocompleteRoute,
  commandRoute,
  componentRoute,
  tierOnly,
  valueOf,
  type CommandOption,
  type FinishContext,
  type Route,
  type AutocompleteRoute,
} from "../handlers/router.ts";
import { taskChoices } from "./pickers.ts";
import {
  authorizedTask,
  chosenTaskId,
  EVENT_CLOSED,
  message,
  messageWithNotes,
  openEventOf,
  PICK_FROM_LIST,
  REFUSED_TEXT,
  refreshAfterChange,
  stringOption,
  taskText,
  type TaskDependencies,
} from "./shared.ts";

const PREFIX = "task.done";
// Leaves room for the words before it within Discord's limit of 80.
const LABEL_TEXT_LENGTH = 60;

const ALREADY_DONE = safe`That task is already done, so there's nothing more to do.`;
const CHANGED = safe`That task was reassigned or deleted just now, so it wasn't marked done.`;

/**
 * A message with several tasks has several buttons, so each can name its task. A label
 * is shown literally, so it keeps only harmless characters. Text with nothing usable
 * in it gets the plain label.
 */
function buttonLabel(description: string | undefined): PlainText {
  const fallback = plain`✅ Mark done`;
  if (description === undefined) {
    return fallback;
  }
  let shown = "";
  // By code point, so a character is never cut in half.
  for (const character of description) {
    if (textLength(shown + character) > LABEL_TEXT_LENGTH) {
      break;
    }
    shown += character;
  }
  try {
    const text = plainTextValue(plainLabel(shown));
    return plainLabel(`✅ Done - ${text}`, DISCORD_LIMITS.buttonLabel);
  } catch (error) {
    if (error instanceof SafeTextError) {
      return fallback;
    }
    throw error;
  }
}

/** The button for a task's messages. Throws if the ID is not a task ID. */
export function markDoneButton(
  taskId: string,
  description?: string,
): Part<"button"> {
  if (!isUuid(taskId)) {
    throw new RangeError("A Mark done button needs a task ID");
  }
  return button({
    customId: `${PREFIX}:${taskId}`,
    label: buttonLabel(description),
    style: "success",
  });
}

export function markDoneRow(taskId: string, description?: string): Part<"row"> {
  return actionRow(markDoneButton(taskId, description));
}

async function markDone(
  ctx: FinishContext,
  dependencies: TaskDependencies,
  taskId: string | undefined,
): Promise<MessageInput> {
  const task = await authorizedTask(ctx, "task.done", taskId);
  if (task === null) {
    return message(REFUSED_TEXT);
  }
  if (task.status === "done") {
    return message(ALREADY_DONE);
  }
  const event = await openEventOf(ctx, task);
  if (event === null) {
    return message(EVENT_CLOSED);
  }

  const { guildId, userId } = ctx.actor;
  const now = new Date();
  const written = isOfficer(ctx.actor, ctx.config)
    ? await markTaskDoneAsOfficer(ctx.db, { guildId, taskId: task.id, now })
    : await markOwnTaskDone(ctx.db, {
        guildId,
        taskId: task.id,
        assigneeId: userId,
        now,
      });
  if (!written.ok && written.error.category === "parent_unavailable") {
    return message(EVENT_CLOSED);
  }
  if (!written.ok && written.error.category === "not_found") {
    // The row changed after it was read, and the write's filters caught that.
    const current = valueOf(
      await getTask(ctx.db, { guildId, taskId: task.id }),
    );
    return message(current?.status === "done" ? ALREADY_DONE : CHANGED);
  }
  const done = valueOf(written);
  const stale = await refreshAfterChange(dependencies, event, ctx);
  return messageWithNotes(
    safe`Marked done: ${taskText(done.description)}`,
    stale,
  );
}

export const doneSubcommand: CommandOption = {
  type: ApplicationCommandOptionType.Subcommand,
  name: "done",
  description: "Mark a task done, if it's yours or you're an officer",
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: "task",
      description: "The task",
      required: true,
      autocomplete: true,
    },
  ],
};

export function doneRoutes(
  dependencies: TaskDependencies,
): readonly (Route | AutocompleteRoute)[] {
  return [
    commandRoute({
      path: "task done",
      gate: tierOnly("task.done"),
      changesState: true,
      finish: async (ctx) => {
        const raw = stringOption(ctx.payload, "task");
        const taskId = await chosenTaskId(ctx, raw);
        return raw !== undefined && taskId === undefined
          ? message(PICK_FROM_LIST)
          : markDone(ctx, dependencies, taskId);
      },
    }),
    autocompleteRoute({
      path: "task done",
      action: "task.done",
      choices: taskChoices,
    }),
    componentRoute({
      prefix: PREFIX,
      fields: ["uuid"],
      onPublicMessage: true,
      gate: tierOnly("task.done"),
      changesState: true,
      finish: (ctx, _resource, [taskId]: readonly [string]) =>
        markDone(ctx, dependencies, taskId),
    }),
  ];
}
