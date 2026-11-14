/**
 * The per-event workflow: Budget Sheet, Engage post, Budget approved and Food pickup, the
 * people on each, the one-time ping that follows a finished step, and the claim cycle of
 * the event reminders. Every write is a database function, which locks the step, checks
 * the event and enforces the limits, so nothing here can be raced past.
 *
 * A write on an event that is unknown, in another guild or deleted fails as `not_found`,
 * and on a closed event as `parent_unavailable`. Who may make a write is decided before
 * calling it: these functions check only that the rows allow it.
 */

import type { DateOnly } from "../lib/dates.ts";
import { STALE_CLAIM_MS } from "../reminders/plan.ts";
import type { DbClient } from "./client.ts";
import { failure, refused, type DbResult } from "./errors.ts";
import {
  callFunction,
  capped,
  firstRow,
  nullAsNotFound,
  query,
  sql,
} from "./internal.ts";
import {
  ASSIGNABLE_STEP_KINDS,
  EVENT_STEP_KINDS,
  type AssignableStepKind,
  type CappedList,
  type CompletableStepKind,
  type EventReminderCandidate,
  type EventReminderKind,
  type EventReminderStaleClaim,
  type EventStatus,
  type EventStep,
  type EventWorkflow,
  type ReminderState,
  type StepAssignee,
  type TaskStatus,
  type ThreadStatus,
  type UserStep,
} from "./types.ts";
import { MAX_ID_LIST, isDbDate, isPickupTime } from "./validate.ts";

/** Enforced by assign_event_step: see the baseline migration. */
export const MAX_ASSIGNEES_PER_STEP = 10;
/** Enforced by assign_event_step, for Food pickup alone. */
export const MAX_FOOD_PICKUP_ASSIGNEES = 15;

const MAX_USER_STEPS = 100;

/** An event's steps, as a JSON array. Use with the event as `e`. */
const STEPS_OF_EVENT = sql`coalesce((
  select json_agg(json_build_object('event_id', s.event_id, 'kind', s.kind,
    'status', s.status, 'completed_at', s.completed_at,
    'completed_by', s.completed_by, 'handoff_claimed_at', s.handoff_claimed_at,
    'handoff_sent_at', s.handoff_sent_at))
  from event_steps s where s.event_id = e.id and s.guild_id = e.guild_id
), '[]'::json)`;

/** The kind and status of each of an event's steps, as a JSON array. */
const STEP_STATUSES_OF_EVENT = sql`coalesce((
  select json_agg(json_build_object('kind', s.kind, 'status', s.status))
  from event_steps s where s.event_id = e.id and s.guild_id = e.guild_id
), '[]'::json)`;

/** An event's live assignments, oldest first, as a JSON array. */
const LIVE_ASSIGNEES_OF_EVENT = sql`coalesce((
  select json_agg(json_build_object('id', a.id, 'event_id', a.event_id,
    'kind', a.kind, 'user_id', a.user_id, 'assigned_by', a.assigned_by,
    'created_at', a.created_at) order by a.created_at, a.id)
  from event_step_assignees a
  where a.event_id = e.id and a.guild_id = e.guild_id and a.removed_at is null
), '[]'::json)`;

const MAX_REMINDER_EVENTS = 500;
const MAX_STALE_CLAIMS = 500;

export interface EventStepKey {
  guildId: string;
  eventId: string;
}

/** The step functions return null when there is no live event with that ID in that guild. */
function liveEventBoolean(result: DbResult<boolean | null>): DbResult<boolean> {
  return nullAsNotFound(result);
}

/** A time of day as Postgres gives it, `17:30:00`, as `HH:MM`. */
function hoursAndMinutes(time: string | null): string | null {
  return time === null ? null : time.slice(0, 5);
}

/**
 * The steps and live assignments of each live event named, in this guild. An event that
 * is unknown, deleted or another guild's is left out. At most `MAX_ID_LIST` IDs.
 */
