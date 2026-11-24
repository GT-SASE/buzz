import type { DateOnly } from "../lib/dates.ts";
import { STALE_CLAIM_MS } from "../reminders/plan.ts";
import {
  and,
  eq,
  exists,
  isNull,
  lt,
  ne,
  notExists,
  or,
  sql as dsql,
  type SQL,
} from "drizzle-orm";
import type { BotTx, DbClient } from "./client.ts";
import { refused, type DbResult } from "./errors.ts";
import { capped, query, raise, sql, transact, write } from "./internal.ts";
import { fromRemindableTask } from "./reminder-rules.ts";
import { events, managedChannels, reminderLog, tasks } from "./schema.ts";
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
    const response = await query<CandidateRow>(
      db,
      sql`select t.id, t.event_id, t.guild_id, t.assignee_id, t.description,
        t.due_date, t.status, t.updated_at, e.name as event_name, e.thread_id,
        e.status as event_status, e.thread_status, g.timezone,
        coalesce((
          select json_agg(json_build_object('kind', l.kind, 'due_date', l.due_date,
            'state', l.state, 'claimed_at', l.claimed_at))
          from discord_bot.reminder_log l where l.task_id = t.id
        ), '[]'::json) as log
      from discord_bot.tasks t
      join discord_bot.events e on e.id = t.event_id and e.guild_id = t.guild_id
      join discord_bot.managed_channels c
        on c.guild_id = e.guild_id and c.channel_id = e.channel_id
      join discord_bot.guild_config g on g.guild_id = e.guild_id
      where t.status = 'open' and t.deleted_at is null
        and t.due_date <= ${lastDueDate}
        and e.status = 'active' and e.deleted_at is null
        and c.status = 'active' and g.reminders_enabled
        and (t.due_date, t.id) > (${position.dueDate}::date, ${position.id}::uuid)
      order by t.due_date, t.id limit ${PAGE_SIZE}`,
    );
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
    await query<StaleClaim>(
      db,
      sql`select task_id, kind, due_date, claim_token, attempts, refused_attempts,
        claimed_at
      from discord_bot.reminder_log
      where state = 'claimed' and claimed_at < ${claimedBefore.toISOString()}
      order by claimed_at, task_id, kind, due_date
      limit ${MAX_STALE_CLAIMS + 1}`,
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
    const [claimed] = await tx
      .insert(reminderLog)
      .select(
        dsql`select ${tasks.id}, ${key.kind}::discord_bot.reminder_kind, ${tasks.dueDate},
          'claimed'::discord_bot.reminder_state, gen_random_uuid(), 1, now(),
          null::timestamptz, null::discord_bot.discord_id, 0
          ${fromRemindableTask(key.taskId, key.dueDate)}`,
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
        claimToken: dsql`gen_random_uuid()`,
        claimedAt: dsql`now()`,
        attempts: dsql`${reminderLog.attempts} + 1`,
      })
      .where(
        and(
          heldClaim(key),
          lt(
            reminderLog.claimedAt,
            dsql`now() - make_interval(secs => ${STALE_CLAIM_MS / 1000}::int)`,
          ),
          exists(
            dsql`(select 1 ${fromRemindableTask(dsql`${reminderLog.taskId}`, key.dueDate)})`,
          ),
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
    ) ?? dsql`true`
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
      .set({ state: "sent", sentAt: dsql`now()`, messageId: key.messageId })
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
      .set({ refusedAttempts: dsql`${reminderLog.refusedAttempts} + 1` })
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
