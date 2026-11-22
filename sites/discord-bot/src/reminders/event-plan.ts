/**
 * Plans the event workflow reminders: the countdown pings before an event, and the two
 * Food pickup reminders. Each is one message in the event's post, claimed in
 * `event_reminder_log` under the guild's local date it is for.
 *
 * Unlike task reminders, nothing here goes out late. Each ping is only worth sending on
 * its own day, so one whose day has passed is never sent, even for an event made after
 * it. A claim on one that was left by a crashed run is closed as skipped.
 */

import type {
  EventReminderCandidate,
  EventReminderKind,
  EventStepKind,
} from "../db/types.ts";
import {
  daysBetween,
  parseIsoDate,
  todayInZone,
  type DateOnly,
} from "../lib/dates.ts";
import { STALE_CLAIM_MS } from "./plan.ts";

export interface EventReminderRef {
  readonly eventId: string;
  readonly kind: EventReminderKind;
  readonly reminderDate: DateOnly;
}

export interface PlannedEventReminder {
  readonly ref: EventReminderRef;
  readonly threadId: string;
}

export interface EventReminderPlan {
  /** Reminders to claim and send today, soonest event first. */
  readonly sends: PlannedEventReminder[];
  /**
   * Stale claims on reminders that will not go out, to be recorded as skipped: an earlier
   * day's, one whose condition no longer holds, or any on an event with no post.
   */
  readonly skips: EventReminderRef[];
  /** Reminders due today held by a claim too recent to take over. */
  readonly freshClaims: EventReminderRef[];
  /** Events with a reminder due whose post is known to be gone. */
  readonly missingThreadEventIds: string[];
}

export interface EventPlanInput {
  /** Today in the guild's time zone. Throws a RangeError if not a real date. */
  readonly today: DateOnly;
  /** The instant claim ages are measured from. Throws a RangeError if invalid. */
  readonly now: Date;
  /** One guild's candidates, as read. */
  readonly events: readonly EventReminderCandidate[];
}

function stepOf(event: EventReminderCandidate, kind: EventStepKind) {
  return event.steps.find((step) => step.kind === kind);
}

function stepDone(event: EventReminderCandidate, kind: EventStepKind): boolean {
  return stepOf(event, kind)?.status === "done";
}

export function assigneesOf(
  event: EventReminderCandidate,
  kind: EventStepKind,
): string[] {
  return [
    ...new Set(
      event.assignees
        .filter((assignee) => assignee.kind === kind)
        .map((assignee) => assignee.user_id),
    ),
  ];
}

/** The people on Food pickup, or null if it is not set up. */
export function pickupPeople(event: EventReminderCandidate): string[] | null {
  const people = assigneesOf(event, "food_pickup");
  return stepDone(event, "food_pickup") &&
    event.pickup_time !== null &&
    people.length > 0
    ? people
    : null;
}

/** Budget Sheet and Engage post, where they are open and nobody is on them. */
export function unassignedSteps(
  event: EventReminderCandidate,
): ("budget_sheet" | "engage_post")[] {
  return (["budget_sheet", "engage_post"] as const).filter(
    (kind) => !stepDone(event, kind) && assigneesOf(event, kind).length === 0,
  );
}

/** Whether Slides still needs doing: open and not marked not needed. */
function slidesWanted(event: EventReminderCandidate): boolean {
  const slides = stepOf(event, "slides");
  return slides !== undefined && slides.status !== "done" && !slides.not_needed;
}

/** Days from the Saturday before the event to the event: 1 for Sunday, 0 for Saturday. */
function daysAfterSaturday(eventDate: DateOnly): number {
  return (new Date(eventDate).getUTCDay() + 1) % 7;
}

/** Whether today is a week after Engage post was done, in the guild's zone. */
function engagePictureLate(
  event: EventReminderCandidate,
  today: DateOnly,
): boolean {
  const engage = stepOf(event, "engage_post");
  if (
    engage?.status !== "done" ||
    engage.completed_at === null ||
    stepDone(event, "engage_picture")
  ) {
    return false;
  }
  const doneOn = todayInZone(new Date(engage.completed_at), event.timezone);
  return daysBetween(doneOn, today) === 7;
}

/** Days before the event that the first Food pickup reminder goes out. */
const PICKUP_REMINDER_DAYS_BEFORE = 2;

