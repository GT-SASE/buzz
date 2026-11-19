/**
 * /task delete. The command only shows what would go, on a private message, and the
 * Confirm click does the delete. The click is checked again from its own signed payload
 * and its custom_id only names the row and the version shown, so a role lost in between
 * counts, a Confirm in anyone else's hands does nothing for them, and a task edited since
 * it was shown is not deleted unseen.
 *
 * A delete is soft: the row and its history stay, and only the bot stops seeing it.
 */

import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { actionRow, button } from "../discord/outbound.ts";
import { plain, safe, userMention } from "../discord/safe-text.ts";
import { softDeleteTaskIfUnchanged } from "../db/tasks.ts";
import {
  autocompleteRoute,
  commandRoute,
  tierOnly,
  componentRoute,
  valueOf,
  type AutocompleteRoute,
  type CommandOption,
  type Route,
} from "../handlers/router.ts";
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
  shownDate,
  stringOption,
  taskText,
  versionFingerprint,
  type TaskDependencies,
} from "./shared.ts";

const CHANGED = safe`That task changed after this was shown, so it wasn't deleted. Check it and run /task delete again.`;

export const deleteSubcommand: CommandOption = {
  type: ApplicationCommandOptionType.Subcommand,
  name: "delete",
  description: "Delete a task, after you confirm",
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

export function deleteRoutes(
  dependencies: TaskDependencies,
): readonly (Route | AutocompleteRoute)[] {
  const confirm = componentRoute({
    prefix: "task.delete-yes",
    fields: ["uuid", "fingerprint"],
    gate: tierOnly("task.delete"),
    changesState: true,
    finish: async (ctx, _resource, [taskId, shown]) => {
      const task = await authorizedTask(ctx, "task.delete", taskId);
      if (task === null) {
        return message(REFUSED_TEXT);
      }
      if (versionFingerprint(task.updated_at) !== shown) {
        return message(CHANGED);
      }
      const event = await openEventOf(ctx, task);
      if (event === null) {
        return message(EVENT_CLOSED);
      }
      const deleted = await softDeleteTaskIfUnchanged(ctx.db, {
        guildId: ctx.actor.guildId,
        taskId: task.id,
        expectedUpdatedAt: task.updated_at,
        now: new Date(),
      });
      if (!deleted.ok && deleted.error.category === "not_found") {
        return message(CHANGED);
      }
      valueOf(deleted);
      const stale = await refreshAfterChange(dependencies, event, ctx);
      return messageWithNotes(
        safe`Deleted: ${taskText(task.description)}`,
        stale,
      );
    },
  });

  return [
    commandRoute({
      path: "task delete",
      gate: tierOnly("task.delete"),
      changesState: false,
      finish: async (ctx) => {
        const raw = stringOption(ctx.payload, "task");
        const taskId = await chosenTaskId(ctx, raw, { orDone: true });
        if (raw !== undefined && taskId === undefined) {
          return message(PICK_FROM_LIST);
        }
        const task = await authorizedTask(ctx, "task.delete", taskId);
        if (task === null) {
          return message(REFUSED_TEXT);
        }
        if ((await openEventOf(ctx, task)) === null) {
          return message(EVENT_CLOSED);
        }
        return {
          content: safe`**Delete this task?**
${taskText(task.description)}
Assigned to ${userMention(task.assignee_id)}, due ${shownDate(task.due_date)}.`,
          mentionUserIds: [],
          components: [
            actionRow(
              button({
                customId: confirm.id(
                  task.id,
                  versionFingerprint(task.updated_at),
                ),
                label: plain`Confirm`,
                style: "danger",
              }),
            ),
          ],
        };
      },
    }),
    confirm,
    autocompleteRoute({
      path: "task delete",
      action: "task.delete",
      choices: deletableTaskChoices,
    }),
  ];
}
