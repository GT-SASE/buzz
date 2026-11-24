/**
 * The per-event workflow: Budget Sheet, Engage post, Engage picture added, Budget
 * approved, Slides and Food pickup, the people on each, the one-time ping that follows a
 * finished step, the undo of one, and the claim cycle of the event reminders. Every write
 * is a transaction that locks the step, checks the event and enforces the limits, so
 * nothing here can be raced past: the step is locked before its event, always, so two
 * writes on one step queue on it and cannot deadlock.
 *
 * A write on an event that is unknown, in another guild or deleted fails as `not_found`,
 * and on a closed event as `parent_unavailable`. Who may make a write is decided before
 * calling it: these writes check only that the rows allow it.
 */

import type { DateOnly } from "../lib/dates.ts";
import { STALE_CLAIM_MS } from "../reminders/plan.ts";
import {
  and,
  count,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notExists,
  or,
  sql as dsql,
  type SQL,
} from "drizzle-orm";
import type { BotTx, DbClient } from "./client.ts";
import { failure, refused, type DbResult } from "./errors.ts";
import {
  capped,
  nullAsNotFound,
  query,
  raise,
  sql,
  transact,
  write,
} from "./internal.ts";
import { eventReminderDayOpen, fromAllowedEvent } from "./reminder-rules.ts";
import {
  eventReminderLog,
  eventStepAssignees,
  eventSteps,
  events,
  guildConfig,
} from "./schema.ts";
import {
  ASSIGNABLE_STEP_KINDS,
  EVENT_STEP_KINDS,
  type AssignableStepKind,
  type CappedList,
  type CompletableStepKind,
  type EventReminderCandidate,
  type EventReminderKind,
  type EventReminderStaleClaim,
  type EventStepKind,
  type EventStep,
  type EventWorkflow,
  type HandoffStepKind,
  type StepAssignee,
  type TaskStatus,
  type UserStep,
} from "./types.ts";
import { MAX_ID_LIST, isDbDate, isPickupTime } from "./validate.ts";

/** Enforced by `assignEventStep`, under the step's row lock. */
export const MAX_ASSIGNEES_PER_STEP = 10;
/** Enforced by `assignEventStep`, for Food pickup alone. */
export const MAX_FOOD_PICKUP_ASSIGNEES = 15;

const MAX_USER_STEPS = 100;

/** An event's steps, as a JSON array. Use with the event as `e`. */
const STEPS_OF_EVENT = sql`coalesce((
  select json_agg(json_build_object('event_id', s.event_id, 'kind', s.kind,
    'status', s.status, 'completed_at', s.completed_at,
    'completed_by', s.completed_by, 'handoff_claimed_at', s.handoff_claimed_at,
    'handoff_sent_at', s.handoff_sent_at, 'not_needed_at', s.not_needed_at,
    'not_needed_by', s.not_needed_by))
  from discord_bot.event_steps s where s.event_id = e.id and s.guild_id = e.guild_id
), '[]'::json)`;

/** The kind, status and done time of each of an event's steps, as a JSON array. */
const STEP_STATUSES_OF_EVENT = sql`coalesce((
  select json_agg(json_build_object('kind', s.kind, 'status', s.status,
    'completed_at', s.completed_at, 'not_needed', s.not_needed_at is not null))
  from discord_bot.event_steps s where s.event_id = e.id and s.guild_id = e.guild_id
), '[]'::json)`;