/** The kinds that go out today for this event, before looking at the log. */
export function kindsDueToday(
  event: EventReminderCandidate,
  today: DateOnly,
): EventReminderKind[] {
  const daysLeft = daysBetween(today, event.event_date);
  if (daysLeft < 0) {
    // Dated a week after Engage post, which can fall after the event.
    return engagePictureLate(event, today) ? ["engage_picture_late"] : [];
  }
  const budgetOpen = !stepDone(event, "budget_sheet");
  const engageOpen = !stepDone(event, "engage_post");
  const budgetPeople = assigneesOf(event, "budget_sheet").length;
  const engagePeople = assigneesOf(event, "engage_post").length;
  const slidesPeople = assigneesOf(event, "slides").length;
  const saturday = daysAfterSaturday(event.event_date);
  const due: [EventReminderKind, boolean][] = [
    ["steps_unassigned", daysLeft === 35 && unassignedSteps(event).length > 0],
    ["budget_due", daysLeft === 28 && budgetOpen && budgetPeople > 0],
    ["engage_due", daysLeft === 28 && engageOpen && engagePeople > 0],
    ["budget_overdue", daysLeft === 21 && budgetOpen],
    ["engage_overdue", daysLeft === 21 && engageOpen],
    ["engage_picture_late", engagePictureLate(event, today)],
    ["marketing_week", daysLeft === 7],
    [
      "slides_unassigned",
      daysLeft === 7 && slidesWanted(event) && slidesPeople === 0,
    ],
    [
      "pickup_unset",
      daysLeft === 7 &&
        (event.pickup_time === null ||
          assigneesOf(event, "food_pickup").length === 0),
    ],
    ["marketing_saturday", saturday !== 0 && daysLeft === saturday],
    ["slides_due", daysLeft === 2 && slidesWanted(event) && slidesPeople > 0],
    [
      "slides_tomorrow",
      daysLeft === 1 && slidesWanted(event) && slidesPeople > 0,
    ],
    [
      "pickup_before",
      daysLeft === PICKUP_REMINDER_DAYS_BEFORE && pickupPeople(event) !== null,
    ],
    ["pickup_day", daysLeft === 0 && pickupPeople(event) !== null],
    ["event_today", daysLeft === 0],
  ];
  return due.filter(([, send]) => send).map(([kind]) => kind);
}

/**
 * Decides what an event reminder run does for one guild. A reminder is open when it has no
 * log row for today, or only a stale claim. Sent and skipped rows are left alone, and a
 * fresh claim is reported so the run does not call itself complete.
 */
export function planEventReminders(input: EventPlanInput): EventReminderPlan {
  const { today, now } = input;
  if (parseIsoDate(today) === null || Number.isNaN(now.getTime())) {
    throw new RangeError("today and now must be valid");
  }
  const plan: EventReminderPlan = {
    sends: [],
    skips: [],
    freshClaims: [],
    missingThreadEventIds: [],
  };
  const isStale = (claimedAt: Date): boolean => {
    // new Date() so a value that got past the types cannot throw and end the run.
    const at = new Date(claimedAt).getTime();
    return Number.isNaN(at) || now.getTime() - at > STALE_CLAIM_MS;
  };

  for (const event of input.events) {
    const due = kindsDueToday(event, today);
    const threadId = event.thread_status === "active" ? event.thread_id : null;
    if (threadId === null) {
      if (event.thread_status === "missing" && due.length > 0) {
        plan.missingThreadEventIds.push(event.id);
      }
      // With no post, nothing claimed can go out, and none of these is sent late.
      for (const entry of event.log) {
        if (entry.state === "claimed" && isStale(entry.claimed_at)) {
          plan.skips.push({
            eventId: event.id,
            kind: entry.kind,
            reminderDate: entry.reminder_date,
          });
        }
      }
      continue;
    }
    for (const kind of due) {
      const row = event.log.find(
        (entry) => entry.kind === kind && entry.reminder_date === today,
      );
      const ref = { eventId: event.id, kind, reminderDate: today };
      if (row === undefined) {
        plan.sends.push({ ref, threadId });
      } else if (row.state === "claimed") {
        if (isStale(row.claimed_at)) {
          plan.sends.push({ ref, threadId });
        } else {
          plan.freshClaims.push(ref);
        }
      }
    }
    // A stale claim on anything not going out today: an earlier day's, or today's for a
    // ping whose condition no longer holds.
    for (const entry of event.log) {
      const sending = entry.reminder_date === today && due.includes(entry.kind);
      if (entry.state === "claimed" && !sending && isStale(entry.claimed_at)) {
        plan.skips.push({
          eventId: event.id,
          kind: entry.kind,
          reminderDate: entry.reminder_date,
        });
      }
    }
  }
  return plan;
}
