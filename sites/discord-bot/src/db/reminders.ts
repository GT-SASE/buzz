import type { DateOnly } from "../lib/dates.ts";
import { STALE_CLAIM_MS } from "../reminders/plan.ts";
import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  notExists,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { BotTx, DbClient } from "./client.ts";
import { refused, type DbResult } from "./errors.ts";
import { capped, raise, read, transact, write } from "./internal.ts";
import { remindableTask } from "./reminder-rules.ts";
import {
  events,
  guildConfig,
  managedChannels,
  reminderLog,
  tasks,
} from "./schema.ts";
import type {
  CappedList,
  EventStatus,
  ReminderCandidate,
  ReminderKind,
  ReminderState,
  StaleClaim,
  TaskStatus,
  ThreadStatus,
} from "./types.ts";
import { isDbDate } from "./validate.ts";

const PAGE_SIZE = 500;
const MAX_PAGES = 20;
const MAX_STALE_CLAIMS = 500;
/** Sorts before every row: the earliest date the column allows, and the lowest ID. */
const FIRST_POSITION = {
  dueDate: "2000-01-01",
  id: "00000000-0000-0000-0000-000000000000",
};

interface CandidateRow {
  id: string;
  event_id: string;
  guild_id: string;
  assignee_id: string;
  description: string;
  due_date: DateOnly;
  status: TaskStatus;
  updated_at: string;
  event_name: string;
  thread_id: string | null;
  event_status: EventStatus;
  thread_status: ThreadStatus;
  timezone: string;
  log: {
    kind: ReminderKind;
    due_date: DateOnly;
    state: ReminderState;
    claimed_at: string;
  }[];
}

function toCandidate(row: CandidateRow): ReminderCandidate {
  return {
    guild_id: row.guild_id,
    timezone: row.timezone,
    assignee_id: row.assignee_id,
    description: row.description,
    event_name: row.event_name,
    updated_at: row.updated_at,
    // The query only returns live tasks, of live events on active channels.
    task: {
      id: row.id,
      eventId: row.event_id,
      dueDate: row.due_date,
      status: row.status,
      deleted: false,
    },
    event: {
      id: row.event_id,
      threadId: row.thread_id,
      status: row.event_status,
      threadStatus: row.thread_status,
      deleted: false,
      forumManaged: true,
    },
    log: row.log.map((log) => ({
      taskId: row.id,
      dueDate: log.due_date,
      kind: log.kind,
      state: log.state,
      claimedAt: new Date(log.claimed_at),
    })),
  };
}

/**
 * Open tasks due up to a date, across all guilds, with every condition that can stop
 * a send: the task, its event, its channel and the guild's reminder switch.
 *
 * Each task carries its whole log, whatever the due date, and the planner decides what
 * has already gone out.
 *
 * Pages follow `due_date, id`, so a row changed during the read cannot shift a later
 * page. `truncated` means rows remain unread. They are the latest due, and the next
 * run reaches them only once earlier tasks have left this list, so log it when set.
 */