/** An event's live assignments, oldest first, as a JSON array. */
const LIVE_ASSIGNEES_OF_EVENT = sql`coalesce((
  select json_agg(json_build_object('id', a.id, 'event_id', a.event_id,
    'kind', a.kind, 'user_id', a.user_id, 'assigned_by', a.assigned_by,
    'created_at', a.created_at) order by a.created_at, a.id)
  from discord_bot.event_step_assignees a
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
async function listEventWorkflows(
  db: DbClient,
  { guildId, eventIds }: { guildId: string; eventIds: readonly string[] },
): Promise<DbResult<EventWorkflow[]>> {
  if (eventIds.length === 0) {
    return { ok: true, value: [] };
  }
  const read = await query<{
    id: string;
    event_date: DateOnly;
    pickup_time: string | null;
    timezone: string;
    steps: EventStep[];
    assignees: StepAssignee[];
  }>(
    db,
    sql`select e.id, e.event_date, e.pickup_time, g.timezone,
      ${STEPS_OF_EVENT} as steps, ${LIVE_ASSIGNEES_OF_EVENT} as assignees
    from discord_bot.events e
    join discord_bot.guild_config g on g.guild_id = e.guild_id
    where e.guild_id = ${guildId} and e.id = any(${[...eventIds]}::uuid[])
      and e.deleted_at is null
    order by e.id limit ${MAX_ID_LIST}`,
  );
  return read.ok
    ? {
        ok: true,
        value: read.value.map((row) => ({
          event_id: row.id,
          event_date: row.event_date,
          pickup_time: hoursAndMinutes(row.pickup_time),
          timezone: row.timezone,
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
 * Puts a member on a step. `added` if this call added them, `needed_again` if it also
 * undid No slides needed, `already_on` if they were on it already. Fails as
 * `step_assignee_limit` once the step has `MAX_ASSIGNEES_PER_STEP` people
 * (`MAX_FOOD_PICKUP_ASSIGNEES` for Food pickup). Food pickup can be set up at any time: it
 * does not wait for the budget.
 */
export async function assignEventStep(
  db: DbClient,
  input: StepAssignment,
): Promise<DbResult<"added" | "needed_again" | "already_on">> {
  return nullAsNotFound(
    await transact(db, async (tx) => {
      if ((input.kind as EventStepKind) === "budget_approved") {
        raise("22023", "this step has no assignees");
      }
      if (
        (await lockStepOnLiveEvent(tx, input, input.kind, "share")) === null
      ) {
        return null;
      }

      const [already] = await tx
        .select({ id: eventStepAssignees.id })
        .from(eventStepAssignees)
        .where(
          and(
            eq(eventStepAssignees.eventId, input.eventId),
            eq(eventStepAssignees.kind, input.kind),
            eq(eventStepAssignees.userId, input.userId),
            isNull(eventStepAssignees.removedAt),
          ),
        )
        .limit(1);
      if (already !== undefined) {
        return "already_on" as const;
      }

      const [{ people } = { people: 0 }] = await tx
        .select({ people: count() })
        .from(eventStepAssignees)
        .where(
          and(
            eq(eventStepAssignees.eventId, input.eventId),
            eq(eventStepAssignees.kind, input.kind),
            isNull(eventStepAssignees.removedAt),
          ),
        );
      const most =
        input.kind === "food_pickup"
          ? MAX_FOOD_PICKUP_ASSIGNEES
          : MAX_ASSIGNEES_PER_STEP;
      if (people >= most) {
        raise("CF431", "step assignee limit reached");
      }

      await tx.insert(eventStepAssignees).values({
        eventId: input.eventId,
        guildId: input.guildId,
        kind: input.kind,
        userId: input.userId,
        assignedBy: input.actorId,
      });

      if (input.kind === "food_pickup") {
        await syncFoodPickupStep(tx, input.eventId, input.actorId);
      }

      // Someone put on Slides means it is needed after all.
      if (input.kind === "slides") {
        const needed = await tx
          .update(eventSteps)
          .set({ notNeededAt: null, notNeededBy: null })
          .where(
            and(
              eq(eventSteps.eventId, input.eventId),
              eq(eventSteps.kind, "slides"),
              isNotNull(eventSteps.notNeededAt),
            ),
          )
          .returning({ eventId: eventSteps.eventId });
        if (needed.length > 0) {
          return "needed_again" as const;
        }
      }
      return "added" as const;
    }),
  );
}

/**
 * Locks a step, then reads its event under the lock `eventLock` names. Null if the step
 * is not there or its event is deleted, which the caller reports as not found. Raises
 * CF410 for a closed event. The step is always locked before the event, so two writes on
 * one step queue on it and cannot deadlock on the pair.
 */
async function lockStepOnLiveEvent(
  tx: BotTx,
  key: EventStepKey,
  kind: EventStepKind,
  eventLock: "share" | "update",
): Promise<typeof eventSteps.$inferSelect | null> {
  const [step] = await tx
    .select()
    .from(eventSteps)
    .where(
      and(
        eq(eventSteps.eventId, key.eventId),
        eq(eventSteps.guildId, key.guildId),
        eq(eventSteps.kind, kind),
      ),
    )
    .for("update");
  if (step === undefined) {
    return null;
  }
  const [event] = await tx
    .select({ status: events.status, deletedAt: events.deletedAt })
    .from(events)
    .where(and(eq(events.id, key.eventId), eq(events.guildId, key.guildId)))
    .for(eventLock);
  if (event?.deletedAt !== null) {
    return null;
  }
  if (event.status === "closed") {
    raise("CF410", "event is closed");
  }
  return step;
}

/**
 * Food pickup is done once it has a time and at least one person, and open again when
 * either goes. Returns its status. Keeps who finished it and when while it stays done.
 */
async function syncFoodPickupStep(
  tx: BotTx,
  eventId: string,
  actorId: string,
): Promise<TaskStatus | undefined> {
  const [event] = await tx
    .select({ pickupTime: events.pickupTime })
    .from(events)
    .where(eq(events.id, eventId));
  const [{ people } = { people: 0 }] = await tx
    .select({ people: count() })
    .from(eventStepAssignees)
    .where(
      and(
        eq(eventStepAssignees.eventId, eventId),
        eq(eventStepAssignees.kind, "food_pickup"),
        isNull(eventStepAssignees.removedAt),
      ),
    );
  const pickupTime = event?.pickupTime ?? null;
  const ready = pickupTime !== null && people > 0;
  const [step] = await tx
    .update(eventSteps)
    .set({
      status: ready ? "done" : "open",
      completedAt: ready
        ? dsql`coalesce(${eventSteps.completedAt}, now())`
        : null,
      completedBy: ready
        ? dsql`coalesce(${eventSteps.completedBy}, ${actorId}::text)`
        : null,
    })
    .where(
      and(eq(eventSteps.eventId, eventId), eq(eventSteps.kind, "food_pickup")),
    )
    .returning({ status: eventSteps.status });
  return step?.status;
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
    await transact(db, async (tx) => {
      if ((input.kind as EventStepKind) === "budget_approved") {
        raise("22023", "this step has no assignees");
      }
      if (
        (await lockStepOnLiveEvent(tx, input, input.kind, "share")) === null
      ) {
        return null;
      }

      const removed = await tx
        .update(eventStepAssignees)
        .set({ removedAt: dsql`now()`, removedBy: input.actorId })
        .where(
          and(
            eq(eventStepAssignees.eventId, input.eventId),
            eq(eventStepAssignees.kind, input.kind),
            eq(eventStepAssignees.userId, input.userId),
            isNull(eventStepAssignees.removedAt),
          ),
        )
        .returning({ id: eventStepAssignees.id });

      if (removed.length > 0 && input.kind === "food_pickup") {
        await syncFoodPickupStep(tx, input.eventId, input.actorId);
      }
      return removed.length > 0;
    }),
  );
}

/**
 * Marks a step done. True if this call did it, and only then should the caller go on to
 * `claimStepHandoff` for a step that has one. False if it was done already. Engage picture
 * added fails as `step_not_ready` while Engage post is open. Slides marked not needed
 * stops being so.
 */
export async function completeEventStep(
  db: DbClient,
  input: EventStepKey & { kind: CompletableStepKind; actorId: string },
): Promise<DbResult<boolean>> {
  return liveEventBoolean(
    await transact(db, async (tx) => {
      if ((input.kind as EventStepKind) === "food_pickup") {
        raise("22023", "this step cannot be marked done");
      }

      // Engage post is locked before the picture, in the order reopenEventStep locks
      // them, so the two cannot deadlock, and it cannot be reopened until this commits.
      let postStatus: TaskStatus | undefined;
      if (input.kind === "engage_picture") {
        [{ status: postStatus } = { status: undefined }] = await tx
          .select({ status: eventSteps.status })
          .from(eventSteps)
          .where(
            and(
              eq(eventSteps.eventId, input.eventId),
              eq(eventSteps.guildId, input.guildId),
              eq(eventSteps.kind, "engage_post"),
            ),
          )
          .for("share");
      }

      const step = await lockStepOnLiveEvent(tx, input, input.kind, "share");
      if (step === null) {
        return null;
      }
      if (step.status !== "open") {
        return false;
      }
      if (input.kind === "engage_picture" && postStatus !== "done") {
        raise("CF425", "engage post is not done");
      }

      await tx
        .update(eventSteps)
        .set({
          status: "done",
          completedAt: dsql`now()`,
          completedBy: input.actorId,
          notNeededAt: null,
          notNeededBy: null,
        })
        .where(
          and(
            eq(eventSteps.eventId, input.eventId),
            eq(eventSteps.kind, input.kind),
          ),
        );
      return true;
    }),
  );
}

export type HandoffKey = EventStepKey & { kind: HandoffStepKind };

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
  return transact(db, async (tx) => {
    if ((key.kind as EventStepKind) === "food_pickup") {
      raise("22023", "this step has no hand-off");
    }

    // As every other step write: a closed event takes no more step changes.
    const [closed] = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.id, key.eventId),
          eq(events.guildId, key.guildId),
          isNull(events.deletedAt),
          ne(events.status, "active"),
        ),
      );
    if (closed !== undefined) {
      raise("CF410", "event is closed");
    }

    const claimed = await tx
      .update(eventSteps)
      .set({ handoffClaimedAt: dsql`now()` })
      .where(
        and(
          eq(eventSteps.eventId, key.eventId),
          eq(eventSteps.guildId, key.guildId),
          eq(eventSteps.kind, key.kind),
          eq(eventSteps.status, "done"),
          isNull(eventSteps.handoffClaimedAt),
          exists(
            tx
              .select({ id: events.id })
              .from(events)
              .where(
                and(
                  eq(events.id, key.eventId),
                  eq(events.guildId, key.guildId),
                  isNull(events.deletedAt),
                  eq(events.status, "active"),
                ),
              ),
          ),
        ),
      )
      .returning({ eventId: eventSteps.eventId });
    return claimed.length > 0;
  });
}

/** For after the claimed hand-off went out. False if it was not claimed or is recorded. */
export async function markStepHandoffSent(
  db: DbClient,
  key: HandoffKey,
): Promise<DbResult<boolean>> {
  return write(db, async (orm) => {
    const marked = await orm
      .update(eventSteps)
      .set({ handoffSentAt: dsql`now()` })
      .where(
        and(
          eq(eventSteps.eventId, key.eventId),
          eq(eventSteps.guildId, key.guildId),
          eq(eventSteps.kind, key.kind),
          isNotNull(eventSteps.handoffClaimedAt),
          isNull(eventSteps.handoffSentAt),
        ),
      )
      .returning({ eventId: eventSteps.eventId });
    return marked.length > 0;
  });
}

/**
 * Undoes a done step: it is open again, and its hand-off can be claimed again, so doing
 * it again pings as the first time did. Reopening Engage post also reopens Engage picture
 * added. True if this call reopened it, false if it was open.
 */
export async function reopenEventStep(
  db: DbClient,
  input: EventStepKey & { kind: CompletableStepKind },
): Promise<DbResult<boolean>> {
  return liveEventBoolean(
    await transact(db, async (tx) => {
      if ((input.kind as EventStepKind) === "food_pickup") {
        raise("22023", "this step cannot be reopened");
      }
      const step = await lockStepOnLiveEvent(tx, input, input.kind, "share");
      if (step === null) {
        return null;
      }
      if (step.status !== "done") {
        return false;
      }

      await tx
        .update(eventSteps)
        .set({
          status: "open",
          completedAt: null,
          completedBy: null,
          handoffClaimedAt: null,
          handoffSentAt: null,
        })
        .where(
          and(
            eq(eventSteps.eventId, input.eventId),
            input.kind === "engage_post"
              ? inArray(eventSteps.kind, ["engage_post", "engage_picture"])
              : eq(eventSteps.kind, input.kind),
            eq(eventSteps.status, "done"),
          ),
        );
      return true;
    }),
  );
}

/**
 * Marks Slides not needed, or with `notNeeded` false undoes that. True if this call
 * changed it, false if it was already so or Slides is done.
 */
export async function setSlidesNotNeeded(
  db: DbClient,
  input: EventStepKey & { notNeeded: boolean; actorId: string },
): Promise<DbResult<boolean>> {
  return liveEventBoolean(
    await transact(db, async (tx) => {
      const step = await lockStepOnLiveEvent(tx, input, "slides", "share");
      if (step === null) {
        return null;
      }
      if (
        step.status !== "open" ||
        (step.notNeededAt !== null) === input.notNeeded
      ) {
        return false;
      }

      await tx
        .update(eventSteps)
        .set({
          notNeededAt: input.notNeeded ? dsql`now()` : null,
          notNeededBy: input.notNeeded ? input.actorId : null,
        })
        .where(
          and(
            eq(eventSteps.eventId, input.eventId),
            eq(eventSteps.kind, "slides"),
          ),
        );
      return true;
    }),
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
    await transact(db, async (tx) => {
      // The event is locked for update, not share, as its own row changes.
      if (
        (await lockStepOnLiveEvent(tx, input, "food_pickup", "update")) === null
      ) {
        return null;
      }

      await tx
        .update(events)
        .set({ pickupTime: input.pickupTime })
        .where(eq(events.id, input.eventId));

      return (
        (await syncFoodPickupStep(tx, input.eventId, input.actorId)) === "done"
      );
    }),
  );
}

const KIND_ORDER: readonly AssignableStepKind[] = ASSIGNABLE_STEP_KINDS;

/**
 * For /mytasks: a member's open Budget Sheet, Engage post and Slides steps, Slides only
 * while it is needed, and their Food pickups from `today` on, on live active events in
 * one guild. Events from `today` on come first, soonest first, then the open steps of
 * events already past, most recent first.
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
      from discord_bot.event_step_assignees a
      join discord_bot.events e on e.id = a.event_id and e.guild_id = a.guild_id
      join discord_bot.event_steps s
        on s.event_id = e.id and s.guild_id = e.guild_id and s.kind = a.kind
      where a.guild_id = ${guildId} and a.user_id = ${userId} and a.removed_at is null
        and e.status = 'active' and e.deleted_at is null
        and (
          (a.kind = 'food_pickup' and e.event_date >= ${today})
          or (a.kind <> 'food_pickup' and s.status = 'open'
            and s.not_needed_at is null)
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
 * Every live active event dated `fromDate` or later, or whose Engage picture ping may
 * still be due after the event, across all guilds, whose channel is active and whose
 * guild has reminders on, with its steps, live assignments and the log
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
        g.officer_role_id as events_director_role_id, g.marketing_role_id,
        g.events_committee_role_id, ${STEP_STATUSES_OF_EVENT} as steps,
        coalesce((
          select json_agg(json_build_object('kind', a.kind, 'user_id', a.user_id)
            order by a.created_at, a.id)
          from discord_bot.event_step_assignees a
          where a.event_id = e.id and a.guild_id = e.guild_id and a.removed_at is null
        ), '[]'::json) as assignees,
        coalesce((
          select json_agg(json_build_object('kind', l.kind,
            'reminder_date', l.reminder_date, 'state', l.state,
            'claimed_at', l.claimed_at))
          from discord_bot.event_reminder_log l
          where l.event_id = e.id and l.reminder_date >= ${fromDate}
        ), '[]'::json) as log
      from discord_bot.events e
      join discord_bot.managed_channels c
        on c.guild_id = e.guild_id and c.channel_id = e.channel_id
      join discord_bot.guild_config g on g.guild_id = e.guild_id
      where e.status = 'active' and e.deleted_at is null
        and (e.event_date >= ${fromDate} or exists (
          select 1 from discord_bot.event_steps post
          where post.event_id = e.id and post.kind = 'engage_post' and post.status = 'done'
            and post.completed_at >= ${fromDate}::date - 9
            and not exists (
              select 1 from discord_bot.event_steps picture
              where picture.event_id = e.id and picture.kind = 'engage_picture'
                and picture.status = 'done')))
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
      from discord_bot.event_reminder_log
      where state = 'claimed' and claimed_at < ${claimedBefore.toISOString()}
      order by claimed_at, event_id, kind, reminder_date
      limit ${MAX_STALE_CLAIMS + 1}`,
    ),
    MAX_STALE_CLAIMS,
  );
}