export async function listEventWorkflows(
  db: DbClient,
  { guildId, eventIds }: { guildId: string; eventIds: readonly string[] },
): Promise<DbResult<EventWorkflow[]>> {
  if (eventIds.length === 0) {
    return { ok: true, value: [] };
  }
  const read = await query<{
    id: string;
    pickup_time: string | null;
    steps: EventStep[];
    assignees: StepAssignee[];
  }>(
    db,
    sql`select e.id, e.pickup_time, ${STEPS_OF_EVENT} as steps,
      ${LIVE_ASSIGNEES_OF_EVENT} as assignees
    from events e
    where e.guild_id = ${guildId} and e.id = any(${[...eventIds]}::uuid[])
      and e.deleted_at is null
    order by e.id limit ${MAX_ID_LIST}`,
  );
  return read.ok
    ? {
        ok: true,
        value: read.value.map((row) => ({
          event_id: row.id,
          pickup_time: hoursAndMinutes(row.pickup_time),
          // Every event has one row per kind, which the baseline adds with the event.
          steps: EVENT_STEP_KINDS.flatMap((kind) =>
            row.steps.filter((step) => step.kind === kind),
          ),
          assignees: row.assignees,
        })),
      }
    : read;
}

/** One live event's steps and live assignments, or null if there is no such event. */
export async function getEventWorkflow(
  db: DbClient,
  key: EventStepKey,
): Promise<DbResult<EventWorkflow | null>> {
  const list = await listEventWorkflows(db, {
    guildId: key.guildId,
    eventIds: [key.eventId],
  });
  if (!list.ok) {
    return list;
  }
  const [row, ...others] = list.value;
  return others.length > 0
    ? failure("unexpected")
    : { ok: true, value: row ?? null };
}

export interface StepAssignment extends EventStepKey {
  kind: AssignableStepKind;
  userId: string;
  actorId: string;
}

/**
 * Puts a member on Budget Sheet, Engage post or Food pickup. True if this call added them,
 * false if they were on it already. Fails as `step_assignee_limit` once the step has
 * `MAX_ASSIGNEES_PER_STEP` people (`MAX_FOOD_PICKUP_ASSIGNEES` for Food pickup). Food pickup
 * can be set up at any time: it does not wait for the budget.
 */
export async function assignEventStep(
  db: DbClient,
  input: StepAssignment,
): Promise<DbResult<boolean>> {
  return liveEventBoolean(
    await callFunction<boolean | null>(
      db,
      sql`select public.assign_event_step(p_event_id => ${input.eventId},
        p_guild_id => ${input.guildId},
        p_kind => ${input.kind},
        p_user_id => ${input.userId},
        p_actor_id => ${input.actorId}) as value`,
    ),
  );
}

/**
 * Takes a member off a step. The assignment is kept, marked removed. True if this call
 * removed them, false if they were not on it. Taking the last person off Food pickup
 * reopens it.
 */
export async function unassignEventStep(
  db: DbClient,
  input: StepAssignment,
): Promise<DbResult<boolean>> {
  return liveEventBoolean(
    await callFunction<boolean | null>(
      db,
      sql`select public.unassign_event_step(p_event_id => ${input.eventId},
        p_guild_id => ${input.guildId},
        p_kind => ${input.kind},
        p_user_id => ${input.userId},
        p_actor_id => ${input.actorId}) as value`,
    ),
  );
}

/**
 * Marks Budget Sheet, Engage post or Budget approved done. True if this call did it, and
 * only then should the caller go on to `claimStepHandoff`. False if it was done already.
 */
export async function completeEventStep(
  db: DbClient,
  input: EventStepKey & { kind: CompletableStepKind; actorId: string },
): Promise<DbResult<boolean>> {
  return liveEventBoolean(
    await callFunction<boolean | null>(
      db,
      sql`select public.complete_event_step(p_event_id => ${input.eventId},
        p_guild_id => ${input.guildId},
        p_kind => ${input.kind},
        p_actor_id => ${input.actorId}) as value`,
    ),
  );
}

export type HandoffKey = EventStepKey & { kind: CompletableStepKind };

/**
 * The right to send the message that follows a finished step. True for exactly one caller
 * per step, ever, so the role is pinged at most once. A caller that then fails to send
 * leaves the ping unsent for good. False if the step is not done, the hand-off is taken,
 * or the event is not live.
 */
