import type { DateOnly } from "../lib/dates.ts";
import type { DbClient } from "./client.ts";
import { refused, type DbResult } from "./errors.ts";
import { callFunction, capped, firstRow, query, sql } from "./internal.ts";
import type {
  CappedList,
  EventStatus,
  ManagedChannelStatus,
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
          from reminder_log l where l.task_id = t.id
        ), '[]'::json) as log
      from tasks t
      join events e on e.id = t.event_id and e.guild_id = t.guild_id
      join managed_channels c
        on c.guild_id = e.guild_id and c.channel_id = e.channel_id
      join guild_config g on g.guild_id = e.guild_id
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
      from reminder_log
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
  return callFunction<string | null>(
    db,
    sql`select public.claim_reminder(p_task_id => ${key.taskId},
      p_kind => ${key.kind},
      p_due_date => ${key.dueDate},
      p_assignee_id => ${key.asRead?.assigneeId ?? null},
      p_updated_at => ${key.asRead?.updatedAt ?? null}) as value`,
  );
}

/** Takes over a stale claim given its last token. Null if that is no longer possible. */
export async function reclaimReminder(
  db: DbClient,
  key: ReminderKey & { claimToken: string; asRead?: TaskAsRead | undefined },
): Promise<DbResult<string | null>> {
  if (!isDbDate(key.dueDate)) {
    return refused();
  }
  return callFunction<string | null>(
    db,
    sql`select public.reclaim_reminder(p_task_id => ${key.taskId},
      p_kind => ${key.kind},
      p_due_date => ${key.dueDate},
      p_claim_token => ${key.claimToken},
      p_assignee_id => ${key.asRead?.assigneeId ?? null},
      p_updated_at => ${key.asRead?.updatedAt ?? null}) as value`,
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
  const claim = firstRow(
    await query<{ state: ReminderState; claim_token: string }>(
      db,
      sql`select state, claim_token from reminder_log
      where task_id = ${key.taskId} and kind = ${key.kind}
        and due_date = ${key.dueDate}
      limit 1`,
    ),
  );
  if (!claim.ok) {
    return claim;
  }
  if (
    claim.value?.state !== "claimed" ||
    claim.value.claim_token !== key.claimToken
  ) {
    return { ok: true, value: { outcome: "left" } };
  }

  const task = firstRow(
    await query<{
      due_date: DateOnly;
      status: TaskStatus;
      deleted_at: string | null;
      event_status: EventStatus | null;
      event_deleted_at: string | null;
      thread_status: ThreadStatus | null;
      forum_status: ManagedChannelStatus | null;
    }>(
      db,
      sql`select t.due_date, t.status, t.deleted_at, e.status as event_status,
        e.deleted_at as event_deleted_at, e.thread_status, c.status as forum_status
      from tasks t
      left join events e on e.id = t.event_id and e.guild_id = t.guild_id
      left join managed_channels c
        on c.guild_id = e.guild_id and c.channel_id = e.channel_id
      where t.id = ${key.taskId} limit 1`,
    ),
  );
  if (!task.ok) {
    return task;
  }
  const live = task.value;
  const stillDue =
    live !== null &&
    live.status === "open" &&
    live.deleted_at === null &&
    live.due_date === key.dueDate &&
    live.event_status === "active" &&
    live.event_deleted_at === null &&
    live.thread_status !== "missing" &&
    live.forum_status === "active";
  if (stillDue) {
    return { ok: true, value: { outcome: "left" } };
  }

  const skipped = await markReminderSkipped(db, key);
  if (!skipped.ok) {
    return skipped;
  }
  return { ok: true, value: { outcome: skipped.value ? "closed" : "left" } };
}

/** False if the token no longer holds the claim. */
export async function markReminderSent(
  db: DbClient,
  key: ReminderKey & { claimToken: string; messageId: string },
): Promise<DbResult<boolean>> {
  if (!isDbDate(key.dueDate)) {
    return refused();
  }
  return callFunction<boolean>(
    db,
    sql`select public.mark_reminder_sent(p_task_id => ${key.taskId},
      p_kind => ${key.kind},
      p_due_date => ${key.dueDate},
      p_claim_token => ${key.claimToken},
      p_message_id => ${key.messageId}) as value`,
  );
}

/** False if the token no longer holds the claim. */
export async function markReminderSkipped(
  db: DbClient,
  key: ReminderKey & { claimToken: string },
): Promise<DbResult<boolean>> {
  if (!isDbDate(key.dueDate)) {
    return refused();
  }
  return callFunction<boolean>(
    db,
    sql`select public.mark_reminder_skipped(p_task_id => ${key.taskId},
      p_kind => ${key.kind},
      p_due_date => ${key.dueDate},
      p_claim_token => ${key.claimToken}) as value`,
  );
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
  return callFunction<boolean>(
    db,
    sql`select public.record_reminder_refused(p_task_id => ${key.taskId},
      p_kind => ${key.kind},
      p_due_date => ${key.dueDate},
      p_claim_token => ${key.claimToken}) as value`,
  );
}
