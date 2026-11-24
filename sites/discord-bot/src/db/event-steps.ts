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
  asc,
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
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { BotTx, DbClient } from "./client.ts";
import { failure, refused, type DbResult } from "./errors.ts";
import {
  capped,
  nullAsNotFound,
  raise,
  read,
  transact,
  write,
} from "./internal.ts";
import { updateRecorded } from "./history.ts";
import { allowedEvent, eventReminderDayOpen } from "./reminder-rules.ts";
import {
  eventReminderLog,
  eventStepAssignees,
  eventSteps,
  events,
  guildConfig,
  managedChannels,
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
  const loaded = await read(db, async (orm) => {
    const found = await orm
      .select({
        id: events.id,
        event_date: events.eventDate,
        pickup_time: events.pickupTime,
        timezone: guildConfig.timezone,
      })
      .from(events)
      .innerJoin(guildConfig, eq(guildConfig.guildId, events.guildId))
      .where(
        and(
          eq(events.guildId, guildId),
          inArray(events.id, [...eventIds]),
          isNull(events.deletedAt),
        ),
      )
      .orderBy(asc(events.id))
      .limit(MAX_ID_LIST);
    const ids = found.map((event) => event.id);
    if (ids.length === 0) {
      return [];
    }
    const steps = await orm
      .select({
        event_id: eventSteps.eventId,
        kind: eventSteps.kind,
        status: eventSteps.status,
        completed_at: eventSteps.completedAt,
        completed_by: eventSteps.completedBy,
        handoff_claimed_at: eventSteps.handoffClaimedAt,
        handoff_sent_at: eventSteps.handoffSentAt,
        not_needed_at: eventSteps.notNeededAt,
        not_needed_by: eventSteps.notNeededBy,
      })
      .from(eventSteps)
      .where(
        and(eq(eventSteps.guildId, guildId), inArray(eventSteps.eventId, ids)),
      );
    const assignees = await orm
      .select({
        id: eventStepAssignees.id,
        event_id: eventStepAssignees.eventId,
        kind: eventStepAssignees.kind,
        user_id: eventStepAssignees.userId,
        assigned_by: eventStepAssignees.assignedBy,
        created_at: eventStepAssignees.createdAt,
      })
      .from(eventStepAssignees)
      .where(
        and(
          eq(eventStepAssignees.guildId, guildId),
          inArray(eventStepAssignees.eventId, ids),
          isNull(eventStepAssignees.removedAt),
        ),
      )
      .orderBy(asc(eventStepAssignees.createdAt), asc(eventStepAssignees.id));
    return found.map((event) => ({
      ...event,
      steps: steps.filter((step) => step.event_id === event.id),
      assignees: assignees.filter(
        (assignee) => assignee.event_id === event.id,
      ) as StepAssignee[],
    }));
  });
  return loaded.ok
    ? {
        ok: true,
        value: loaded.value.map((row) => ({
          event_id: row.id,
          event_date: row.event_date as DateOnly,
          pickup_time: hoursAndMinutes(row.pickup_time),
          timezone: row.timezone,
          // Every event has one row per kind, which the baseline adds with the event.
          steps: EVENT_STEP_KINDS.flatMap((kind) =>
            row.steps.filter((step) => step.kind === kind),
          ),
          assignees: row.assignees,
        })),
      }
    : loaded;
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
        const needed = await updateRecorded(
          tx,
          eventSteps,
          { notNeededAt: null, notNeededBy: null },
          and(
            eq(eventSteps.eventId, input.eventId),
            eq(eventSteps.kind, "slides"),
            isNotNull(eventSteps.notNeededAt),
          ),
          { eventId: eventSteps.eventId },
        );
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
  const [step] = (await updateRecorded(
    tx,
    eventSteps,
    {
      status: ready ? "done" : "open",
      completedAt: ready
        ? sql`coalesce(${eventSteps.completedAt}, now())`
        : null,
      completedBy: ready
        ? sql`coalesce(${eventSteps.completedBy}, ${actorId}::text)`
        : null,
    },
    and(eq(eventSteps.eventId, eventId), eq(eventSteps.kind, "food_pickup")),
    { status: eventSteps.status },
  )) as { status: TaskStatus }[];
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

      const removed = await updateRecorded(
        tx,
        eventStepAssignees,
        { removedAt: sql`now()`, removedBy: input.actorId },
        and(
          eq(eventStepAssignees.eventId, input.eventId),
          eq(eventStepAssignees.kind, input.kind),
          eq(eventStepAssignees.userId, input.userId),
          isNull(eventStepAssignees.removedAt),
        ),
        { id: eventStepAssignees.id },
      );

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

      await updateRecorded(
        tx,
        eventSteps,
        {
          status: "done",
          completedAt: sql`now()`,
          completedBy: input.actorId,
          notNeededAt: null,
          notNeededBy: null,
        },
        and(
          eq(eventSteps.eventId, input.eventId),
          eq(eventSteps.kind, input.kind),
        ),
        { eventId: eventSteps.eventId },
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

    const claimed = await updateRecorded(
      tx,
      eventSteps,
      { handoffClaimedAt: sql`now()` },
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
      { eventId: eventSteps.eventId },
    );
    return claimed.length > 0;
  });
}

