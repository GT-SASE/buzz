/**
 * When a reminder may be claimed, as the rows it concerns. Every claim and every takeover
 * of a stale claim puts these conditions in the same statement that writes, so what was
 * true when the check ran is still true when the claim lands. Each is a select the caller
 * uses as a source for an insert, or as an `exists` under an update.
 */

import {
  and,
  eq,
  exists,
  gte,
  isNull,
  lte,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import type { BotDb } from "./client.ts";
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
) {
  return kind === "engage_picture_late"
    ? undefined
    : sql`${reminderDate}::date <= ${eventDate}`;
}

/**
 * The event, if a reminder of this kind for this date may be claimed for it: it is live
 * and active, its channel is managed and active, the guild's reminders are on, the date
 * suits the kind, and the date is today or yesterday in the guild's zone, so a run can
 * claim neither a day long gone nor one still to come. A pickup reminder also needs Food
 * pickup set up, which means done.
 */
export function allowedEvent(
  orm: BotDb,
  eventId: SQLWrapper | string,
  kind: EventReminderKind,
  reminderDate: string,
) {
  const today = sql`(now() at time zone ${guildConfig.timezone})::date`;
  const date = sql`${reminderDate}::date`;
  return orm
    .select({ id: events.id })
    .from(events)
    .innerJoin(
      managedChannels,
      and(
        eq(managedChannels.guildId, events.guildId),
        eq(managedChannels.channelId, events.channelId),
      ),
    )
    .innerJoin(guildConfig, eq(guildConfig.guildId, events.guildId))
    .where(
      and(
        eq(events.id, eventId),
        eq(events.status, "active"),
        isNull(events.deletedAt),
        eq(managedChannels.status, "active"),
        eq(guildConfig.remindersEnabled, true),
        eventReminderDayOpen(kind, reminderDate, events.eventDate),
        gte(date, sql`${today} - 1`),
        lte(date, today),
        kind === "pickup_before" || kind === "pickup_day"
          ? exists(
              orm
                .select({ one: sql`1` })
                .from(eventSteps)
                .where(
                  and(
                    eq(eventSteps.eventId, events.id),
                    eq(eventSteps.kind, "food_pickup"),
                    eq(eventSteps.status, "done"),
                  ),
                ),
            )
          : undefined,
      ),
    );
}

/**
 * The open task, if a reminder for its due date may be claimed for it: it is live and
 * open, due that day, on a live active event, in a channel that is managed and active, in
 * a guild with reminders on.
 */
export function remindableTask(
  orm: BotDb,
  taskId: SQLWrapper | string,
  dueDate: string,
) {
  return orm
    .select({ id: tasks.id, dueDate: tasks.dueDate })
    .from(tasks)
    .innerJoin(
      events,
      and(eq(events.id, tasks.eventId), eq(events.guildId, tasks.guildId)),
    )
    .innerJoin(
      managedChannels,
      and(
        eq(managedChannels.guildId, events.guildId),
        eq(managedChannels.channelId, events.channelId),
      ),
    )
    .innerJoin(guildConfig, eq(guildConfig.guildId, tasks.guildId))
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.dueDate, dueDate),
        eq(tasks.status, "open"),
        isNull(tasks.deletedAt),
        eq(events.status, "active"),
        isNull(events.deletedAt),
        eq(managedChannels.status, "active"),
        eq(guildConfig.remindersEnabled, true),
      ),
    );
}