export async function listReminderCandidates(
  db: DbClient,
  { lastDueDate }: { lastDueDate: DateOnly },
): Promise<DbResult<CappedList<ReminderCandidate>>> {
  if (!isDbDate(lastDueDate)) {
    return refused();
  }
  const rows: ReminderCandidate[] = [];
  let position = FIRST_POSITION;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await read(db, async (orm) => {
      const page = await orm
        .select({
          id: tasks.id,
          event_id: tasks.eventId,
          guild_id: tasks.guildId,
          assignee_id: tasks.assigneeId,
          description: tasks.description,
          due_date: tasks.dueDate,
          status: tasks.status,
          updated_at: tasks.updatedAt,
          event_name: events.name,
          thread_id: events.threadId,
          event_status: events.status,
          thread_status: events.threadStatus,
          timezone: guildConfig.timezone,
        })
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
        .innerJoin(guildConfig, eq(guildConfig.guildId, events.guildId))
        .where(
          and(
            eq(tasks.status, "open"),
            isNull(tasks.deletedAt),
            lte(tasks.dueDate, lastDueDate),
            eq(events.status, "active"),
            isNull(events.deletedAt),
            eq(managedChannels.status, "active"),
            eq(guildConfig.remindersEnabled, true),
            or(
              gt(tasks.dueDate, position.dueDate),
              and(
                eq(tasks.dueDate, position.dueDate),
                gt(tasks.id, position.id),
              ),
            ),
          ),
        )
        .orderBy(asc(tasks.dueDate), asc(tasks.id))
        .limit(PAGE_SIZE);
      // Each task carries its whole log, whatever the due date.
      const logs =
        page.length === 0
          ? []
          : await orm
              .select({
                task_id: reminderLog.taskId,
                kind: reminderLog.kind,
                due_date: reminderLog.dueDate,
                state: reminderLog.state,
                claimed_at: reminderLog.claimedAt,
              })
              .from(reminderLog)
              .where(
                inArray(
                  reminderLog.taskId,
                  page.map((task) => task.id),
                ),
              );
      return page.map((task): CandidateRow => ({
        ...task,
        due_date: task.due_date as DateOnly,
        log: logs
          .filter((log) => log.task_id === task.id)
          .map((log) => ({ ...log, due_date: log.due_date as DateOnly })),
      }));
    });
    if (!response.ok) {
      return response;
    }
    rows.push(...response.value.map(toCandidate));
    const last = response.value.at(-1);
    if (response.value.length < PAGE_SIZE || last === undefined) {
      return { ok: true, value: { rows, truncated: false } };
    }
    position = { dueDate: last.due_date, id: last.id };
  }
  return { ok: true, value: { rows, truncated: true } };
}

/** Claims left unfinished since before the cutoff, oldest first. */
export async function listStaleClaims(
  db: DbClient,
  { claimedBefore }: { claimedBefore: Date },
): Promise<DbResult<CappedList<StaleClaim>>> {
  return capped(
    await read(
      db,
      (orm) =>
        orm
          .select({
            task_id: reminderLog.taskId,
            kind: reminderLog.kind,
            due_date: reminderLog.dueDate,
            claim_token: reminderLog.claimToken,
            attempts: reminderLog.attempts,
            refused_attempts: reminderLog.refusedAttempts,
            claimed_at: reminderLog.claimedAt,
          })
          .from(reminderLog)
          .where(
            and(
              eq(reminderLog.state, "claimed"),
              lt(reminderLog.claimedAt, claimedBefore.toISOString()),
            ),
          )
          .orderBy(
            asc(reminderLog.claimedAt),
            asc(reminderLog.taskId),
            asc(reminderLog.kind),
            asc(reminderLog.dueDate),
          )
          .limit(MAX_STALE_CLAIMS + 1) as unknown as Promise<StaleClaim[]>,
    ),
    MAX_STALE_CLAIMS,
  );
}

export interface ReminderKey {
  taskId: string;
  kind: ReminderKind;
  dueDate: DateOnly;
}

/**
 * The task as a caller read it. A claim that names this fails as `task_changed` if the
 * task has since been reassigned or edited, because what the caller rendered is out of date.
 */
export interface TaskAsRead {
  assigneeId: string;
  updatedAt: string;
}

/**
 * Returns a claim token, or null if someone else holds it, the task has moved on, or
 * its event, channel or guild no longer allow reminders.
 */
export async function claimReminder(
  db: DbClient,
  key: ReminderKey & { asRead?: TaskAsRead | undefined },
): Promise<DbResult<string | null>> {
  if (!isDbDate(key.dueDate)) {
    return refused();
  }
  return transact(db, async (tx) => {
    await refuseIfTaskChanged(tx, key);
    const allowed = remindableTask(tx, key.taskId, key.dueDate).as("allowed");
    const [claimed] = await tx
      .insert(reminderLog)
      .select(
        tx
          .select({
            taskId: allowed.id,
            kind: sql<ReminderKind>`${key.kind}::discord_bot.reminder_kind`.as(
              "kind",
            ),
            dueDate: allowed.dueDate,
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
            refusedAttempts: sql<number>`0`.as("refused_attempts"),
          })
          .from(allowed),
      )
      .onConflictDoNothing({
        target: [reminderLog.taskId, reminderLog.kind, reminderLog.dueDate],
      })
      .returning({ claimToken: reminderLog.claimToken });
    return claimed?.claimToken ?? null;
  });
}

