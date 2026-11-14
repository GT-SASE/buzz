/**
 * The rows the bot reads. They come from our own database through typed statements, so
 * they are cast to these shapes and not checked again.
 */

import type { DateOnly } from "../lib/dates.ts";
import type {
  PlanEvent,
  PlanTask,
  ReminderKind,
  ReminderLogRow,
  ReminderState,
} from "../reminders/plan.ts";

export type { ReminderKind, ReminderState };
export type ManagedChannelStatus = "active" | "unavailable" | "removed";
export type EventStatus = "active" | "closed";
export type ThreadStatus = "pending" | "active" | "missing";
export type TaskStatus = "open" | "done";
export type JobRunStatus = "running" | "succeeded" | "failed";
export type ConfigAuditAction = "role_bindings" | "settings";

export interface CappedList<T> {
  readonly rows: T[];
  /** True if the database held more rows than the cap, so this list is not all of them. */
  readonly truncated: boolean;
}

export const EVENT_STEP_KINDS = [
  "budget_sheet",
  "engage_post",
  "budget_approved",
  "food_pickup",
] as const;
export type EventStepKind = (typeof EVENT_STEP_KINDS)[number];

/** The steps people can be assigned to. Budget approved is marked by a role instead. */
export const ASSIGNABLE_STEP_KINDS = [
  "budget_sheet",
  "engage_post",
  "food_pickup",
] as const satisfies readonly EventStepKind[];
export type AssignableStepKind = (typeof ASSIGNABLE_STEP_KINDS)[number];

/** The steps marked done by hand. Food pickup is done once it has a time and people. */
export const COMPLETABLE_STEP_KINDS = [
  "budget_sheet",
  "engage_post",
  "budget_approved",
] as const satisfies readonly EventStepKind[];
export type CompletableStepKind = (typeof COMPLETABLE_STEP_KINDS)[number];

export const EVENT_REMINDER_KINDS = [
  "daily_steps",
  "pickup_before",
  "pickup_day",
] as const;
export type EventReminderKind = (typeof EVENT_REMINDER_KINDS)[number];

// Rows keep the column names, so they can be passed straight to authorize().

export interface GuildConfig {
  guild_id: string;
  /** Shown as Events Directors. */
  officer_role_id: string;
  admin_role_id: string;
  /** The four below are null until /setup is run with them. */
  eboard_role_id: string | null;
  /** Stored and shown. Decides nothing yet. */
  events_committee_role_id: string | null;
  treasury_role_id: string | null;
  marketing_role_id: string | null;
  timezone: string;
  reminders_enabled: boolean;
  version: number;
}

export interface ConfigChange {
  id: number;
  actor_id: string;
  action: ConfigAuditAction;
  old_values: Readonly<Record<string, unknown>> | null;
  new_values: Readonly<Record<string, unknown>>;
  version_after: number;
  created_at: string;
}

export interface ManagedChannel {
  guild_id: string;
  channel_id: string;
  status: ManagedChannelStatus;
}

export interface EventRow {
  id: string;
  guild_id: string;
  channel_id: string;
  name: string;
  event_date: DateOnly;
  thread_id: string | null;
  overview_message_id: string | null;
  status: EventStatus;
  thread_status: ThreadStatus;
  created_by: string;
  deleted_at: string | null;
  created_at: string;
}

export interface EventChoice {
  id: string;
  name: string;
  event_date: DateOnly;
  status: EventStatus;
}

export interface TaskRow {
  id: string;
  event_id: string;
  guild_id: string;
  assignee_id: string;
  description: string;
  due_date: DateOnly;
  status: TaskStatus;
  completed_at: string | null;
  created_by: string;
  deleted_at: string | null;
  /** The version to send back when editing, so a later edit is not overwritten. */
  updated_at: string;
}

export interface TaskChoice {
  id: string;
  description: string;
  due_date: DateOnly;
}