export async function claimStepHandoff(
  db: DbClient,
  key: HandoffKey,
): Promise<DbResult<boolean>> {
  return callFunction<boolean>(
    db,
    sql`select public.claim_step_handoff(p_event_id => ${key.eventId},
      p_guild_id => ${key.guildId},
      p_kind => ${key.kind}) as value`,
  );
}

/** For after the claimed hand-off went out. False if it was not claimed or is recorded. */
export async function markStepHandoffSent(
  db: DbClient,
  key: HandoffKey,
): Promise<DbResult<boolean>> {
  return callFunction<boolean>(
    db,
    sql`select public.mark_step_handoff_sent(p_event_id => ${key.eventId},
      p_guild_id => ${key.guildId},
      p_kind => ${key.kind}) as value`,
  );
}

/**
 * Sets the pickup time, as `HH:MM` on a 24-hour clock, local to the guild on the event's
 * date, at any time. Returns whether Food pickup is now done, which also needs at least one
 * person on it.
 */
export async function setEventPickupTime(
  db: DbClient,
  input: EventStepKey & { pickupTime: string; actorId: string },
): Promise<DbResult<boolean>> {
  if (!isPickupTime(input.pickupTime)) {
    return refused();
  }
  return liveEventBoolean(
    await callFunction<boolean | null>(
      db,
      sql`select public.set_event_pickup_time(p_event_id => ${input.eventId},
        p_guild_id => ${input.guildId},
        p_pickup_time => ${input.pickupTime},
        p_actor_id => ${input.actorId}) as value`,
    ),
  );
}

const KIND_ORDER: readonly AssignableStepKind[] = ASSIGNABLE_STEP_KINDS;

/**
 * For /mytasks: a member's open Budget Sheet and Engage post steps, and their Food pickups
 * from `today` on, on live active events in one guild. Events from `today` on come first,
 * soonest first, then the open steps of events already past, most recent first.
 *
 * Done steps and past pickups are left out by the query, and the cap keeps the events from
 * `today` on before any that are past, so a member with many old assignments still sees
 * what is coming up.
 */
export async function listOpenStepsForUser(
  db: DbClient,
  {
    guildId,
    userId,
    today,
  }: { guildId: string; userId: string; today: DateOnly },
): Promise<DbResult<CappedList<UserStep>>> {
  if (!isDbDate(today)) {
    return refused();
  }
  const list = capped(
    await query<{
      assignment_id: string;
      kind: AssignableStepKind;
      event_id: string;
      event_name: string;
      event_date: DateOnly;
      pickup_time: string | null;
      step_status: TaskStatus;
    }>(
      db,
      sql`select a.id as assignment_id, a.kind, e.id as event_id,
        e.name as event_name, e.event_date, e.pickup_time, s.status as step_status
      from event_step_assignees a
      join events e on e.id = a.event_id and e.guild_id = a.guild_id
      join event_steps s
        on s.event_id = e.id and s.guild_id = e.guild_id and s.kind = a.kind
      where a.guild_id = ${guildId} and a.user_id = ${userId} and a.removed_at is null
        and e.status = 'active' and e.deleted_at is null
        and (
          (a.kind = 'food_pickup' and e.event_date >= ${today})
          or (a.kind <> 'food_pickup' and s.status = 'open')
        )
      order by e.event_date < ${today}, abs(e.event_date - ${today}::date), a.kind,
        e.id, a.id
      limit ${MAX_USER_STEPS + 1}`,
    ),
    MAX_USER_STEPS,
  );
  if (!list.ok) {
    return list;
  }
  const rows = list.value.rows
    .map((step) => ({
      ...step,
      pickup_time: hoursAndMinutes(step.pickup_time),
    }))
    .sort((a, b) => {
      const aPast = a.event_date < today;
      const bPast = b.event_date < today;
      if (aPast !== bPast) {
        return aPast ? 1 : -1;
      }
      if (a.event_date !== b.event_date) {
        // Upcoming soonest first, and past ones most recent first, as the cap keeps them.
        return a.event_date < b.event_date === aPast ? 1 : -1;
      }
      return (
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        a.event_id.localeCompare(b.event_id)
      );
    });
  return { ok: true, value: { ...list.value, rows } };
}