/**
 * Fails as `task_changed` if the task is the one the caller read, due that day and
 * open, but no longer has the assignee and version it read. A caller that read nothing
 * has nothing to be out of date.
 */
async function refuseIfTaskChanged(
  tx: BotTx,
  key: ReminderKey & { asRead?: TaskAsRead | undefined },
): Promise<void> {
  if (key.asRead === undefined) {
    return;
  }
  const [changed] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.id, key.taskId),
        eq(tasks.dueDate, key.dueDate),
        eq(tasks.status, "open"),
        isNull(tasks.deletedAt),
        or(
          ne(tasks.assigneeId, key.asRead.assigneeId),
          ne(tasks.updatedAt, key.asRead.updatedAt),
        ),
      ),
    );
  if (changed !== undefined) {
    raise("CF412", "task changed since it was read");
  }
}

/** Takes over a stale claim given its last token. Null if that is no longer possible. */
export async function reclaimReminder(
  db: DbClient,
  key: ReminderKey & { claimToken: string; asRead?: TaskAsRead | undefined },
): Promise<DbResult<string | null>> {
  if (!isDbDate(key.dueDate)) {
    return refused();
  }
  return transact(db, async (tx) => {
    await refuseIfTaskChanged(tx, key);
    const [reclaimed] = await tx
      .update(reminderLog)
      .set({
        claimToken: sql`gen_random_uuid()`,
        claimedAt: sql`now()`,
        attempts: sql`${reminderLog.attempts} + 1`,
      })
      .where(
        and(
          heldClaim(key),
          lt(
            reminderLog.claimedAt,
            sql`now() - make_interval(secs => ${STALE_CLAIM_MS / 1000}::int)`,
          ),
          exists(remindableTask(tx, reminderLog.taskId, key.dueDate)),
        ),
      )
      .returning({ claimToken: reminderLog.claimToken });
    return reclaimed?.claimToken ?? null;
  });
}

/** The claim this token holds, still unsent. */
function heldClaim(key: ReminderKey & { claimToken: string }): SQL {
  return (
    and(
      eq(reminderLog.taskId, key.taskId),
      eq(reminderLog.kind, key.kind),
      eq(reminderLog.dueDate, key.dueDate),
      eq(reminderLog.state, "claimed"),
      eq(reminderLog.claimToken, key.claimToken),
    ) ?? sql`true`
  );
}

export type StaleClaimOutcome =
  /** Taken over. Send the reminder and mark it with this token. */
  | { readonly outcome: "reclaimed"; readonly claimToken: string }
  /**
   * The task is done, deleted or moved, or its event is closed or deleted, its forum no
   * longer managed or its post gone, so the claim was recorded as skipped.
   */
  | { readonly outcome: "closed" }
  /** Left alone and may come back: fresh, reminders paused, or someone else's now. */
  | { readonly outcome: "left" };

/**
 * Deals with one claim from `listStaleClaims`. Without this, a claim on a finished
 * task would stay listed forever, since a reclaim refuses it. A claim is closed when its
 * task is finished or can no longer be reminded where it is, not when reminders are
 * merely paused, because a closed claim would not go out if they were turned back on.
 */
export async function resolveStaleClaim(
  db: DbClient,
  key: ReminderKey & { claimToken: string; asRead?: TaskAsRead | undefined },
): Promise<DbResult<StaleClaimOutcome>> {
  const reclaimed = await reclaimReminder(db, key);
  if (!reclaimed.ok) {
    return reclaimed;
  }
  if (reclaimed.value !== null) {
    return {
      ok: true,
      value: { outcome: "reclaimed", claimToken: reclaimed.value },
    };
  }

  return closeStaleClaim(db, key);
}

