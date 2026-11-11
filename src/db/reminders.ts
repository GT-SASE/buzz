import type { DateOnly } from "../lib/dates.ts";
import { isSnowflake } from "../lib/snowflake.ts";
import { REMINDER_KINDS } from "../reminders/plan.ts";
import type { DbClient } from "./client.ts";
import { failure, refused, type DbResult } from "./errors.ts";
import { rest } from "./internal.ts";
import {
  booleanValue,
  cappedList,
  integerValue,
  nullableUuidValue,
  oneOrNone,
  rowList,
  type CappedList,
} from "./result.ts";
import {
  parseCandidateCursor,
  parseClaimState,
  parseReminderCandidate,
  parseStaleClaim,
  parseTaskLiveness,
  type ExcludedRow,
  type ReminderCandidate,
  type ReminderKind,
  type StaleClaim,
} from "./types.ts";
import { isDbDate, isInstant, isUuid, keysetAfter } from "./validate.ts";

const PAGE_SIZE = 500;
const MAX_PAGES = 20;
const MAX_STALE_CLAIMS = 500;
/** Sorts before every row: the earliest date the column allows, and the lowest ID. */
const FIRST_POSITION = {
  dueDate: "2000-01-01",
  id: "00000000-0000-0000-0000-000000000000",
};

/**
 * Open tasks due up to a date, across all guilds, with every condition that can stop
 * a send: the task, its event, its channel and the guild's reminder switch. These are
 * filters on `!inner` joins, so a parent that fails one removes the task.
 *
 * A filter here cannot compare a log row's date with its task's date, so each task
 * carries its whole log and the planner decides what has already gone out.
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
  const excluded: ExcludedRow[] = [];
  let position = FIRST_POSITION;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await rest(db)
      .from("tasks")
      .select(
        "id,event_id,guild_id,assignee_id,description,due_date,status,updated_at,events!inner(id,name,thread_id,status,thread_status,thread_refusals,managed_channels!inner(guild_config!inner(timezone))),reminder_log(kind,due_date,state,claimed_at)",
      )
      .eq("status", "open")
      .is("deleted_at", null)
      .lte("due_date", lastDueDate)
      .eq("events.status", "active")
      .is("events.deleted_at", null)
      .eq("events.managed_channels.status", "active")
      .is("events.managed_channels.guild_config.reminders_enabled", true)
      .or(keysetAfter(position.dueDate, position.id))
      .order("due_date")
      .order("id")
      .limit(PAGE_SIZE);
    const list = rowList(response, parseReminderCandidate);
    if (!list.ok) {
      return list;
    }
    rows.push(...list.value.rows);
    excluded.push(...list.value.excluded);
    const count = list.value.rows.length + list.value.excluded.length;
    if (count < PAGE_SIZE) {
      return { ok: true, value: { rows, excluded, truncated: false } };
    }
    const data: unknown = response.data;
    const last = parseCandidateCursor(
      Array.isArray(data) ? (data as unknown[]).at(-1) : undefined,
    );
    if (!last.ok) {
      // A row with no readable position leaves nowhere to continue from.
      return { ok: true, value: { rows, excluded, truncated: true } };
    }
    position = last.row;
  }
  return { ok: true, value: { rows, excluded, truncated: true } };
}

/** Claims left unfinished since before the cutoff, oldest first. */
export async function listStaleClaims(
  db: DbClient,
  { claimedBefore }: { claimedBefore: Date },
): Promise<DbResult<CappedList<StaleClaim>>> {
  if (!isInstant(claimedBefore)) {
    return refused();
  }
  return cappedList(
    await rest(db)
      .from("reminder_log")
      .select(
        "task_id,kind,due_date,claim_token,attempts,refused_attempts,claimed_at",
      )
      .eq("state", "claimed")
      .lt("claimed_at", claimedBefore.toISOString())
      .order("claimed_at")
      .order("task_id")
      .order("kind")
      .order("due_date")
      .limit(MAX_STALE_CLAIMS + 1),
    parseStaleClaim,
    MAX_STALE_CLAIMS,
  );
}

export interface ReminderKey {
  taskId: string;
  kind: ReminderKind;
  dueDate: DateOnly;
}

function isReminderKey({ taskId, kind, dueDate }: ReminderKey): boolean {
  return isUuid(taskId) && REMINDER_KINDS.includes(kind) && isDbDate(dueDate);
}

/**
 * The task as a caller read it. A claim that names this fails as `task_changed` if the
 * task has since been reassigned or edited, because what the caller rendered is out of date.
 */
export interface TaskAsRead {
  assigneeId: string;
  updatedAt: string;
}

function isTaskAsRead(read: TaskAsRead | undefined): boolean {
  return (
    read === undefined ||
    (isSnowflake(read.assigneeId) && isInstant(new Date(read.updatedAt)))
  );
}

/**
 * Returns a claim token, or null if someone else holds it, the task has moved on, or
 * its event, channel or guild no longer allow reminders.
 */
export async function claimReminder(
  db: DbClient,
  key: ReminderKey & { asRead?: TaskAsRead | undefined },
): Promise<DbResult<string | null>> {
  if (!isReminderKey(key) || !isTaskAsRead(key.asRead)) {
    return refused();
  }
  return nullableUuidValue(
    await rest(db).rpc("claim_reminder", {
      p_task_id: key.taskId,
      p_kind: key.kind,
      p_due_date: key.dueDate,
      p_assignee_id: key.asRead?.assigneeId ?? null,
      p_updated_at: key.asRead?.updatedAt ?? null,
    }),
  );
}

