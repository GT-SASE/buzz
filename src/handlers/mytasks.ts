/**
 * /mytasks lists the caller's own open tasks, privately, in any channel. It has no
 * options: the person is the signed member and can't be anyone else. The reply goes
 * back through Discord with the interaction's token, so a replayed request gets nothing.
 */

import {
  DISCORD_LIMITS,
  escapeUserText,
  safe,
  safeTextValue,
} from "../discord/safe-text.ts";
import type { SafeText } from "../discord/safe-text.ts";
import { listOpenTasksForAssignee } from "../db/tasks.ts";
import type { OpenTask } from "../db/types.ts";
import { shownDate, shownId } from "../tasks/shared.ts";
import { escapedName, lines } from "./render.ts";
import { commandRoute, noRow, valueOf, type Handler } from "./router.ts";

const DESCRIPTION_SHOWN = 200;
const EVENT_NAME_SHOWN = 60;
/** Kept free for the heading and the line saying how many tasks are hidden. */
const RESERVED = 120;

function taskLine(task: OpenTask): SafeText {
  return safe`- ${shownId(task.id)}, due ${shownDate(task.due_date)}, ${escapedName(task.event_name, EVENT_NAME_SHOWN)}: ${escapedName(task.description, DESCRIPTION_SHOWN)}`;
}

/** As many whole lines as fit in one message. */
function linesThatFit(tasks: readonly OpenTask[]): readonly SafeText[] {
  const shown: SafeText[] = [];
  let length = RESERVED;
  for (const task of tasks) {
    const line = taskLine(task);
    length += safeTextValue(line).length + 1;
    if (length > DISCORD_LIMITS.content) {
      break;
    }
    shown.push(line);
  }
  return shown;
}

export const handler: Handler = {
  commands: [
    {
      name: "mytasks",
      description: "See your open tasks. Only you can see the answer",
    },
  ],
  routes: [
    commandRoute({
      path: "mytasks",
      gate: noRow("mytasks"),
      changesState: false,
      finish: async (ctx) => {
        const { rows, excluded, truncated } = valueOf(
          await listOpenTasksForAssignee(ctx.db, {
            guildId: ctx.actor.guildId,
            assigneeId: ctx.actor.userId,
          }),
        );
        if (excluded.length > 0) {
          console.error(
            `mytasks: ${String(excluded.length)} row(s) failed their checks`,
          );
        }
        const shown = linesThatFit(rows);
        const body = lines(shown);
        const hidden = rows.length + excluded.length - shown.length;
        if (body === undefined && hidden === 0) {
          return {
            content: safe`You have no open tasks.`,
            mentionUserIds: [],
          };
        }
        const count = escapeUserText(String(hidden));
        const footer = truncated
          ? safe`...and at least ${count} more.`
          : safe`...and ${count} more.`;
        const heading = safe`**Your open tasks, soonest first**`;
        const list = body === undefined ? heading : safe`${heading}\n${body}`;
        return {
          content: hidden > 0 || truncated ? safe`${list}\n${footer}` : list,
          mentionUserIds: [],
        };
      },
    }),
  ],
};
