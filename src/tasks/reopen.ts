/**
 * /task reopen, an officer's undo for a task marked done. Its reminders follow the due
 * date again, as for any open task. The event's post gets a line saying who reopened it,
 * which pings nobody.
 */

import { ApplicationCommandOptionType } from "discord-api-types/v10";
import type { MessageInput } from "../discord/outbound.ts";
import { safe, userMention } from "../discord/safe-text.ts";
import { reopenTask } from "../db/tasks.ts";
import {
  autocompleteRoute,
  commandRoute,
  tierOnly,
  valueOf,
  type AutocompleteRoute,
  type CommandOption,
  type FinishContext,
  type Route,
} from "../handlers/router.ts";
import { postInEvent } from "./notify.ts";
import { deletableTaskChoices } from "./pickers.ts";
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
  shownId,
  stringOption,
  taskText,
  type TaskDependencies,
} from "./shared.ts";

const NOT_DONE = safe`That task isn't done, so there's nothing to reopen.`;

async function reopen(
  ctx: FinishContext,
  dependencies: TaskDependencies,
  taskId: string | undefined,
): Promise<MessageInput> {
  const task = await authorizedTask(ctx, "task.reopen", taskId);
  if (task === null) {
    return message(REFUSED_TEXT);
  }
  if (task.status !== "done") {
    return message(NOT_DONE);
  }
  const event = await openEventOf(ctx, task);
  if (event === null) {
    return message(EVENT_CLOSED);
  }
  const written = await reopenTask(ctx.db, {
    guildId: ctx.actor.guildId,
    taskId: task.id,
  });
  if (!written.ok && written.error.category === "parent_unavailable") {
    return message(EVENT_CLOSED);
  }
  if (!written.ok && written.error.category === "not_found") {
    // Reopened or deleted since it was read.
    return message(NOT_DONE);
  }
  const reopened = valueOf(written);
  const posted = await postInEvent(
    ctx,
    event,
    message(
      safe`Task ${shownId(reopened.id)} reopened by ${userMention(ctx.actor.userId)}.`,
    ),
  );
  const stale = await refreshAfterChange(dependencies, event, ctx);
  return messageWithNotes(
    safe`Reopened: ${taskText(reopened.description)}`,
    posted === "posted"
      ? undefined
      : safe`I couldn't note it in the event's post.`,
    stale,
  );
}

export const reopenSubcommand: CommandOption = {
  type: ApplicationCommandOptionType.Subcommand,
  name: "reopen",
  description: "Reopen a task marked done",
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

export function reopenRoutes(
  dependencies: TaskDependencies,
): readonly (Route | AutocompleteRoute)[] {
  return [
    commandRoute({
      path: "task reopen",
      gate: tierOnly("task.reopen"),
      changesState: true,
      finish: async (ctx) => {
        const raw = stringOption(ctx.payload, "task");
        const taskId = await chosenTaskId(ctx, raw, { orDone: true });
        return raw !== undefined && taskId === undefined
          ? message(PICK_FROM_LIST)
          : reopen(ctx, dependencies, taskId);
      },
    }),
    autocompleteRoute({
      path: "task reopen",
      action: "task.reopen",
      choices: deletableTaskChoices,
    }),
  ];
}