/**
 * Closes a stale claim if its task is finished, deleted or moved to another date, or its
 * event is closed or deleted, its forum is no longer managed or its post is gone, and
 * otherwise leaves it exactly as it is, with no takeover and no rise in `attempts`. For
 * a claim the run has no intention of sending, such as one on a task the plan left out.
 * Left open, such a claim is listed as stale by every run for good.
 */
export async function closeStaleClaim(
  db: DbClient,
  key: ReminderKey & { claimToken: string },
): Promise<DbResult<Exclude<StaleClaimOutcome, { outcome: "reclaimed" }>>> {
  if (!isDbDate(key.dueDate)) {
    return refused();
  }
  // Decided and written in one statement, so a task reopened or an event restored in
  // between does not have its claim closed anyway.
  const closed = await write(db, async (orm) => {
    const marked = await orm
      .update(reminderLog)
      .set({ state: "skipped" })
      .where(
        and(
          heldClaim(key),
          notExists(
            orm
              .select({ id: tasks.id })
              .from(tasks)
              .innerJoin(
                events,
                and(
                  eq(events.id, tasks.eventId),
                  eq(events.guildId, tasks.guildId),
                ),
              )
              .innerJoin(
                managedChannels,
                and(
                  eq(managedChannels.guildId, events.guildId),
                  eq(managedChannels.channelId, events.channelId),
                ),
              )
              .where(
                and(
                  eq(tasks.id, key.taskId),
                  eq(tasks.status, "open"),
                  isNull(tasks.deletedAt),
                  eq(tasks.dueDate, key.dueDate),
                  eq(events.status, "active"),
                  isNull(events.deletedAt),
                  ne(events.threadStatus, "missing"),
                  eq(managedChannels.status, "active"),
                ),
              ),
          ),
        ),
      )
      .returning({ taskId: reminderLog.taskId });
    return marked.length > 0;
  });
  if (!closed.ok) {
    return closed;
  }
  return { ok: true, value: { outcome: closed.value ? "closed" : "left" } };
}

/** False if the token no longer holds the claim. */
export async function markReminderSent(
  db: DbClient,
  key: ReminderKey & { claimToken: string; messageId: string },
): Promise<DbResult<boolean>> {
  if (!isDbDate(key.dueDate)) {
    return refused();
  }
  return write(db, async (orm) => {
    const marked = await orm
      .update(reminderLog)
      .set({ state: "sent", sentAt: sql`now()`, messageId: key.messageId })
      .where(heldClaim(key))
      .returning({ taskId: reminderLog.taskId });
    return marked.length > 0;
  });
}

/** False if the token no longer holds the claim. */
export async function markReminderSkipped(
  db: DbClient,
  key: ReminderKey & { claimToken: string },
): Promise<DbResult<boolean>> {
  if (!isDbDate(key.dueDate)) {
    return refused();
  }
  return write(db, async (orm) => {
    const marked = await orm
      .update(reminderLog)
      .set({ state: "skipped" })
      .where(heldClaim(key))
      .returning({ taskId: reminderLog.taskId });
    return marked.length > 0;
  });
}

/**
 * Records that this claim's send is known not to have reached anyone, so it does not count
 * as a message someone may have been notified by. False if the token no longer holds the
 * claim, or this attempt has been recorded already.
 */
export async function recordReminderRefused(
  db: DbClient,
  key: ReminderKey & { claimToken: string },
): Promise<DbResult<boolean>> {
  if (!isDbDate(key.dueDate)) {
    return refused();
  }
  return write(db, async (orm) => {
    const recorded = await orm
      .update(reminderLog)
      .set({ refusedAttempts: sql`${reminderLog.refusedAttempts} + 1` })
      .where(
        and(
          heldClaim(key),
          lt(reminderLog.refusedAttempts, reminderLog.attempts),
        ),
      )
      .returning({ taskId: reminderLog.taskId });
    return recorded.length > 0;
  });
}