/**
 * Every live active event dated `fromDate` or later, across all guilds, whose channel is
 * active and whose guild has reminders on, with its steps, live assignments and the log
 * rows dated `fromDate` or later. Pass a date early enough for every timezone, such as
 * yesterday in UTC, and decide per guild which events are due. Soonest first.
 */
export async function listEventReminderCandidates(
  db: DbClient,
  { fromDate }: { fromDate: DateOnly },
): Promise<DbResult<CappedList<EventReminderCandidate>>> {
  if (!isDbDate(fromDate)) {
    return refused();
  }
  const read = capped(
    await query<
      Omit<EventReminderCandidate, "log"> & {
        log: (Omit<EventReminderCandidate["log"][number], "claimed_at"> & {
          claimed_at: string;
        })[];
      }
    >(
      db,
      sql`select e.id, e.guild_id, e.name, e.event_date, e.thread_id, e.thread_status,
        e.created_by, e.pickup_time, g.timezone,
        g.officer_role_id as events_director_role_id,
        ${STEP_STATUSES_OF_EVENT} as steps,
        coalesce((
          select json_agg(json_build_object('kind', a.kind, 'user_id', a.user_id)
            order by a.created_at, a.id)
          from event_step_assignees a
          where a.event_id = e.id and a.guild_id = e.guild_id and a.removed_at is null
        ), '[]'::json) as assignees,
        coalesce((
          select json_agg(json_build_object('kind', l.kind,
            'reminder_date', l.reminder_date, 'state', l.state,
            'claimed_at', l.claimed_at))
          from event_reminder_log l
          where l.event_id = e.id and l.reminder_date >= ${fromDate}
        ), '[]'::json) as log
      from events e
      join managed_channels c
        on c.guild_id = e.guild_id and c.channel_id = e.channel_id
      join guild_config g on g.guild_id = e.guild_id
      where e.status = 'active' and e.deleted_at is null
        and e.event_date >= ${fromDate}
        and c.status = 'active' and g.reminders_enabled
      order by e.event_date, e.id limit ${MAX_REMINDER_EVENTS + 1}`,
    ),
    MAX_REMINDER_EVENTS,
  );
  if (!read.ok) {
    return read;
  }
  return {
    ok: true,
    value: {
      ...read.value,
      rows: read.value.rows.map((event) => ({
        ...event,
        pickup_time: hoursAndMinutes(event.pickup_time),
        log: event.log.map((log) => ({
          ...log,
          claimed_at: new Date(log.claimed_at),
        })),
      })),
    },
  };
}

/** Event reminder claims left unfinished since before the cutoff, oldest first. */
export async function listStaleEventReminderClaims(
  db: DbClient,
  { claimedBefore }: { claimedBefore: Date },
): Promise<DbResult<CappedList<EventReminderStaleClaim>>> {
  return capped(
    await query<EventReminderStaleClaim>(
      db,
      sql`select event_id, kind, reminder_date, claim_token, attempts, claimed_at
      from event_reminder_log
      where state = 'claimed' and claimed_at < ${claimedBefore.toISOString()}
      order by claimed_at, event_id, kind, reminder_date
      limit ${MAX_STALE_CLAIMS + 1}`,
    ),
    MAX_STALE_CLAIMS,
  );
}

/**
 * One event reminder. `reminderDate` is the local date the message is for: the day itself
 * for `daily_steps`, two days before the event for `pickup_two_days`, and the event's date
 * for `pickup_day`. The claim refuses any other date.
 */
export interface EventReminderKey {
  eventId: string;
  kind: EventReminderKind;
  reminderDate: DateOnly;
}

/**
 * Returns a claim token, or null if someone else holds it, or the reminder is not due:
 * the event is not live and active, its channel or the guild's reminders are off, the date
 * does not suit the kind, or a pickup reminder's Food pickup is not set up.
 */
export async function claimEventReminder(
  db: DbClient,
  key: EventReminderKey,
): Promise<DbResult<string | null>> {
  if (!isDbDate(key.reminderDate)) {
    return refused();
  }
  return callFunction<string | null>(
    db,
    sql`select public.claim_event_reminder(p_event_id => ${key.eventId},
      p_kind => ${key.kind},
      p_reminder_date => ${key.reminderDate}) as value`,
  );
}