/** For after the claimed hand-off went out. False if it was not claimed or is recorded. */
export async function markStepHandoffSent(
  db: DbClient,
  key: HandoffKey,
): Promise<DbResult<boolean>> {
  return transact(db, async (tx) => {
    const marked = await updateRecorded(
      tx,
      eventSteps,
      { handoffSentAt: sql`now()` },
      and(
        eq(eventSteps.eventId, key.eventId),
        eq(eventSteps.guildId, key.guildId),
        eq(eventSteps.kind, key.kind),
        isNotNull(eventSteps.handoffClaimedAt),
        isNull(eventSteps.handoffSentAt),
      ),
      { eventId: eventSteps.eventId },
    );
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

      await updateRecorded(
        tx,
        eventSteps,
        {
          status: "open",
          completedAt: null,
          completedBy: null,
          handoffClaimedAt: null,
          handoffSentAt: null,
        },
        and(
          eq(eventSteps.eventId, input.eventId),
          input.kind === "engage_post"
            ? inArray(eventSteps.kind, ["engage_post", "engage_picture"])
            : eq(eventSteps.kind, input.kind),
          eq(eventSteps.status, "done"),
        ),
        { eventId: eventSteps.eventId },
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

      await updateRecorded(
        tx,
        eventSteps,
        {
          notNeededAt: input.notNeeded ? sql`now()` : null,
          notNeededBy: input.notNeeded ? input.actorId : null,
        },
        and(
          eq(eventSteps.eventId, input.eventId),
          eq(eventSteps.kind, "slides"),
        ),
        { eventId: eventSteps.eventId },
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

      await updateRecorded(
        tx,
        events,
        { pickupTime: input.pickupTime },
        eq(events.id, input.eventId),
        { id: events.id },
      );

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
    await read(
      db,
      (orm) =>
        orm
          .select({
            assignment_id: eventStepAssignees.id,
            kind: eventStepAssignees.kind,
            event_id: events.id,
            event_name: events.name,
            event_date: events.eventDate,
            pickup_time: events.pickupTime,
            step_status: eventSteps.status,
          })
          .from(eventStepAssignees)
          .innerJoin(
            events,
            and(
              eq(events.id, eventStepAssignees.eventId),
              eq(events.guildId, eventStepAssignees.guildId),
            ),
          )
          .innerJoin(
            eventSteps,
            and(
              eq(eventSteps.eventId, events.id),
              eq(eventSteps.guildId, events.guildId),
              eq(eventSteps.kind, eventStepAssignees.kind),
            ),
          )
          .where(
            and(
              eq(eventStepAssignees.guildId, guildId),
              eq(eventStepAssignees.userId, userId),
              isNull(eventStepAssignees.removedAt),
              eq(events.status, "active"),
              isNull(events.deletedAt),
              or(
                and(
                  eq(eventStepAssignees.kind, "food_pickup"),
                  gte(events.eventDate, today),
                ),
                and(
                  ne(eventStepAssignees.kind, "food_pickup"),
                  eq(eventSteps.status, "open"),
                  isNull(eventSteps.notNeededAt),
                ),
              ),
            ),
          )
          .orderBy(
            asc(sql`${events.eventDate} < ${today}::date`),
            asc(sql`abs(${events.eventDate} - ${today}::date)`),
            asc(eventStepAssignees.kind),
            asc(events.id),
            asc(eventStepAssignees.id),
          )
          .limit(MAX_USER_STEPS + 1) as unknown as Promise<
          {
            assignment_id: string;
            kind: AssignableStepKind;
            event_id: string;
            event_name: string;
            event_date: DateOnly;
            pickup_time: string | null;
            step_status: TaskStatus;
          }[]
        >,
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
  const found = await read(db, async (orm) => {
    const post = alias(eventSteps, "post");
    const picture = alias(eventSteps, "picture");
    const page = await orm
      .select({
        id: events.id,
        guild_id: events.guildId,
        name: events.name,
        event_date: events.eventDate,
        thread_id: events.threadId,
        thread_status: events.threadStatus,
        created_by: events.createdBy,
        pickup_time: events.pickupTime,
        timezone: guildConfig.timezone,
        events_director_role_id: guildConfig.officerRoleId,
        marketing_role_id: guildConfig.marketingRoleId,
        events_committee_role_id: guildConfig.eventsCommitteeRoleId,
      })
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
          eq(events.status, "active"),
          isNull(events.deletedAt),
          or(
            gte(events.eventDate, fromDate),
            exists(
              orm
                .select({ one: sql`1` })
                .from(post)
                .where(
                  and(
                    eq(post.eventId, events.id),
                    eq(post.kind, "engage_post"),
                    eq(post.status, "done"),
                    gte(
                      post.completedAt,
                      sql`(${fromDate}::date - 9)::timestamptz`,
                    ),
                    notExists(
                      orm
                        .select({ one: sql`1` })
                        .from(picture)
                        .where(
                          and(
                            eq(picture.eventId, events.id),
                            eq(picture.kind, "engage_picture"),
                            eq(picture.status, "done"),
                          ),
                        ),
                    ),
                  ),
                ),
            ),
          ),
          eq(managedChannels.status, "active"),
          eq(guildConfig.remindersEnabled, true),
        ),
      )
      .orderBy(asc(events.eventDate), asc(events.id))
      .limit(MAX_REMINDER_EVENTS + 1);
    const ids = page.map((event) => event.id);
    if (ids.length === 0) {
      return [];
    }
    const steps = await orm
      .select({
        event_id: eventSteps.eventId,
        kind: eventSteps.kind,
        status: eventSteps.status,
        completed_at: eventSteps.completedAt,
        not_needed_at: eventSteps.notNeededAt,
      })
      .from(eventSteps)
      .where(inArray(eventSteps.eventId, ids));
    const assignees = await orm
      .select({
        event_id: eventStepAssignees.eventId,
        kind: eventStepAssignees.kind,
        user_id: eventStepAssignees.userId,
      })
      .from(eventStepAssignees)
      .where(
        and(
          inArray(eventStepAssignees.eventId, ids),
          isNull(eventStepAssignees.removedAt),
        ),
      )
      .orderBy(asc(eventStepAssignees.createdAt), asc(eventStepAssignees.id));
    const logs = await orm
      .select({
        event_id: eventReminderLog.eventId,
        kind: eventReminderLog.kind,
        reminder_date: eventReminderLog.reminderDate,
        state: eventReminderLog.state,
        claimed_at: eventReminderLog.claimedAt,
      })
      .from(eventReminderLog)
      .where(
        and(
          inArray(eventReminderLog.eventId, ids),
          gte(eventReminderLog.reminderDate, fromDate),
        ),
      );
    return page.map((event) => ({
      ...event,
      steps: steps
        .filter((step) => step.event_id === event.id)
        .map((step) => ({
          kind: step.kind,
          status: step.status,
          completed_at: step.completed_at,
          not_needed: step.not_needed_at !== null,
        })),
      assignees: assignees
        .filter((assignee) => assignee.event_id === event.id)
        .map(({ kind, user_id }) => ({
          kind: kind as AssignableStepKind,
          user_id,
        })),
      log: logs
        .filter((log) => log.event_id === event.id)
        .map((log) => ({
          kind: log.kind,
          reminder_date: log.reminder_date as DateOnly,
          state: log.state,
          claimed_at: new Date(log.claimed_at),
        })),
    }));
  });
  if (!found.ok) {
    return found;
  }
  const capture = capped(found, MAX_REMINDER_EVENTS);
  if (!capture.ok) {
    return capture;
  }
  return {
    ok: true,
    value: {
      ...capture.value,
      rows: capture.value.rows.map((event): EventReminderCandidate => ({
        ...event,
        event_date: event.event_date as DateOnly,
        pickup_time: hoursAndMinutes(event.pickup_time),
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
    await read(
      db,
      (orm) =>
        orm
          .select({
            event_id: eventReminderLog.eventId,
            kind: eventReminderLog.kind,
            reminder_date: eventReminderLog.reminderDate,
            claim_token: eventReminderLog.claimToken,
            attempts: eventReminderLog.attempts,
            claimed_at: eventReminderLog.claimedAt,
          })
          .from(eventReminderLog)
          .where(
            and(
              eq(eventReminderLog.state, "claimed"),
              lt(eventReminderLog.claimedAt, claimedBefore.toISOString()),
            ),
          )
          .orderBy(
            asc(eventReminderLog.claimedAt),
            asc(eventReminderLog.eventId),
            asc(eventReminderLog.kind),
            asc(eventReminderLog.reminderDate),
          )
          .limit(MAX_STALE_CLAIMS + 1) as unknown as Promise<
          EventReminderStaleClaim[]
        >,
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
    const allowed = allowedEvent(
      orm,
      key.eventId,
      key.kind,
      key.reminderDate,
    ).as("allowed");
    const [claimed] = await orm
      .insert(eventReminderLog)
      .select(
        orm
          .select({
            eventId: allowed.id,
            kind: sql<EventReminderKind>`${key.kind}::discord_bot.event_reminder_kind`.as(
              "kind",
            ),
            reminderDate: sql<string>`${key.reminderDate}::date`.as(
              "reminder_date",
            ),
            state: sql<"claimed">`'claimed'::discord_bot.reminder_state`.as(
              "state",
            ),
            claimToken: sql<string>`gen_random_uuid()`.as("claim_token"),
            attempts: sql<number>`1`.as("attempts"),
            claimedAt: sql<string>`now()`.as("claimed_at"),
            sentAt: sql<string | null>`null::timestamptz`.as("sent_at"),
            messageId: sql<string | null>`null::discord_bot.discord_id`.as(
              "message_id",
            ),
          })
          .from(allowed),
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
        claimToken: sql`gen_random_uuid()`,
        claimedAt: sql`now()`,
        attempts: sql`${eventReminderLog.attempts} + 1`,
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
            sql`now() - make_interval(secs => ${STALE_CLAIM_MS / 1000}::int)`,
          ),
          exists(
            allowedEvent(
              orm,
              eventReminderLog.eventId,
              key.kind,
              key.reminderDate,
            ),
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
      .set({ state: "sent", sentAt: sql`now()`, messageId: key.messageId })
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
    ) ?? sql`true`
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
                      sql`${key.reminderDate}::date >= ${key.beforeDate}::date`,
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
