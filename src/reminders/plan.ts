import {
  daysBetween,
  parseIsoDate,
  todayInZone,
  type DateOnly,
} from "../lib/dates.ts";

/** Least urgent first. The later a kind appears, the more urgent it is. */
export const REMINDER_KINDS = [
  "three_days",
  "one_day",
  "due_day",
  "overdue",
] as const;

export type ReminderKind = (typeof REMINDER_KINDS)[number];

export type ReminderState = "claimed" | "sent" | "skipped";

/** Mirrors `maxDuration` in vercel.json for both functions; cron-endpoint.test.ts enforces it. */
export const FUNCTION_MAX_MS = 60_000;

/** A claim older than this was left behind by a run the platform has since stopped. */
export const STALE_CLAIM_MS = 2 * FUNCTION_MAX_MS;
/**
 * A reminder goes out without notifying anyone once this many sends, counting the one about
 * to start, may have reached Discord. A send known to have been refused does not count.
 */
export const MAX_ATTEMPTS_WITH_PING = 3;

const MS_PER_DAY = 86_400_000;
/**
 * When a schedule slot starts: the first cron in vercel.json, which cron-endpoint.test.ts
 * checks. `begin_job_run` is given the slot's start.
 */
export const SLOT_START_HOUR_UTC = 15;

/** When the schedule slot on this instant's UTC date starts, whether or not it has yet. */
export function dayRunStart(now: Date): number {
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    SLOT_START_HOUR_UTC,
  );
}

/** The start of the schedule slot this instant falls in. */
export function slotStart(now: Date): number {
  const today = dayRunStart(now);
  return today <= now.getTime() ? today : today - MS_PER_DAY;
}

/**
 * The guild's local date that a run plans for: the date in its zone when the run's slot
 * began, not when the run itself started. The 15:00 UTC run and the 17:00 UTC recovery
 * run of one slot then plan the same day everywhere. Taking each run's own date would
 * put the recovery run on the next local day in zones where midnight falls between the
 * two, such as Asia/Singapore, and lose that slot's reminders. Throws a RangeError for a
 * zone the runtime does not know.
 */
export function slotToday(now: Date, timeZone: string): DateOnly {
  return todayInZone(new Date(slotStart(now)), timeZone);
}

/** The number of days before the due date at which each kind becomes due. */
export const OPENS_AT_DAYS_BEFORE: Record<ReminderKind, number> = {
  three_days: 3,
  one_day: 1,
  due_day: 0,
  overdue: -1,
};

/**
 * Dates must come from `parseIsoDate` at the database read, with any row it
 * refuses left out and logged. Never cast a value to DateOnly.
 */
export interface PlanTask {
  id: string;
  eventId: string;
  dueDate: DateOnly;
  status: "open" | "done";
  deleted: boolean;
}

export interface PlanEvent {
  id: string;
  threadId: string | null;
  status: "active" | "closed";
  threadStatus: "pending" | "active" | "missing";
  deleted: boolean;
  /** False when the event's forum is removed from the managed list or is gone. */
  forumManaged: boolean;
}

/**
 * Keyed by task, due date and kind, so moving a deadline re-arms its reminders
 * while moving it back finds the history it had. Convert `dueDate` with
 * `parseIsoDate` at the database read, as for PlanTask.
 */
export interface ReminderLogRow {
  taskId: string;
  dueDate: DateOnly;
  kind: ReminderKind;
  state: ReminderState;
  /** An unreadable value counts as stale: a duplicate beats a missed deadline. */
  claimedAt: Date;
}

export interface PlanInput {
  /** Today in the guild's time zone. Throws a RangeError if not a real date. */
  today: DateOnly;
  /** The instant claim ages are measured from. Throws a RangeError if invalid. */
  now: Date;
  remindersEnabled: boolean;
  events: readonly PlanEvent[];
  tasks: readonly PlanTask[];
  log: readonly ReminderLogRow[];
}

/**
 * A kind can go out late after a missed run or a moved deadline, so a message
 * must state the real due date and days left, worked out from `dueDate`, and
 * never infer them from the kind's name.
 */
export interface ReminderRef {
  taskId: string;
  dueDate: DateOnly;
  kind: ReminderKind;
}

export interface EventReminders {
  eventId: string;
  threadId: string;
  reminders: ReminderRef[];
}

export interface FreshClaim {
  eventId: string;
  ref: ReminderRef;
}