/** Takes over a stale claim given its last token. Null if that is not possible. */
export async function reclaimEventReminder(
  db: DbClient,
  key: EventReminderKey & { claimToken: string },
): Promise<DbResult<string | null>> {
  if (!isDbDate(key.reminderDate)) {
    return refused();
  }
  return callFunction<string | null>(
    db,
    sql`select public.reclaim_event_reminder(p_event_id => ${key.eventId},
      p_kind => ${key.kind},
      p_reminder_date => ${key.reminderDate},
      p_claim_token => ${key.claimToken},
      p_stale_after_seconds => ${STALE_CLAIM_MS / 1000}) as value`,
  );
}

/** False if the token no longer holds the claim. */
export async function markEventReminderSent(
  db: DbClient,
  key: EventReminderKey & { claimToken: string; messageId: string },
): Promise<DbResult<boolean>> {
  if (!isDbDate(key.reminderDate)) {
    return refused();
  }
  return callFunction<boolean>(
    db,
    sql`select public.mark_event_reminder_sent(p_event_id => ${key.eventId},
      p_kind => ${key.kind},
      p_reminder_date => ${key.reminderDate},
      p_claim_token => ${key.claimToken},
      p_message_id => ${key.messageId}) as value`,
  );
}

/** For a claimed reminder deliberately not sent. False if the token no longer holds it. */
export async function markEventReminderSkipped(
  db: DbClient,
  key: EventReminderKey & { claimToken: string },
): Promise<DbResult<boolean>> {
  if (!isDbDate(key.reminderDate)) {
    return refused();
  }
  return callFunction<boolean>(
    db,
    sql`select public.mark_event_reminder_skipped(p_event_id => ${key.eventId},
      p_kind => ${key.kind},
      p_reminder_date => ${key.reminderDate},
      p_claim_token => ${key.claimToken}) as value`,
  );
}

/**
 * Closes a stale event reminder claim that no plan named, once its event is read again
 * and shows it can never go out: the event is gone, deleted or closed, its post is gone,
 * or it was dated before `beforeDate`, a day already past in every guild. Anything else
 * is left exactly as it is, with no takeover and no rise in `attempts`: a guild with
 * reminders off, whatever its events, and a live event the candidate read left out, such
 * as one in a forum no longer managed, which may be added back. "closed" only when this
 * call recorded it skipped.
 */
export async function closeStaleEventClaim(
  db: DbClient,
  key: EventReminderKey & { claimToken: string; beforeDate: DateOnly },
): Promise<DbResult<"closed" | "left">> {
  if (!isDbDate(key.reminderDate) || !isDbDate(key.beforeDate)) {
    return refused();
  }
  const read = firstRow(
    await query<{
      state: ReminderState;
      claim_token: string;
      event_status: EventStatus | null;
      event_deleted_at: string | null;
      event_date: DateOnly | null;
      thread_status: ThreadStatus | null;
      reminders_enabled: boolean | null;
    }>(
      db,
      sql`select l.state, l.claim_token, e.status as event_status,
        e.deleted_at as event_deleted_at, e.event_date, e.thread_status,
        g.reminders_enabled
      from event_reminder_log l
      left join events e on e.id = l.event_id
      left join guild_config g on g.guild_id = e.guild_id
      where l.event_id = ${key.eventId} and l.kind = ${key.kind}
        and l.reminder_date = ${key.reminderDate}
      limit 1`,
    ),
  );
  if (!read.ok) {
    return read;
  }
  const live = read.value;
  if (
    live?.state !== "claimed" ||
    live.claim_token !== key.claimToken ||
    // Paused for now: closing would keep it from going out once they are back on.
    live.reminders_enabled === false
  ) {
    return { ok: true, value: "left" };
  }
  const dead =
    live.event_status !== "active" ||
    live.event_deleted_at !== null ||
    live.thread_status === "missing" ||
    live.event_date === null ||
    live.event_date < key.beforeDate;
  if (!dead) {
    return { ok: true, value: "left" };
  }
  const marked = await markEventReminderSkipped(db, key);
  if (!marked.ok) {
    return marked;
  }
  return { ok: true, value: marked.value ? "closed" : "left" };
}
