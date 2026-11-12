/**
 * /task edit. The write names the `updated_at` that was just read, so if anyone changed the
 * task since, it matches nothing and the edit is refused, not merged. Every field is
 * written at once, so an edit of several either lands whole or not at all.
 */

import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { commandOptionValue } from "../discord/interactions.ts";
import type { MessageInput } from "../discord/outbound.ts";
import { escapeUserText, safe, userMention } from "../discord/safe-text.ts";
import type { SafeText } from "../discord/safe-text.ts";
import { editTask, MAX_TASK_ACTIONS_PER_OFFICER_PER_DAY } from "../db/tasks.ts";
import { lines } from "../handlers/render.ts";
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
import {
  checkDescription,
  checkDueDate,
  checkPerson,
  type Checked,
} from "./checks.ts";
import { noticeSummary, postNotice, reachWarning } from "./notify.ts";
import { taskChoices } from "./pickers.ts";
import {
  authorizedTask,
  chosenTaskId,
  EVENT_CLOSED,
  message,
  openEventOf,
  PICK_FROM_LIST,
  REFUSED_TEXT,
  refreshAfterChange,
  shownDate,
  shownId,
  stringOption,
  type TaskDependencies,
} from "./shared.ts";

const STALE = safe`Someone else changed this task after you ran this, so nothing was saved. Check it and run /task edit again.`;
const NOTHING_TO_DO = safe`That changes nothing, so nothing was saved.`;

function optional<T>(
  raw: unknown,
  check: (raw: unknown) => Checked<T>,
  current: T,
): Checked<T> {
  return raw === undefined ? { value: current } : check(raw);
}

async function edit(
  ctx: FinishContext,
  dependencies: TaskDependencies,
): Promise<MessageInput> {
  const raw = stringOption(ctx.payload, "task");
  const taskId = await chosenTaskId(ctx, raw);
  if (raw !== undefined && taskId === undefined) {
    return message(PICK_FROM_LIST);
  }
  const task = await authorizedTask(ctx, "task.edit", taskId);
  if (task === null) {
    return message(REFUSED_TEXT);
  }
  if (task.status === "done") {
    return message(safe`That task is done, so it can't be edited.`);
  }
  const event = await openEventOf(ctx, task);
  if (event === null) {
    return message(EVENT_CLOSED);
  }

  const description = optional(
    stringOption(ctx.payload, "description"),
    checkDescription,
    task.description,
  );
  if ("problem" in description) {
    return message(description.problem);
  }
  const due = optional(
    stringOption(ctx.payload, "due"),
    (raw) => checkDueDate(ctx, raw),
    task.due_date,
  );
  if ("problem" in due) {
    return message(due.problem);
  }
  const person = optional(
    commandOptionValue(
      ctx.payload,
      "person",
      ApplicationCommandOptionType.User,
    ),
    (raw) => checkPerson(ctx.payload, raw),
    task.assignee_id,
  );
  if ("problem" in person) {
    return message(person.problem);
  }

  const dueChanged = due.value !== task.due_date;
  const personChanged = person.value !== task.assignee_id;
  if (!dueChanged && !personChanged && description.value === task.description) {
    return message(NOTHING_TO_DO);
  }

  const written = await editTask(ctx.db, {
    guildId: ctx.actor.guildId,
    taskId: task.id,
    expectedUpdatedAt: task.updated_at,
    description: description.value,
    dueDate: due.value,
    assigneeId: person.value,
    actorId: ctx.actor.userId,
  });
  // A new person counts against the officer's limit in the same write, so at the
  // limit nothing changes and nobody is pinged.
  if (!written.ok && written.error.category === "actor_task_limit") {
    return message(
      safe`You've assigned or reassigned ${escapeUserText(String(MAX_TASK_ACTIONS_PER_OFFICER_PER_DAY))} tasks in the last 24 hours, the most allowed, so nothing was saved. Please try again later.`,
    );
  }
  if (!written.ok && written.error.category === "parent_unavailable") {
    return message(EVENT_CLOSED);
  }
  if (!written.ok && written.error.category === "not_found") {
    return message(STALE);
  }
  const saved = valueOf(written);

  const parts: SafeText[] = [safe`Saved task ${shownId(saved.id)}.`];
  if (dueChanged) {
    parts.push(
      safe`It's now due ${shownDate(saved.due_date)}. Moving the date starts its reminders again, so the assignee can get ones they've already had.`,
    );
  }
  if (personChanged) {
    const outcome = await postNotice(
      ctx,
      event,
      saved,
      safe`${userMention(saved.assignee_id)}, this task is now yours:`,
    );
    parts.push(noticeSummary(outcome, saved.assignee_id));
    const warning = await reachWarning(ctx, event, saved.assignee_id);
    if (warning !== undefined) {
      parts.push(warning);
    }
  }
  const stale = await refreshAfterChange(dependencies, event, ctx);
  if (stale !== undefined) {
    parts.push(stale);
  }
  return message(lines(parts) ?? NOTHING_TO_DO);
}

export const editSubcommand: CommandOption = {
  type: ApplicationCommandOptionType.Subcommand,
  name: "edit",
  description: "Change a task's description, due date or person",
  options: [
    {
      type: ApplicationCommandOptionType.String,
      name: "task",
      description: "The task",
      required: true,
      autocomplete: true,
    },
    {
      type: ApplicationCommandOptionType.String,
      name: "description",
      description: "What needs doing. No server invites or masked links",
      max_length: 1000,
    },
    {
      type: ApplicationCommandOptionType.String,
      name: "due",
      description: "Due date, as YYYY-MM-DD or MM/DD. This restarts reminders",
      max_length: 10,
    },
    {
      type: ApplicationCommandOptionType.User,
      name: "person",
      description: "Who the task is for. They'll be mentioned in the post",
    },
  ],
};

export function editRoutes(
  dependencies: TaskDependencies,
): readonly (Route | AutocompleteRoute)[] {
  return [
    commandRoute({
      path: "task edit",
      gate: tierOnly("task.edit"),
      changesState: true,
      finish: (ctx) => edit(ctx, dependencies),
    }),
    autocompleteRoute({
      path: "task edit",
      action: "task.edit",
      choices: taskChoices,
    }),
  ];
}
