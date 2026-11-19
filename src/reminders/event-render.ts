/**
 * The messages for the event workflow reminders. Stored text reaches a message only
 * through `SafeText`, people and roles are shown only as mentions of their IDs, and the
 * only roles ever pinged are the guild's own, from its config row. A role that is not
 * set up is named in the message instead, and nobody is pinged for it.
 *
 * Each reminder is one message. Its size is bounded: an event name of at most 200
 * characters, at most 15 people on one step and two roles, which is well inside a
 * message.
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
import { pickupTimeText, stepName } from "../events/steps.ts";
import {
  chooseRoleToPingText,
  EVENTS_COMMITTEE_ROLE,
  EVENTS_DIRECTORS_ROLE,
  MARKETING_ROLE,
  type ClubRole,
} from "../handlers/club-roles.ts";
import { usableRoleId } from "../lib/permissions.ts";
import { assigneesOf, pickupPeople, unassignedSteps } from "./event-plan.ts";

const MAX_EVENT_NAME = 200;

const dateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
});

class EventRenderError extends Error {
  override readonly name = "EventRenderError";
}

export interface RenderedEventReminder {
  readonly content: SafeText;
  readonly mentionUserIds: readonly string[];
  /** Only ever roles from the guild's config row. */
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

function checked(rendered: RenderedEventReminder): RenderedEventReminder {
  if (!isWithinLimit(safeTextValue(rendered.content), DISCORD_LIMITS.content)) {
    throw new EventRenderError("Reminder too long for one message");
  }
  return rendered;
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

/** A role to ping, with its ID from the guild's config row. */
type Pinged = readonly [ClubRole, string | null];

/** The text, after a mention of each person and role it pings. */
function ping(
  event: EventReminderCandidate,
  text: SafeText,
  userIds: readonly string[],
  roles: readonly Pinged[] = [],
): RenderedEventReminder {
  const roleIds: string[] = [];
  let content = safe`${text}`;
  for (const [role, bound] of roles) {
    const roleId = usableRoleId(event.guild_id, bound);
    if (roleId === null) {
      content = safe`${content} ${chooseRoleToPingText(role)}`;
    } else {
      roleIds.push(roleId);
    }
  }
  const who = [
    ...userIds.map((userId) => userMention(userId)),
    ...roleIds.map((roleId) => roleMention(roleId)),
  ];
  return checked({
    content: who.reduceRight(
      (rest, mention) => safe`${mention} ${rest}`,
      content,
    ),
    mentionUserIds: userIds,
    mentionRoleIds: roleIds,
  });
}

/** What is missing from Food pickup. */
function pickupGap(event: EventReminderCandidate): SafeText {
  const nobody = assigneesOf(event, "food_pickup").length === 0;
  const noTime = event.pickup_time === null;
  if (nobody && noTime) {
    return safe`nobody is on it and no time is set`;
  }
  return nobody ? safe`nobody is on it` : safe`no time is set`;
}

/** Throws for a kind that is not set to go out for this event. */
export function renderEventReminder(
  kind: EventReminderKind,
  event: EventReminderCandidate,
  today: DateOnly,
): RenderedEventReminder {
  const name = eventName(event.name);
  const when = renderEventDay(today, event.event_date);
  const directors: Pinged = [
    EVENTS_DIRECTORS_ROLE,
    event.events_director_role_id,
  ];
  const marketing: Pinged = [MARKETING_ROLE, event.marketing_role_id];
  switch (kind) {
    case "pickup_before":
    case "pickup_day":
      return renderPickup(event, today);
    case "steps_unassigned": {
      const steps = unassignedSteps(event).map(stepName);
      if (steps.length === 0) {
        throw new EventRenderError("Every step has someone");
      }
      const list = steps.reduce((text, step) => safe`${text} or ${step}`);
      return ping(
        event,
        safe`Nobody is on ${list} for **${name}**.`,
        [],
        [directors],
      );
    }
    case "budget_due":
      return ping(
        event,
        safe`Budget Sheet for **${name}** is due.`,
        assigneesOf(event, "budget_sheet"),
      );
    case "engage_due":
      return ping(
        event,
        safe`Engage post for **${name}** is due.`,
        assigneesOf(event, "engage_post"),
      );
    case "budget_overdue":
      return ping(
        event,
        safe`Budget Sheet for **${name}** is overdue.`,
        assigneesOf(event, "budget_sheet"),
        [directors],
      );
    case "engage_overdue":
      return ping(
        event,
        safe`Engage post for **${name}** is overdue.`,
        assigneesOf(event, "engage_post"),
        [directors],
      );
    case "engage_picture_late":
      return ping(
        event,
        safe`Engage picture for **${name}** hasn't been added yet.`,
        [],
        [marketing],
      );
    case "marketing_week":
    case "marketing_saturday":
      return ping(event, safe`**${name}** is ${when}.`, [], [marketing]);
    case "slides_unassigned":
      return ping(
        event,
        safe`Nobody is on Slides for **${name}**.`,
        [],
        [directors],
      );
    case "pickup_unset":
      return ping(
        event,
        safe`Food pickup for **${name}** isn't set up: ${pickupGap(event)}.`,
        [],
        [directors],
      );
    case "slides_due":
    case "slides_tomorrow":
      return ping(
        event,
        safe`Slides for **${name}** are needed for the event ${when}.`,
        assigneesOf(event, "slides"),
      );
    case "event_today":
      return ping(
        event,
        safe`**${name}** is ${when}.`,
        [],
        [directors, [EVENTS_COMMITTEE_ROLE, event.events_committee_role_id]],
      );
    case "daily_steps":
      throw new EventRenderError("The daily list is no longer sent");
  }
}