export interface ReminderPlan {
  /** Reminders to claim and send, grouped per event. */
  events: EventReminders[];
  /** Kinds a later reminder has replaced, to be recorded as skipped. */
  skips: ReminderRef[];
  /**
   * Reminders that would go out now but for a claim too recent to take over. A run's lock
   * keeps other runs out, so that claim was left by a run that has ended: the reminder has
   * not been dealt with, and the run should not report that all went out.
   */
  freshClaims: FreshClaim[];
  /**
   * Events with a reminder due whose post is known to be gone. Nothing is sent for these
   * until someone links a new post, so the runner should say so on every run.
   */
  missingThreadEventIds: string[];
  /**
   * Remindable tasks left out because their due date is not a real date, so one
   * bad row cannot stop the run. The runner should log these.
   */
  invalidTaskIds: string[];
}

function threadIdIfRemindable(event: PlanEvent): string | null {
  const remindable =
    event.forumManaged &&
    !event.deleted &&
    event.status === "active" &&
    event.threadStatus === "active";
  return remindable ? event.threadId : null;
}

function isThreadMissing(event: PlanEvent): boolean {
  return (
    event.forumManaged &&
    !event.deleted &&
    event.status === "active" &&
    event.threadStatus === "missing"
  );
}

function logKey(taskId: string, dueDate: DateOnly, kind: ReminderKind): string {
  return `${taskId}:${dueDate}:${kind}`;
}

/**
 * Decides what a reminder run should do. A task only ever sends the most urgent
 * kind whose day has arrived, and any earlier kind still open is skipped, so a
 * missed run produces one reminder rather than a burst of out-of-date ones.
 *
 * A kind is open when it has no log row for the task's current due date, or only
 * a stale claim. Sent, skipped and freshly claimed kinds are left as they are, and
 * rows for any other due date are ignored.
 *
 * Tasks that cannot be reminded about produce no rows at all. Nothing is used up
 * while a forum is unmanaged, so re-adding it resumes under these same rules.
 */
export function planReminders(input: PlanInput): ReminderPlan {
  const plan: ReminderPlan = {
    events: [],
    skips: [],
    freshClaims: [],
    missingThreadEventIds: [],
    invalidTaskIds: [],
  };
  if (!input.remindersEnabled) {
    return plan;
  }
  // These affect every task, and without them the run would quietly send nothing.
  if (parseIsoDate(input.today) === null || Number.isNaN(input.now.getTime())) {
    throw new RangeError("today and now must be valid");
  }

  const eventsById = new Map(input.events.map((event) => [event.id, event]));
  const logByKey = new Map(
    input.log.map((row) => [logKey(row.taskId, row.dueDate, row.kind), row]),
  );
  const groups = new Map<string, EventReminders>();

  const claimState = (
    task: PlanTask,
    kind: ReminderKind,
  ): "open" | "fresh_claim" | "closed" => {
    const row = logByKey.get(logKey(task.id, task.dueDate, kind));
    if (row === undefined) {
      return "open";
    }
    if (row.state !== "claimed") {
      return "closed";
    }
    // new Date() so a value that got past the types cannot throw and end the run.
    const claimedAt = new Date(row.claimedAt).getTime();
    return Number.isNaN(claimedAt) ||
      input.now.getTime() - claimedAt > STALE_CLAIM_MS
      ? "open"
      : "fresh_claim";
  };
  const missing = new Set<string>();

  for (const task of input.tasks) {
    const event = eventsById.get(task.eventId);
    if (event === undefined || task.status !== "open" || task.deleted) {
      continue;
    }
    const threadId = threadIdIfRemindable(event);
    if (threadId === null && !isThreadMissing(event)) {
      continue;
    }
    if (parseIsoDate(task.dueDate) === null) {
      if (threadId !== null) {
        plan.invalidTaskIds.push(task.id);
      }
      continue;
    }

    const daysLeft = daysBetween(input.today, task.dueDate);
    const reached = REMINDER_KINDS.filter(
      (kind) => daysLeft <= OPENS_AT_DAYS_BEFORE[kind],
    );
    const mostUrgent = reached.at(-1);

    if (threadId === null) {
      if (mostUrgent !== undefined && !missing.has(event.id)) {
        missing.add(event.id);
        plan.missingThreadEventIds.push(event.id);
      }
      continue;
    }

    for (const kind of reached) {
      const state = claimState(task, kind);
      if (state === "closed") {
        continue;
      }
      const ref = { taskId: task.id, dueDate: task.dueDate, kind };
      if (state === "fresh_claim") {
        if (kind === mostUrgent) {
          plan.freshClaims.push({ eventId: event.id, ref });
        }
        continue;
      }
      if (kind !== mostUrgent) {
        plan.skips.push(ref);
        continue;
      }
      let group = groups.get(event.id);
      if (group === undefined) {
        group = { eventId: event.id, threadId, reminders: [] };
        groups.set(event.id, group);
        plan.events.push(group);
      }
      group.reminders.push(ref);
    }
  }

  return plan;
}