export interface LiveTaskChoice extends TaskChoice {
  status: TaskStatus;
}

export interface OpenTask {
  id: string;
  event_id: string;
  description: string;
  due_date: DateOnly;
  event_name: string;
}

export interface StaleClaim {
  task_id: string;
  kind: ReminderKind;
  due_date: DateOnly;
  claim_token: string;
  attempts: number;
  /** Attempts known not to have reached anyone. */
  refused_attempts: number;
  claimed_at: string;
}

/**
 * One task the reminder run may act on. `task`, `event` and `log` have the shapes
 * the planner takes.
 */
export interface ReminderCandidate {
  guild_id: string;
  timezone: string;
  assignee_id: string;
  description: string;
  event_name: string;
  /** The version this read saw, for a claim to compare with. */
  updated_at: string;
  task: PlanTask;
  event: PlanEvent;
  log: ReminderLogRow[];
}

export interface JobRun {
  id: string;
  job_name: string;
  status: JobRunStatus;
  started_at: string;
  heartbeat_at: string;
  finished_at: string | null;
  results: Readonly<Record<string, unknown>>;
  error: string | null;
}

export interface SetupDraft {
  guild_id: string;
  actor_id: string;
  officer_role_id: string;
  admin_role_id: string;
  eboard_role_id: string;
  events_committee_role_id: string;
  treasury_role_id: string;
  marketing_role_id: string;
  fingerprint: string;
  created_at: string;
}

export interface EventStep {
  event_id: string;
  kind: EventStepKind;
  status: TaskStatus;
  completed_at: string | null;
  completed_by: string | null;
  handoff_claimed_at: string | null;
  handoff_sent_at: string | null;
}

/** A live assignment. Removed ones are never returned. */
export interface StepAssignee {
  id: string;
  event_id: string;
  kind: AssignableStepKind;
  user_id: string;
  assigned_by: string;
  created_at: string;
}

/** One event's steps and the people on them, oldest assignment first. */
export interface EventWorkflow {
  event_id: string;
  event_date: DateOnly;
  /** `HH:MM` in the guild's timezone on the event's date, or null if not set. */
  pickup_time: string | null;
  /** The guild's time zone, which the pickup time is in. */
  timezone: string;
  /** One per kind, in the order of `EVENT_STEP_KINDS`. */
  steps: EventStep[];
  assignees: StepAssignee[];
}

/** One of a member's live assignments, for /mytasks. */
export interface UserStep {
  assignment_id: string;
  event_id: string;
  event_name: string;
  event_date: DateOnly;
  kind: AssignableStepKind;
  step_status: TaskStatus;
  /** `HH:MM`, or null if not set. */
  pickup_time: string | null;
}

export interface EventReminderLogRow {
  kind: EventReminderKind;
  reminder_date: DateOnly;
  state: ReminderState;
  claimed_at: Date;
}

/**
 * A live, active event on an active channel in a guild with reminders on, dated on or after
 * the date asked for, with what the event reminder run needs to plan its messages.
 */
export interface EventReminderCandidate {
  id: string;
  guild_id: string;
  name: string;
  event_date: DateOnly;
  thread_id: string | null;
  thread_status: ThreadStatus;
  created_by: string;
  /** `HH:MM`, or null if not set. */
  pickup_time: string | null;
  timezone: string;
  /** The Events Directors role, pinged for a step nobody is assigned to. */
  events_director_role_id: string;
  steps: { kind: EventStepKind; status: TaskStatus }[];
  /** Live assignments only, oldest first. */
  assignees: { kind: AssignableStepKind; user_id: string }[];
  /** Log rows dated on or after the date asked for. */
  log: EventReminderLogRow[];
}

export interface EventReminderStaleClaim {
  event_id: string;
  kind: EventReminderKind;
  reminder_date: DateOnly;
  claim_token: string;
  attempts: number;
  claimed_at: string;
}
