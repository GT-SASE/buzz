/**
 * /task assign. Guild and actor come only from the signed payload, and each option is
 * read by name, so an extra option such as `p_actor_id` is never looked at. The event
 * is the one named by the option, or else the post the command runs in.
 *
 * The router claims the interaction before this runs, so a replay adds no task and no
 * ping. The database refuses a closed event and enforces the quotas when the row is
 * inserted, so neither can be passed by two commands at once.
 */

import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { commandOptionValue } from "../discord/interactions.ts";
import type { MessageInput } from "../discord/outbound.ts";
import { safe, userMention } from "../discord/safe-text.ts";
import { MAX_DATE_INPUT_LENGTH } from "../events/input.ts";
import { createTask } from "../db/tasks.ts";
import { MAX_TASK_DESCRIPTION_LENGTH } from "../db/validate.ts";
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
import { checkDescription, checkDueDate, checkPerson } from "./checks.ts";
import { noticeSummary, postNotice, reachWarning } from "./notify.ts";
import { eventChoices } from "./pickers.ts";
import {
  chooseEvent,
  message,
  messageWithNotes,
  NO_EVENT,
  PICK_FROM_LIST,
  REFUSED_TEXT,
  refreshAfterChange,
  shownDate,
  shownId,
  stringOption,
  type TaskDependencies,
} from "./shared.ts";

const EVENT_IS_CLOSED = safe`That event is closed or deleted, so it can't take new tasks.`;

async function assign(
  ctx: FinishContext,
  dependencies: TaskDependencies,
): Promise<MessageInput> {
  const chosen = await chooseEvent(ctx, "task.assign");
  if (chosen.kind === "refused") {
    return message(REFUSED_TEXT);
  }
  if (chosen.kind === "typed") {
    return message(PICK_FROM_LIST);
  }
  if (chosen.kind === "none") {
    return message(NO_EVENT);
  }
  const { event } = chosen;
  if (event.status !== "active") {
    return message(EVENT_IS_CLOSED);
  }

  const person = checkPerson(
    ctx.payload,
    commandOptionValue(
      ctx.payload,
      "person",
      ApplicationCommandOptionType.User,
    ),
  );
  if ("problem" in person) {
    return message(person.problem);
  }
  const description = checkDescription(
    stringOption(ctx.payload, "description"),
  );
  if ("problem" in description) {
    return message(description.problem);
  }
  const due = checkDueDate(ctx, stringOption(ctx.payload, "due"));
  if ("problem" in due) {
    return message(due.problem);
  }

  // Literal arguments, from the signed payload and the checks above.
  const created = await createTask(ctx.db, {
    guildId: ctx.actor.guildId,
    eventId: event.id,
    assigneeId: person.value,
    actorId: ctx.actor.userId,
    description: description.value,
    dueDate: due.value,
  });
  if (!created.ok) {
    switch (created.error.category) {
      case "parent_unavailable":
        return message(EVENT_IS_CLOSED);
      case "event_task_limit":
        return message(
          safe`This event already has the most tasks one event can hold. Delete some before adding more.`,
        );
      case "actor_task_limit":
        return message(
          safe`You've reached the limit for assigning and reassigning tasks. Please try again later.`,
        );
    }
  }
  const task = valueOf(created);

  const outcome = await postNotice(
    ctx,
    event,
    task,
    safe`${userMention(task.assignee_id)}, you have a new task:`,
  );
  const warning = await reachWarning(ctx, event, task.assignee_id);
  const stale = await refreshAfterChange(dependencies, event, ctx);
  return messageWithNotes(
    safe`Assigned task ${shownId(task.id)} to ${userMention(task.assignee_id)}, due ${shownDate(task.due_date)}. ${noticeSummary(outcome, task.assignee_id)}`,
    warning,
    stale,
  );
}

export const assignSubcommand: CommandOption = {
  type: ApplicationCommandOptionType.Subcommand,
  name: "assign",
  description: "Give someone a task on an event",
  options: [
    {
      type: ApplicationCommandOptionType.User,
      name: "person",
      description: "Who the task is for",
      required: true,
    },
    {
      type: ApplicationCommandOptionType.String,
      name: "description",
      description: "What needs doing. No server invites or masked links",
      required: true,
      max_length: MAX_TASK_DESCRIPTION_LENGTH,
    },
    {
      type: ApplicationCommandOptionType.String,
      name: "due",
      description: "Due date, as YYYY-MM-DD or MM/DD",
      required: true,
      max_length: MAX_DATE_INPUT_LENGTH,
    },
    {
      type: ApplicationCommandOptionType.String,
      name: "event",
      description: "The event. Defaults to the post you're in",
      autocomplete: true,
    },
  ],
};

export function assignRoutes(
  dependencies: TaskDependencies,
): readonly (Route | AutocompleteRoute)[] {
  return [
    commandRoute({
      path: "task assign",
      gate: tierOnly("task.assign"),
      changesState: true,
      finish: (ctx) => assign(ctx, dependencies),
    }),
    autocompleteRoute({
      path: "task assign",
      action: "task.assign",
      choices: eventChoices,
    }),
  ];
}