/**
 * One event reminder. `reminderDate` is the local date the message is for, such as
 * `PICKUP_REMINDER_DAYS_BEFORE` days before the event for `pickup_before`. The claim
 * refuses a date after the event, or other than today or yesterday in the guild's zone.
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
  return write(db, async (orm) => {
    // One statement: the row is inserted only for an event the reminder is allowed for,
    // and a row already there, whoever holds it, is left as it is.
    const [claimed] = await orm
      .insert(eventReminderLog)
      .select(
        dsql`select ${events.id}, ${key.kind}::discord_bot.event_reminder_kind,
          ${key.reminderDate}::date, 'claimed'::discord_bot.reminder_state,
          gen_random_uuid(), 1, now(), null::timestamptz, null::discord_bot.discord_id
          ${fromAllowedEvent(key.eventId, key.kind, key.reminderDate)}`,
      )
      .onConflictDoNothing({
        target: [
          eventReminderLog.eventId,
          eventReminderLog.kind,
          eventReminderLog.reminderDate,
        ],
      })
      .returning({ claimToken: eventReminderLog.claimToken });
    return claimed?.claimToken ?? null;
  });
}

/** Takes over a stale claim given its last token. Null if that is not possible. */
export async function reclaimEventReminder(
  db: DbClient,
  key: EventReminderKey & { claimToken: string },
): Promise<DbResult<string | null>> {
  if (!isDbDate(key.reminderDate)) {
    return refused();
  }
  return write(db, async (orm) => {
    const [reclaimed] = await orm
      .update(eventReminderLog)
      .set({
        claimToken: dsql`gen_random_uuid()`,
        claimedAt: dsql`now()`,
        attempts: dsql`${eventReminderLog.attempts} + 1`,
      })
      .where(
        and(
          eq(eventReminderLog.eventId, key.eventId),
          eq(eventReminderLog.kind, key.kind),
          eq(eventReminderLog.reminderDate, key.reminderDate),
          eq(eventReminderLog.state, "claimed"),
          eq(eventReminderLog.claimToken, key.claimToken),
          lt(
            eventReminderLog.claimedAt,
            dsql`now() - make_interval(secs => ${STALE_CLAIM_MS / 1000}::int)`,
          ),
          exists(
            dsql`(select 1 ${fromAllowedEvent(
              dsql`${eventReminderLog.eventId}`,
              key.kind,
              key.reminderDate,
            )})`,
          ),
        ),
      )
      .returning({ claimToken: eventReminderLog.claimToken });
    return reclaimed?.claimToken ?? null;
  });
}