/** Takes over a stale claim given its last token. Null if that is no longer possible. */
export async function reclaimReminder(
  db: DbClient,
  key: ReminderKey & { claimToken: string; asRead?: TaskAsRead | undefined },
): Promise<DbResult<string | null>> {
  if (
    !isReminderKey(key) ||
    !isUuid(key.claimToken) ||
    !isTaskAsRead(key.asRead)
  ) {
    return refused();
  }
  return nullableUuidValue(
    await rest(db).rpc("reclaim_reminder", {
      p_task_id: key.taskId,
      p_kind: key.kind,
      p_due_date: key.dueDate,
      p_claim_token: key.claimToken,
      p_assignee_id: key.asRead?.assigneeId ?? null,
      p_updated_at: key.asRead?.updatedAt ?? null,
    }),
  );
}

export type StaleClaimOutcome =
  /** Taken over. Send the reminder and mark it with this token. */
  | { readonly outcome: "reclaimed"; readonly claimToken: string }
  /** The task is done, deleted or moved, so the claim was recorded as skipped. */
  | { readonly outcome: "closed" }
  /** Left alone and may come back: fresh, reminders paused, or someone else's now. */
  | { readonly outcome: "left" };

/**
 * Deals with one claim from `listStaleClaims`. Without this, a claim on a finished
 * task would stay listed forever, since a reclaim refuses it. A claim is closed only
 * when its task is finished, not when reminders are merely paused, because a closed
 * claim would not go out if they were turned back on.
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
 * Closes a stale claim if its task is finished, and otherwise leaves it exactly as it
 * is, with no takeover and no rise in `attempts`. For a claim the run has no intention
 * of sending, such as one on a task the plan left out.
 */
export async function closeStaleClaim(
  db: DbClient,
  key: ReminderKey & { claimToken: string },
): Promise<DbResult<Exclude<StaleClaimOutcome, { outcome: "reclaimed" }>>> {
  if (!isReminderKey(key) || !isUuid(key.claimToken)) {
    return refused();
  }
  const claim = oneOrNone(
    await rest(db)
      .from("reminder_log")
      .select("state,claim_token")
      .eq("task_id", key.taskId)
      .eq("kind", key.kind)
      .eq("due_date", key.dueDate)
      .limit(1),
    parseClaimState,
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

  const task = oneOrNone(
    await rest(db)
      .from("tasks")
      .select("due_date,status,deleted_at")
      .eq("id", key.taskId)
      .limit(1),
    parseTaskLiveness,
  );
  if (!task.ok) {
    return task;
  }
  const stillDue =
    task.value !== null &&
    task.value.status === "open" &&
    task.value.deleted_at === null &&
    task.value.due_date === key.dueDate;
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
  if (
    !isReminderKey(key) ||
    !isUuid(key.claimToken) ||
    !isSnowflake(key.messageId)
  ) {
    return refused();
  }
  return booleanValue(
    await rest(db).rpc("mark_reminder_sent", {
      p_task_id: key.taskId,
      p_kind: key.kind,
      p_due_date: key.dueDate,
      p_claim_token: key.claimToken,
      p_message_id: key.messageId,
    }),
  );
}

/** False if the token no longer holds the claim. */
export async function markReminderSkipped(
  db: DbClient,
  key: ReminderKey & { claimToken: string },
): Promise<DbResult<boolean>> {
  if (!isReminderKey(key) || !isUuid(key.claimToken)) {
    return refused();
  }
  return booleanValue(
    await rest(db).rpc("mark_reminder_skipped", {
      p_task_id: key.taskId,
      p_kind: key.kind,
      p_due_date: key.dueDate,
      p_claim_token: key.claimToken,
    }),
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
  if (!isReminderKey(key) || !isUuid(key.claimToken)) {
    return refused();
  }
  return booleanValue(
    await rest(db).rpc("record_reminder_refused", {
      p_task_id: key.taskId,
      p_kind: key.kind,
      p_due_date: key.dueDate,
      p_claim_token: key.claimToken,
    }),
  );
}

export interface ThreadRefusalKey {
  guildId: string;
  eventId: string;
}

function isThreadRefusalKey({ guildId, eventId }: ThreadRefusalKey): boolean {
  return isSnowflake(guildId) && isUuid(eventId);
}

/** Returns how many runs in a row this event's thread has now refused the bot. */
export async function recordThreadRefusal(
  db: DbClient,
  key: ThreadRefusalKey,
): Promise<DbResult<number>> {
  if (!isThreadRefusalKey(key)) {
    return refused();
  }
  const response = await rest(db).rpc("record_thread_refusal", {
    p_event_id: key.eventId,
    p_guild_id: key.guildId,
  });
  // The function returns null when there is no live event with that ID in that guild.
  if (response.error === null && response.data === null) {
    return failure("not_found");
  }
  return integerValue(response);
}

/** For after a send to the thread has landed. False if there was nothing to clear. */
export async function clearThreadRefusals(
  db: DbClient,
  key: ThreadRefusalKey,
): Promise<DbResult<boolean>> {
  if (!isThreadRefusalKey(key)) {
    return refused();
  }
  return booleanValue(
    await rest(db).rpc("clear_thread_refusals", {
      p_event_id: key.eventId,
      p_guild_id: key.guildId,
    }),
  );
}
