/**
 * The messages for the event workflow reminders. Stored text reaches a message only
 * through `SafeText`, people and roles are shown only as mentions of their IDs, and the
 * only role ever pinged is the guild's own Events Directors role from its config row.
 *
 * Each reminder is one message. Its size is bounded: an event name of at most 200
 * characters, at most 10 people on each of two steps, or at most 15 on
 * Food pickup, which is well inside a message.
 */

import {
  DISCORD_LIMITS,
  escapeUserText,
  isWithinLimit,
  roleMention,
  safe,
  safeTextValue,
  truncateUserText,
  userMention,
  type SafeText,
} from "../discord/safe-text.ts";
import type { EventReminderCandidate, EventReminderKind } from "../db/types.ts";
import { daysBetween, type DateOnly } from "../lib/dates.ts";
import { pickupTimeText } from "../events/steps.ts";
import { openSteps, pickupPeople, type OpenStep } from "./event-plan.ts";

const MAX_EVENT_NAME = 200;

const dateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
});

export class EventRenderError extends Error {
  override readonly name = "EventRenderError";
}

export interface RenderedEventReminder {
  readonly content: SafeText;
  readonly mentionUserIds: readonly string[];
  /** Only ever the guild's Events Directors role, for a step nobody is on. */
  readonly mentionRoleIds: readonly string[];
}

function eventName(name: string): SafeText {
  try {
    return truncateUserText(name, MAX_EVENT_NAME);
  } catch {
    return safe`(an event with no readable name)`;
  }
}

/** The event's day relative to today, worked out from the dates and never from a kind. */
export function renderEventDay(today: DateOnly, eventDate: DateOnly): SafeText {
  const days = daysBetween(today, eventDate);
  const date = escapeUserText(dateFormat.format(new Date(eventDate)));
  if (days === 0) {
    return safe`today, ${date}`;
  }
  const count = escapeUserText(String(days));
  return days === 1
    ? safe`tomorrow, ${date}`
    : safe`on ${date}, in ${count} days`;
}

function mentions(userIds: readonly string[]): SafeText {
  return (
    userIds.reduce<SafeText | null>(
      (text, userId) =>
        text === null
          ? userMention(userId)
          : safe`${text} ${userMention(userId)}`,
      null,
    ) ?? safe``
  );
}

function stepLine(step: OpenStep, rolePing: SafeText): SafeText {
  switch (step.kind) {
    case "budget_sheet":
    case "engage_post": {
      const label =
        step.kind === "budget_sheet" ? safe`Budget Sheet` : safe`Engage post`;
      return step.assigneeIds.length === 0
        ? safe`- ${label}: nobody is on it yet, ${rolePing} please assign someone with /event assign`
        : safe`- ${label}: ${mentions(step.assigneeIds)}`;
    }
    case "budget_approved":
      return safe`- Budget approved: waiting for approval`;
  }
}

function checked(rendered: RenderedEventReminder): RenderedEventReminder {
  if (!isWithinLimit(safeTextValue(rendered.content), DISCORD_LIMITS.content)) {
    throw new EventRenderError("Reminder too long for one message");
  }
  return rendered;
}

/** The daily list of unfinished steps. Throws if every step is done. */
export function renderDailySteps(
  event: EventReminderCandidate,
  today: DateOnly,
): RenderedEventReminder {
  const steps = openSteps(event);
  if (steps.length === 0) {
    throw new EventRenderError("Nothing left to do");
  }
  const roleId = event.events_director_role_id;
  const rolePing = roleMention(roleId);
  const lines = steps.map((step) => stepLine(step, rolePing));
  const users = new Set<string>();
  let pingsRole = false;
  for (const step of steps) {
    if (step.kind === "budget_sheet" || step.kind === "engage_post") {
      step.assigneeIds.forEach((userId) => users.add(userId));
      pingsRole ||= step.assigneeIds.length === 0;
    }
  }
  const body = lines.reduce((text, line) => safe`${text}\n${line}`);
  return checked({
    content: safe`**Still to do for ${eventName(event.name)}** (${renderEventDay(today, event.event_date)})\n${body}`,
    mentionUserIds: [...users],
    mentionRoleIds: pingsRole ? [roleId] : [],
  });
}

/** A Food pickup reminder. Throws if Food pickup is not set up. */
export function renderPickup(
  event: EventReminderCandidate,
  today: DateOnly,
): RenderedEventReminder {
  const people = pickupPeople(event);
  if (people === null || event.pickup_time === null) {
    throw new EventRenderError("Food pickup is not set up");
  }
  const time = pickupTimeText(
    event.event_date,
    event.pickup_time,
    event.timezone,
  );
  return checked({
    content: safe`**Food pickup for ${eventName(event.name)}**\n${mentions(people)} you are on food pickup at ${time}, ${renderEventDay(today, event.event_date)}.`,
    mentionUserIds: people,
    mentionRoleIds: [],
  });
}

export function renderEventReminder(
  kind: EventReminderKind,
  event: EventReminderCandidate,
  today: DateOnly,
): RenderedEventReminder {
  return kind === "daily_steps"
    ? renderDailySteps(event, today)
    : renderPickup(event, today);
}