/** False if the token no longer holds the claim. */
export async function markEventReminderSent(
  db: DbClient,
  key: EventReminderKey & { claimToken: string; messageId: string },
): Promise<DbResult<boolean>> {
  if (!isDbDate(key.reminderDate)) {
    return refused();
  }
  return write(db, async (orm) => {
    const marked = await orm
      .update(eventReminderLog)
      .set({ state: "sent", sentAt: dsql`now()`, messageId: key.messageId })
      .where(heldEventClaim(key))
      .returning({ eventId: eventReminderLog.eventId });
    return marked.length > 0;
  });
}

/** The claim this token holds, still unsent. */
function heldEventClaim(key: EventReminderKey & { claimToken: string }): SQL {
  return (
    and(
      eq(eventReminderLog.eventId, key.eventId),
      eq(eventReminderLog.kind, key.kind),
      eq(eventReminderLog.reminderDate, key.reminderDate),
      eq(eventReminderLog.state, "claimed"),
      eq(eventReminderLog.claimToken, key.claimToken),
    ) ?? dsql`true`
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
  return write(db, async (orm) => {
    const marked = await orm
      .update(eventReminderLog)
      .set({ state: "skipped" })
      .where(heldEventClaim(key))
      .returning({ eventId: eventReminderLog.eventId });
    return marked.length > 0;
  });
}

/**
 * Closes a stale event reminder claim that no plan named, once its event is read again
 * and shows it can never go out: the event is gone, deleted or closed, its post is gone,
 * or it was dated before `beforeDate`, a day already past in every guild. A kind that may
 * go out after its event, Engage picture late, is judged by its own day instead. Anything
 * else is left exactly as it is, with no takeover and no rise in `attempts`: a guild with
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
  const closed = await write(db, async (orm) => {
    // Decided and written in one statement, so an event restored or a guild switched
    // back on in between does not have its claim closed anyway.
    const marked = await orm
      .update(eventReminderLog)
      .set({ state: "skipped" })
      .where(
        and(
          heldEventClaim(key),
          notExists(
            orm
              .select({ id: events.id })
              .from(events)
              .innerJoin(guildConfig, eq(guildConfig.guildId, events.guildId))
              .where(
                and(
                  eq(events.id, key.eventId),
                  eq(guildConfig.remindersEnabled, false),
                ),
              ),
          ),
          notExists(
            orm
              .select({ id: events.id })
              .from(events)
              .where(
                and(
                  eq(events.id, key.eventId),
                  eq(events.status, "active"),
                  isNull(events.deletedAt),
                  ne(events.threadStatus, "missing"),
                  // The event is not past in every guild, or the claim's own day is not
                  // and the kind may go out that day after the event, as Engage picture
                  // late may. That ping goes out on one day only, so a claim closed here
                  // is never sent.
                  or(
                    gte(events.eventDate, key.beforeDate),
                    and(
                      dsql`${key.reminderDate}::date >= ${key.beforeDate}::date`,
                      eventReminderDayOpen(
                        key.kind,
                        key.reminderDate,
                        events.eventDate,
                      ),
                    ),
                  ),
                ),
              ),
          ),
        ),
      )
      .returning({ eventId: eventReminderLog.eventId });
    return marked.length > 0;
  });
  return closed.ok
    ? { ok: true, value: closed.value ? "closed" : "left" }
    : closed;
}
