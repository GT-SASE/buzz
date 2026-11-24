/**
 * When a reminder may be claimed, as conditions on the rows it concerns. Every claim and
 * every takeover of a stale claim states them in the same statement that writes, so what
 * was true when the check ran is still true when the claim lands.
 *
 * These are fragments of a select, `from` and `where`, not a query of their own: Drizzle's
 * insert-from-select wants every column of the table it fills, and a takeover wants the
 * select as an `exists` under an update, so the caller names the columns it needs.
 */

import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  eventSteps,
  events,
  guildConfig,
  managedChannels,
  tasks,
} from "./schema.ts";
import type { EventReminderKind } from "./types.ts";

/**
 * Engage picture late goes out a week after Engage post was done, which can be after the
 * event, so it is the one kind that may be claimed for a day past the event's date. Every
 * other kind is claimed up to the event. Which day each kind goes out is the planner's
 * to decide. The closer of a stale claim reads the same rule, so a ping that may still
 * go out is not closed as skipped.
 */
export function eventReminderDayOpen(
  kind: EventReminderKind,
  reminderDate: string,
  eventDate: SQLWrapper,
): SQL {
  return kind === "engage_picture_late"
    ? sql`true`
    : sql`${reminderDate}::date <= ${eventDate}`;
}

/**
 * `from ... where ...` for the event, if a reminder of this kind for this date may be
 * claimed for it: it is live and active, its channel is managed and active, the guild's
 * reminders are on, the date suits the kind, and the date is today or yesterday in the
 * guild's zone, so a run can claim neither a day long gone nor one still to come. A
 * pickup reminder also needs Food pickup set up, which means done. Names `events` and
 * the tables it joins, so a select list that precedes it can use their columns.
 */
export function fromAllowedEvent(
  eventId: SQLWrapper | string,
  kind: EventReminderKind,
  reminderDate: string,
): SQL {
  const today = sql`(now() at time zone ${guildConfig.timezone})::date`;
  const pickupGate =
    kind === "pickup_before" || kind === "pickup_day"
      ? sql`and exists (
          select 1 from ${eventSteps}
          where ${eventSteps.eventId} = ${events.id}
            and ${eventSteps.kind} = 'food_pickup'
            and ${eventSteps.status} = 'done')`
      : sql``;
  return sql`from ${events}
    join ${managedChannels}
      on ${managedChannels.guildId} = ${events.guildId}
      and ${managedChannels.channelId} = ${events.channelId}
    join ${guildConfig} on ${guildConfig.guildId} = ${events.guildId}
    where ${events.id} = ${eventId}
      and ${events.status} = 'active'
      and ${events.deletedAt} is null
      and ${managedChannels.status} = 'active'
      and ${guildConfig.remindersEnabled}
      and ${eventReminderDayOpen(kind, reminderDate, events.eventDate)}
      and ${reminderDate}::date >= ${today} - 1
      and ${reminderDate}::date <= ${today}
      ${pickupGate}`;
}

/**
 * `from ... where ...` for the open task, if a reminder for its due date may be claimed
 * for it: it is live and open, due that day, on a live active event, in a channel that is
 * managed and active, in a guild with reminders on. Names `tasks` and the tables it joins.
 */
export function fromRemindableTask(
  taskId: SQLWrapper | string,
  dueDate: string,
): SQL {
  return sql`from ${tasks}
    join ${events} on ${events.id} = ${tasks.eventId} and ${events.guildId} = ${tasks.guildId}
    join ${managedChannels}
      on ${managedChannels.guildId} = ${events.guildId}
      and ${managedChannels.channelId} = ${events.channelId}
    join ${guildConfig} on ${guildConfig.guildId} = ${tasks.guildId}
    where ${tasks.id} = ${taskId}
      and ${tasks.dueDate} = ${dueDate}::date
      and ${tasks.status} = 'open'
      and ${tasks.deletedAt} is null
      and ${events.status} = 'active'
      and ${events.deletedAt} is null
      and ${managedChannels.status} = 'active'
      and ${guildConfig.remindersEnabled}`;
}
