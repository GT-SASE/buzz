/**
 * Plans the event workflow reminders: the daily list of an event's unfinished steps, and
 * the two Food pickup reminders. Each is one message in the event's post, claimed in
 * `event_reminder_log` under the guild's local date it is for.
 *
 * Unlike task reminders, nothing here goes out late. A day's list is only worth sending on
 * that day, and a pickup reminder only on its own day, so a reminder whose day has passed
 * is never sent. A claim on one that was left by a crashed run is closed as skipped.
 */

import type { EventReminderCandidate, EventReminderKind } from "../db/types.ts";
import { daysBetween, parseIsoDate, type DateOnly } from "../lib/dates.ts";
import { STALE_CLAIM_MS } from "./plan.ts";

/** One unfinished step, as the daily list shows it. */
export type OpenStep =
  | {
      readonly kind: "budget_sheet" | "engage_post";
      /** Empty when nobody is on the step, and the Events Directors role is asked instead. */
      readonly assigneeIds: readonly string[];
    }
  | { readonly kind: "budget_approved" };

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
   * day's, one whose list has since been finished, or any on an event with no post.
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

function stepDone(event: EventReminderCandidate, kind: string): boolean {
  return event.steps.some(
    (step) => step.kind === kind && step.status === "done",
  );
}

function assigneesOf(event: EventReminderCandidate, kind: string): string[] {
  return [
    ...new Set(
      event.assignees
        .filter((assignee) => assignee.kind === kind)
        .map((assignee) => assignee.user_id),
    ),
  ];
}

/**
 * The event's unfinished steps, in the club's order. Food pickup is never listed: it has
 * its own reminders once it is set up. Empty when everything else is done.
 */
export function openSteps(event: EventReminderCandidate): OpenStep[] {
  const steps: OpenStep[] = [];
  for (const kind of ["budget_sheet", "engage_post"] as const) {
    if (!stepDone(event, kind)) {
      steps.push({ kind, assigneeIds: assigneesOf(event, kind) });
    }
  }
  if (!stepDone(event, "budget_approved")) {
    steps.push({ kind: "budget_approved" });
  }
  return steps;
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

/** Days before the event that the first Food pickup reminder goes out. */
export const PICKUP_REMINDER_DAYS_BEFORE = 2;

/** The kinds that go out today for this event, before looking at the log. */
export function kindsDueToday(
  event: EventReminderCandidate,
  today: DateOnly,
): EventReminderKind[] {
  const daysLeft = daysBetween(today, event.event_date);
  if (daysLeft < 0) {
    return [];
  }
  const kinds: EventReminderKind[] = [];
  if (openSteps(event).length > 0) {
    kinds.push("daily_steps");
  }
  if (pickupPeople(event) !== null) {
    if (daysLeft === PICKUP_REMINDER_DAYS_BEFORE) {
      kinds.push("pickup_two_days");
    } else if (daysLeft === 0) {
      kinds.push("pickup_day");
    }
  }
  return kinds;
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
    // list that has since been finished.
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
