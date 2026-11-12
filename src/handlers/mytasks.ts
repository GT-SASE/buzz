/**
 * /mytasks lists the caller's own open tasks, privately, in any channel, then the event
 * steps they are on: open Budget Sheet and Engage post steps, and food pickups from
 * today on. It has no options: the person is the signed member and can't be anyone
 * else. The reply goes back through Discord with the interaction's token, so a replayed
 * request gets nothing.
 */

import {
  DISCORD_LIMITS,
  escapeUserText,
  safe,
  safeTextValue,
} from "../discord/safe-text.ts";
import type { SafeText } from "../discord/safe-text.ts";
import { listOpenStepsForUser } from "../db/event-steps.ts";
import { listOpenTasksForAssignee } from "../db/tasks.ts";
import type { OpenTask, UserStep } from "../db/types.ts";
import { pickupTimeText, stepName } from "../events/steps.ts";
import { todayInZone, type DateOnly } from "../lib/dates.ts";
import { shownDate, shownId } from "../tasks/shared.ts";
import { escapedName, lines } from "./render.ts";
import { commandRoute, noRow, valueOf, type Handler } from "./router.ts";

const DESCRIPTION_SHOWN = 200;
const EVENT_NAME_SHOWN = 60;
/** Kept free for the headings and the lines saying how many are hidden. */
const RESERVED = 240;

function taskLine(task: OpenTask): SafeText {
  return safe`- ${shownId(task.id)}, due ${shownDate(task.due_date)}, ${escapedName(task.event_name, EVENT_NAME_SHOWN)}: ${escapedName(task.description, DESCRIPTION_SHOWN)}`;
}

/** A step of an event already past says so, after the upcoming ones it is listed below. */
function stepLine(step: UserStep, today: DateOnly): SafeText {
  const event = safe`**${escapedName(step.event_name, EVENT_NAME_SHOWN)}** on ${shownDate(step.event_date)}`;
  if (step.kind !== "food_pickup") {
    return step.event_date < today
      ? safe`- ${stepName(step.kind)} for ${event}, still open though the event has passed`
      : safe`- ${stepName(step.kind)} for ${event}`;
  }
  const time =
    step.pickup_time === null
      ? safe`time not set yet`
      : safe`at ${pickupTimeText(step.pickup_time)}`;
  return safe`- Food pickup for ${event}, ${time}`;
}

/** As many whole lines as fit in what is left of one message. */
function linesThatFit(
  items: readonly SafeText[],
  used: number,
): { shown: SafeText[]; used: number } {
  const shown: SafeText[] = [];
  let length = used;
  for (const line of items) {
    const next = length + safeTextValue(line).length + 1;
    if (next > DISCORD_LIMITS.content) {
      break;
    }
    length = next;
    shown.push(line);
  }
  return { shown, used: length };
}

function moreLine(hidden: number, truncated: boolean): SafeText | undefined {
  if (hidden <= 0 && !truncated) {
    return undefined;
  }
  const count = escapeUserText(String(hidden));
  return truncated
    ? safe`...and at least ${count} more.`
    : safe`...and ${count} more.`;
}

export const handler: Handler = {
  commands: [
    {
      name: "mytasks",
      description:
        "See your open tasks and event steps. Only you can see the answer",
    },
  ],
  routes: [
    commandRoute({
      path: "mytasks",
      gate: noRow("mytasks"),
      changesState: false,
      finish: async (ctx) => {
        const guildId = ctx.actor.guildId;
        const userId = ctx.actor.userId;
        const tasks = valueOf(
          await listOpenTasksForAssignee(ctx.db, {
            guildId,
            assigneeId: userId,
          }),
        );
        const today = todayInZone(
          new Date(),
          ctx.config?.timezone ?? "America/New_York",
        );
        const steps = valueOf(
          await listOpenStepsForUser(ctx.db, { guildId, userId, today }),
        );
        if (
          tasks.rows.length === 0 &&
          steps.rows.length === 0 &&
          !tasks.truncated &&
          !steps.truncated
        ) {
          return {
            content: safe`You have no open tasks.`,
            mentionUserIds: [],
          };
        }
        const taskPart = linesThatFit(tasks.rows.map(taskLine), RESERVED);
        const stepPart = linesThatFit(
          steps.rows.map((step) => stepLine(step, today)),
          taskPart.used,
        );
        const sections: SafeText[] = [];
        if (tasks.rows.length > 0 || tasks.truncated) {
          sections.push(safe`**Your open tasks, soonest first**`);
          sections.push(...taskPart.shown);
          const more = moreLine(
            tasks.rows.length - taskPart.shown.length,
            tasks.truncated,
          );
          if (more !== undefined) {
            sections.push(more);
          }
        }
        if (steps.rows.length > 0 || steps.truncated) {
          sections.push(safe`**Your event steps, soonest first**`);
          sections.push(...stepPart.shown);
          const more = moreLine(
            steps.rows.length - stepPart.shown.length,
            steps.truncated,
          );
          if (more !== undefined) {
            sections.push(more);
          }
        }
        return {
          content: lines(sections) ?? safe`You have no open tasks.`,
          mentionUserIds: [],
        };
      },
    }),
  ],
};
