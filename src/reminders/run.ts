/**
 * One reminder run: take the job's lock, read what is due, plan it per guild, then for
 * each reminder claim, send and mark sent. The task reminders go first, then the event
 * workflow reminders in `event-run.ts`, which use this run's sends and failure handling.
 *
 * Nothing here decides what to do about a failure from its text. `job_runs` stores
 * whole-number counts and a `category:code`, and log lines hold fixed text and IDs, so
 * task text cannot reach either.
 *
 * Make one Discord client per invocation, never per process. Its memory of a refused
 * token and of unavailable channels lasts as long as it does, which is what stops a
 * run after the first 401, and must not carry over to the next day.
 */

import { withDeadline, type DbClient } from "../db/client.ts";
import { errorSummary, type DbError } from "../db/errors.ts";
import { getEvent, markEventThreadMissing } from "../db/events.ts";
import {
  MAX_EVENT_IDS_IN_RESULTS,
  beginJobRun,
  finishJobRun,
  type JobResults,
  type JobRunError,
} from "../db/job-runs.ts";
import { markChannelUnavailable } from "../db/managed-channels.ts";
import {
  claimReminder,
  closeStaleClaim,
  listReminderCandidates,
  listStaleClaims,
  markReminderSent,
  markReminderSkipped,
  recordReminderRefused,
  resolveStaleClaim,
  type ReminderKey,
  type TaskAsRead,
} from "../db/reminders.ts";
import type { ReminderCandidate, StaleClaim } from "../db/types.ts";
import {
  DiscordClientError,
  DiscordErrorCode,
  actionForFailure,
  mayHaveLanded,
  type DiscordClient,
  type DiscordFailure,
} from "../discord/client.ts";
import { channelMessage, type Part } from "../discord/outbound.ts";
import type { Chunk, ChunkLine, SafeText } from "../discord/safe-text.ts";
import { isUsableTimeZone, parseIsoDate, type DateOnly } from "../lib/dates.ts";
import {
  EventReminderStep,
  type EventRunHost,
  type RunBudget,
} from "./event-run.ts";
import {
  FUNCTION_MAX_MS,
  MAX_ATTEMPTS_WITH_PING,
  OPENS_AT_DAYS_BEFORE,
  slotStart,
  slotToday,
  STALE_CLAIM_MS,
  planReminders,
  type EventReminders,
  type ReminderPlan,
  type ReminderRef,
} from "./plan.ts";
import {
  packBatches,
  renderEventHeader,
  renderMessages,
  renderReminderLine,
  type Batch,
} from "./render.ts";

export const DISCORD_OPERATION_MS = 6_000;
export const DATABASE_CALL_MS = 4_000;
const WORK_MARGIN_MS = 2_000;
/**
 * Inside the function's time limit (`FUNCTION_MAX_MS`), no new claim or send starts after
 * `RUN_WORK_MS`. What is under way can still take a claim and one Discord operation, and
 * no mark starts after `RUN_HARD_STOP_MS`, which leaves time for the last marks to end
 * and the run to record itself inside that limit.
 */
export const RUN_HARD_STOP_MS = FUNCTION_MAX_MS - 2 * DATABASE_CALL_MS;
const RUN_WORK_MS =
  RUN_HARD_STOP_MS - DATABASE_CALL_MS - DISCORD_OPERATION_MS - WORK_MARGIN_MS;
/** Longer than the function can live, so a 'running' row this old is a killed run. */
export const LOCK_STALE_SECONDS = (2 * FUNCTION_MAX_MS) / 1000;
/**
 * Discord's answers that blame the thread, or the bot's place in the server, and not the
 * message. 50001 also comes back for every channel once the bot is removed from the server,
 * and a locked post gives 160005.
 */
const THREAD_REFUSED: ReadonlySet<number | undefined> = new Set([
  DiscordErrorCode.MissingAccess,
  DiscordErrorCode.MissingPermissions,
  10004, // Unknown Guild
  160005, // Thread locked
]);

export interface RunLimits {
  /** Send attempts per run. What does not fit is left unclaimed for the next day. */
  readonly maxMessages: number;
  readonly workMs: number;
  readonly hardStopMs: number;
}

export const DEFAULT_LIMITS: RunLimits = {
  maxMessages: 100,
  workMs: RUN_WORK_MS,
  hardStopMs: RUN_HARD_STOP_MS,
};

const DB_CONCURRENCY = 8;
const MAX_LOG_LINES = 50;
const MS_PER_DAY = 86_400_000;
// Today somewhere is at most one date ahead of UTC, and a task's first reminder opens
// this many days before its due date. Event reminders read their own candidates.
const CANDIDATE_DAYS_AHEAD =
  Math.max(...Object.values(OPENS_AT_DAYS_BEFORE)) + 1;

export interface RunDependencies {
  readonly db: DbClient;
  readonly client: DiscordClient;
  readonly allowedGuildIds: ReadonlySet<string>;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
  readonly limits?: Partial<RunLimits>;
}

export type RunResult =
  /** Another run holds the lock, or one succeeded in this slot. Nothing was done. */
  | { readonly status: "duplicate" }
  | {
      readonly status: "succeeded" | "failed";
      readonly id: string | null;
      readonly results: JobResults;
      readonly error: string | null;
    };

class Counts {
  readonly #values = new Map<string, number>();

  add(key: string, by = 1): void {
    if (by !== 0) {
      this.#values.set(key, (this.#values.get(key) ?? 0) + by);
    }
  }

  toResults(): Record<string, number> {
    return Object.fromEntries(this.#values);
  }
}

/** Runs `work` on each item with a limit on how many run at once, in order of start. */
async function forEachLimited<T>(
  items: readonly T[],
  shouldStart: () => boolean,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const item = items[next];
      if (next >= items.length || item === undefined || !shouldStart()) {
        return;
      }
      next += 1;
      await work(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(DB_CONCURRENCY, items.length) }, worker),
  );
}

function keyOf(ref: ReminderKey): string {
  return `${ref.taskId}:${ref.dueDate}:${ref.kind}`;
}

interface Item {
  readonly ref: ReminderRef;
  readonly asRead: TaskAsRead;
  readonly line: ChunkLine;
  readonly row: Part<"row">;
}

interface Claimed extends Item {
  readonly claimToken: string;
}

interface ClaimHeld {
  readonly claimToken: string;
  /** Sends that may reach someone, counting the one this claim is for. */
  readonly possibleDeliveries: number;
}

/** The event whose thread a send went to. */
export interface ThreadTarget {
  readonly guildId: string;
  readonly eventId: string;
}

export interface ThreadMessage {
  readonly guildId: string;
  readonly threadId: string;
  readonly content: SafeText;
  readonly mentionUserIds: readonly string[];
  /** Only ever roles from the guild's own config row. */
  readonly mentionRoleIds: readonly string[];
  readonly components?: readonly Part<"row">[];
}

/** What is left of a failed send once the run has dealt with the thread and forum. */
export type FailureOutcome = "handled" | "retry_later" | "skip_item";

interface GuildPlan {
  readonly guildId: string;
  readonly today: DateOnly;
  readonly plan: ReminderPlan;
  readonly rows: ReadonlyMap<string, ReminderCandidate>;
}

function targetOf(guild: GuildPlan, event: EventReminders): ThreadTarget {
  return { guildId: guild.guildId, eventId: event.eventId };
}

function groupByGuild(
  rows: readonly ReminderCandidate[],
): Map<string, ReminderCandidate[]> {
  const guilds = new Map<string, ReminderCandidate[]>();
  for (const row of rows) {
    const list = guilds.get(row.guild_id);
    if (list === undefined) {
      guilds.set(row.guild_id, [row]);
    } else {
      list.push(row);
    }
  }
  return guilds;
}

function lastCandidateDate(now: Date): DateOnly | null {
  return parseIsoDate(
    new Date(now.getTime() + CANDIDATE_DAYS_AHEAD * MS_PER_DAY)
      .toISOString()
      .slice(0, 10),
  );
}

function discordError(failure: DiscordFailure): JobRunError {
  switch (failure.kind) {
    case "unauthorized":
      return { category: "discord_unauthorized", code: "401" };
    case "rate_limited":
      return { category: "discord_rate_limited", code: "429" };
    case "channel_unavailable":
    case "api":
      return {
        category: "discord_api",
        code: String(failure.code ?? failure.status),
      };
    case "invalid_response":
      return { category: "discord_api", code: String(failure.status) };
    default:
      return { category: "discord_failure", code: null };
  }
}

/** Refuses to treat anything but a thrown client error as a Discord failure. */
function failureOf(error: unknown): DiscordFailure | null {
  return error instanceof DiscordClientError ? error.failure : null;
}

type ForumState = "present" | "gone" | "refused" | "unknown";

/** True when Discord's answer blames the thread and not the message or an outage. */
function isThreadRefusal(failure: DiscordFailure): boolean {
  return (
    (failure.kind === "channel_unavailable" ||
      (failure.kind === "api" && failure.status < 500)) &&
    THREAD_REFUSED.has(failure.code)
  );
}

/**
 * True when the failure is about where the send went: a malformed or unmanaged target, a
 * channel that is not a forum, or a refusal that cannot have landed (`mayHaveLanded`)
 * and is not about the text. Nothing about the send or the run would change on a retry
 * within this run.
 */
function isTargetFailure(failure: DiscordFailure): boolean {
  switch (failure.kind) {
    case "invalid_target":
    case "unmanaged_target":
    case "not_forum":
      return true;
    case "api":
      return !mayHaveLanded(failure);
    default:
      return false;
  }
}

/**
 * False for a failure after which the message may exist: no response, a response that could
 * not be read, a server error, or an error that is not the client's.
 */
function knownNotSent(failure: DiscordFailure): boolean {
  if (failure.kind === "network" || failure.kind === "invalid_response") {
    return false;
  }
  return failure.kind !== "api" || failure.status < 500;
}

/** One event's messages, and how far through them a run has got. */
interface EventCursor {
  readonly event: EventReminders;
  readonly header: ChunkLine;
  readonly batches: readonly Batch<Item>[];
  index: number;
}

/** What one guild has left to send. */
interface GuildTurns {
  readonly guild: GuildPlan;
  readonly events: readonly EventReminders[];
  nextEvent: number;
  current: EventCursor | null;
  blocked: "deferred_cap" | null;
}

class Run {
  readonly counts = new Counts();
  /** What ended the run, which marks it failed. */
  error: JobRunError | null = null;

  readonly #db: DbClient;
  readonly #client: DiscordClient;
  readonly #allowedGuildIds: ReadonlySet<string>;
  readonly #now: () => Date;
  readonly #log: (line: string) => void;
  readonly #limits: RunLimits;
  readonly #deadline: number;
  readonly #hardStop: number;
  readonly #staleClaims = new Map<string, StaleClaim>();
  readonly #forums = new Map<string, ForumState>();
  readonly #missingEventIds = new Set<string>();
  #sendAttempts = 0;
  #logLines = 0;
  /** A failure that more requests would not get past: nothing further this run. */
  #halted = false;
  /** Something meant to go out did not, for a reason other than the message cap. */
  #incomplete = false;

  constructor(dependencies: RunDependencies, db: DbClient) {
    this.#db = db;
    this.#client = dependencies.client;
    this.#allowedGuildIds = dependencies.allowedGuildIds;
    this.#now = dependencies.now ?? (() => new Date());
    this.#log =
      dependencies.log ??
      ((line) => {
        console.warn(line);
      });
    this.#limits = { ...DEFAULT_LIMITS, ...dependencies.limits };
    const start = this.#now().getTime();
    this.#deadline = start + this.#limits.workMs;
    this.#hardStop = start + this.#limits.hardStopMs;
  }

  /** Counts, and which events a person needs to look at, for the run's row. */
  results(): JobResults {
    const named = (ids: ReadonlySet<string>) =>
      [...ids].slice(0, MAX_EVENT_IDS_IN_RESULTS);
    return {
      ...this.counts.toResults(),
      ...(this.#missingEventIds.size > 0
        ? { missing_event_ids: named(this.#missingEventIds) }
        : {}),
    };
  }

  logLine(line: string): void {
    if (this.#logLines < MAX_LOG_LINES) {
      this.#log(line);
    }
    this.#logLines += 1;
  }

  #pastDeadline(): boolean {
    return this.#now().getTime() >= this.#deadline;
  }

  /** Whether to go on with work that only touches the database. */
  #mayContinue(): boolean {
    return !this.#halted && !this.#pastDeadline();
  }

  #halt(failure: DiscordFailure): void {
    this.#halted = true;
    this.error = discordError(failure);
  }

  /** Counts something that means this run did not do all it should have. */
  #countIncomplete(key: string, by = 1): void {
    this.counts.add(key, by);
    if (by > 0) {
      this.#incomplete = true;
    }
  }

  /** Past the hard stop first, since marks may go on while halted but not past it. */
  #budget(): RunBudget {
    if (this.#now().getTime() >= this.#hardStop) {
      return "hard_stop";
    }
    if (this.#halted) {
      return "halted";
    }
    if (this.#pastDeadline()) {
      return "deadline";
    }
    return this.#sendAttempts + 1 > this.#limits.maxMessages ? "cap" : "open";
  }

  async work(): Promise<void> {
    const now = this.#now();
    await this.#taskReminders(now);
    // Under the same lock, cap and deadlines as the task reminders.
    const step = new EventReminderStep(
      this.#db,
      this.#allowedGuildIds,
      this.#eventHost(),
    );
    const { missingEventIds } = await step.run(now);
    for (const eventId of missingEventIds) {
      this.#noteMissing(eventId);
    }
    if (this.#incomplete) {
      // A failed run leaves the slot open, so the recovery cron tries again today, and
      // a monitor reading the last success sees the gap.
      this.error ??= { category: "reminders_incomplete", code: null };
    }
  }

  /** What the event reminder step may use of this run. */
  #eventHost(): EventRunHost {
    return {
      send: (message) => this.#sendToThread(message),
      handleFailure: async (target, error) => {
        const failure = failureOf(error);
        return failure === null ? null : this.#handleFailure(target, failure);
      },
      count: (key, by, incomplete) => {
        if (incomplete === true) {
          this.#countIncomplete(key, by);
        } else {
          this.counts.add(key, by);
        }
      },
      log: (line) => {
        this.logLine(line);
      },
      budget: () => this.#budget(),
    };
  }

  async #taskReminders(now: Date): Promise<void> {
    const lastDueDate = lastCandidateDate(now);
    if (lastDueDate === null) {
      this.error = { category: "bad_clock", code: null };
      return;
    }
    const candidates = await listReminderCandidates(this.#db, { lastDueDate });
    if (!candidates.ok) {
      this.error = candidates.error;
      return;
    }
    const { rows, truncated } = candidates.value;
    this.counts.add("candidates", rows.length);
    if (truncated) {
      this.counts.add("truncated");
      this.logLine("Reminder candidates truncated: rows remain unread");
    }

    await this.#readStaleClaims(now);
    const plans = this.#planGuilds(rows, now);

    await this.#sendInTurns(plans);
    for (const guild of plans) {
      await this.#recordSkips(guild.plan.skips);
    }
    await this.#closeUnplannedStaleClaims(plans);
  }

  async #readStaleClaims(now: Date): Promise<void> {
    const stale = await listStaleClaims(this.#db, {
      claimedBefore: new Date(now.getTime() - STALE_CLAIM_MS),
    });
    if (!stale.ok) {
      // A stale claim waits for the next run, and claiming it here returns null.
      this.#countIncomplete("stale_read_failed");
      return;
    }
    this.counts.add("stale_found", stale.value.rows.length);
    if (stale.value.truncated) {
      // The oldest are read first, and those beyond the cap wait for the next run. Closing
      // or sending these makes room, so the recovery run is asked to go on with them.
      this.#countIncomplete("stale_truncated");
    }
    for (const claim of stale.value.rows) {
      this.#staleClaims.set(
        keyOf({
          taskId: claim.task_id,
          kind: claim.kind,
          dueDate: claim.due_date,
        }),
        claim,
      );
    }
  }

  #planGuilds(rows: readonly ReminderCandidate[], now: Date): GuildPlan[] {
    const plans: GuildPlan[] = [];
    for (const [guildId, guildRows] of groupByGuild(rows)) {
      if (!this.#allowedGuildIds.has(guildId)) {
        this.counts.add("guilds_not_allowed");
        continue;
      }
      const plan = this.#planGuild(guildId, guildRows, now);
      if (plan !== null) {
        plans.push(plan);
      }
    }
    return plans;
  }

  /** A zone that fails here stops only that guild, but the run must say so. */
  #planGuild(
    guildId: string,
    rows: readonly ReminderCandidate[],
    now: Date,
  ): GuildPlan | null {
    this.counts.add("guilds");
    let today: DateOnly;
    let plan: ReminderPlan;
    try {
      const timezone = rows[0]?.timezone ?? "";
      if (!isUsableTimeZone(timezone)) {
        throw new RangeError("unusable time zone");
      }
      today = slotToday(now, timezone);
      plan = planReminders({
        today,
        now,
        // The candidate query only returns guilds with reminders on.
        remindersEnabled: true,
        events: rows.map((row) => row.event),
        tasks: rows.map((row) => row.task),
        log: rows.flatMap((row) => row.log),
      });
    } catch {
      this.counts.add("guilds_invalid_zone");
      this.logLine(`Reminder plan failed for guild ${guildId}`);
      this.error ??= { category: "guild_plan_failed", code: null };
      return null;
    }
    this.counts.add("invalid_tasks", plan.invalidTaskIds.length);
    for (const id of plan.invalidTaskIds) {
      this.logLine(`Reminder plan left out task ${id}`);
    }
    this.counts.add(
      "planned",
      plan.events.reduce((sum, event) => sum + event.reminders.length, 0),
    );
    this.counts.add("skips_planned", plan.skips.length);
    // Without this, a rerun soon after a failed run would find nothing to do, record a
    // success and close the slot, and the recovery cron would not send them.
    this.#countIncomplete("fresh_claims_waiting", plan.freshClaims.length);
    for (const eventId of plan.missingThreadEventIds) {
      this.counts.add("events_stopped");
      this.#noteMissing(eventId);
    }
    return {
      guildId,
      today,
      plan,
      rows: new Map(rows.map((row) => [row.task.id, row])),
    };
  }

  #noteMissing(eventId: string): void {
    if (!this.#missingEventIds.has(eventId)) {
      this.#missingEventIds.add(eventId);
      this.logLine(
        `Reminders stopped for event ${eventId}: its post is gone, until /event link gives it a new one`,
      );
    }
  }

  /** Events with a stale claim failed before, so they wait behind fresh ones. */
  #eventsInOrder(guild: GuildPlan): EventReminders[] {
    const goesLast = (event: EventReminders) =>
      event.reminders.some((ref) => this.#staleClaims.has(keyOf(ref)));
    return [
      ...guild.plan.events.filter((event) => !goesLast(event)),
      ...guild.plan.events.filter(goesLast),
    ];
  }

  /**
   * Guilds take turns, one batch each, so neither a failing guild nor a busy one can use
   * up what the others need, and what one guild has no use for flows to the rest.
   */
  async #sendInTurns(plans: readonly GuildPlan[]): Promise<void> {
    let active = plans.map((guild): GuildTurns => ({
      guild,
      events: this.#eventsInOrder(guild),
      nextEvent: 0,
      current: null,
      blocked: null,
    }));
    while (active.length > 0) {
      const still: GuildTurns[] = [];
      for (const turns of active) {
        if (await this.#takeTurn(turns)) {
          still.push(turns);
        }
      }
      active = still;
    }
  }

  /** The event being sent, moving on to the next if need be. Null if none are left. */
  #currentCursor(turns: GuildTurns): EventCursor | null {
    for (;;) {
      const { current } = turns;
      if (current !== null && current.index < current.batches.length) {
        return current;
      }
      const event = turns.events[turns.nextEvent];
      if (event === undefined) {
        turns.current = null;
        return null;
      }
      turns.nextEvent += 1;
      try {
        const first = turns.guild.rows.get(event.reminders[0]?.taskId ?? "");
        const header = renderEventHeader(first?.event_name ?? "");
        const items = this.#renderItems(turns.guild, event, header);
        turns.current = {
          event,
          header,
          batches: packBatches(header, items, (item) => item.line),
          index: 0,
        };
      } catch {
        this.#countIncomplete("event_errors");
        turns.current = null;
      }
    }
  }

  #itemsLeft(turns: GuildTurns, cursor: EventCursor): number {
    const inEvent = cursor.batches
      .slice(cursor.index)
      .reduce((sum, batch) => sum + batch.items.length, 0);
    const inLaterEvents = turns.events
      .slice(turns.nextEvent)
      .reduce((sum, event) => sum + event.reminders.length, 0);
    return inEvent + inLaterEvents;
  }

  /** Why this guild's next batch may not go, as the count its items are added to. */
  #blockFor(
    turns: GuildTurns,
    messages: number,
  ): "deferred_cap" | "deferred_halted" | "deferred_deadline" | null {
    if (this.#halted) {
      return "deferred_halted";
    }
    if (this.#pastDeadline()) {
      return "deferred_deadline";
    }
    if (
      turns.blocked === null &&
      this.#sendAttempts + messages > this.#limits.maxMessages
    ) {
      // Later batches of this guild may be smaller, but they are less urgent.
      turns.blocked = "deferred_cap";
    }
    return turns.blocked;
  }

  /** Sends one batch. False if this guild has no more to do this run. */
  async #takeTurn(turns: GuildTurns): Promise<boolean> {
    const cursor = this.#currentCursor(turns);
    const batch = cursor?.batches[cursor.index];
    if (cursor === null || batch === undefined) {
      return false;
    }
    const block = this.#blockFor(turns, batch.messages.length);
    if (block !== null) {
      const left = this.#itemsLeft(turns, cursor);
      // Only the cap is a decision. The rest mean a run that did not finish its work.
      if (block === "deferred_cap") {
        this.counts.add(block, left);
        this.logLine(
          `Reminders left for later at the message cap: ${String(left)} in guild ${turns.guild.guildId}`,
        );
      } else {
        this.#countIncomplete(block, left);
      }
      return false;
    }
    cursor.index += 1;
    let complete = false;
    try {
      complete = await this.#sendBatch(turns, cursor, batch.items);
    } catch {
      this.#countIncomplete("event_errors");
    }
    if (!complete) {
      const left = cursor.batches
        .slice(cursor.index)
        .reduce((sum, each) => sum + each.items.length, 0);
      this.#countIncomplete("deferred_event", left);
      turns.current = null;
    }
    return true;
  }

  #renderItems(
    guild: GuildPlan,
    event: EventReminders,
    header: ChunkLine,
  ): Item[] {
    const items: Item[] = [];
    for (const ref of event.reminders) {
      const row = guild.rows.get(ref.taskId);
      if (row === undefined) {
        this.counts.add("render_failed");
        continue;
      }
      try {
        const {
          line,
          row: buttons,
          usedStandIn,
        } = renderReminderLine({
          taskId: ref.taskId,
          assigneeId: row.assignee_id,
          description: row.description,
          dueDate: ref.dueDate,
          today: guild.today,
        });
        // Text that cannot be split into messages fails here, by itself, and not
        // later for its whole event.
        renderMessages(header, [line]);
        if (usedStandIn) {
          this.counts.add("render_stand_in");
        }
        items.push({
          ref,
          asRead: { assigneeId: row.assignee_id, updatedAt: row.updated_at },
          line,
          row: buttons,
        });
      } catch {
        this.counts.add("render_failed");
      }
    }
    return items;
  }

  /** A task that changed after the read says nothing about the database or Discord. */
  #countClaimError(error: DbError): void {
    if (error.category === "task_changed") {
      // Left unclaimed. A failed run leaves the slot open, so the next one reads it again.
      this.#countIncomplete("claim_outdated");
    } else {
      this.#countIncomplete("claim_failed");
    }
  }

  /**
   * A reclaimed stale claim is claimed here too, just before its send. `asRead` is left out
   * for a claim that only records a skip, which shows nothing to anyone.
   */
  async #claim(
    ref: ReminderRef,
    asRead?: TaskAsRead,
  ): Promise<ClaimHeld | null> {
    const key = keyOf(ref);
    const stale = this.#staleClaims.get(key);
    if (stale === undefined) {
      const claim = await claimReminder(this.#db, { ...ref, asRead });
      if (!claim.ok) {
        this.#countClaimError(claim.error);
        return null;
      }
      return claim.value === null
        ? null
        : { claimToken: claim.value, possibleDeliveries: 1 };
    }
    this.#staleClaims.delete(key);
    const resolved = await resolveStaleClaim(this.#db, {
      ...ref,
      claimToken: stale.claim_token,
      asRead,
    });
    if (!resolved.ok) {
      this.#countClaimError(resolved.error);
      return null;
    }
    this.counts.add(`stale_${resolved.value.outcome}`);
    if (resolved.value.outcome === "left" && asRead !== undefined) {
      // The plan meant to send it, and it could not be taken over, so it is not sent.
      this.#countIncomplete("stale_claim_lost");
    }
    return resolved.value.outcome === "reclaimed"
      ? {
          claimToken: resolved.value.claimToken,
          possibleDeliveries: stale.attempts - stale.refused_attempts + 1,
        }
      : null;
  }

  /** Sent this many times, it has probably pinged: keep it, without the noise. */
  #withoutRepeatPing(item: Item, possibleDeliveries: number): Item {
    if (possibleDeliveries < MAX_ATTEMPTS_WITH_PING) {
      return item;
    }
    this.counts.add("repeat_pings_withheld");
    this.logLine(`Reminder resent without a ping for task ${item.ref.taskId}`);
    return { ...item, line: { ...item.line, mentionUserIds: [] } };
  }

  /** Nothing starts past the deadline, and what did not start stays unclaimed. */
  async #claimAll(items: readonly Item[]): Promise<Claimed[]> {
    const claimed: (Claimed | null)[] = items.map(() => null);
    let started = 0;
    await forEachLimited(
      items.map((item, index) => ({ item, index })),
      () => !this.#pastDeadline(),
      async ({ item, index }) => {
        started += 1;
        const held = await this.#claim(item.ref, item.asRead);
        if (held === null) {
          this.counts.add("claim_lost");
        } else {
          claimed[index] = {
            ...this.#withoutRepeatPing(item, held.possibleDeliveries),
            claimToken: held.claimToken,
          };
        }
      },
    );
    this.#countIncomplete("deferred_deadline", items.length - started);
    return claimed.filter((item) => item !== null);
  }

  async #sendBatch(
    turns: GuildTurns,
    cursor: EventCursor,
    items: readonly Item[],
  ): Promise<boolean> {
    const claimed = await this.#claimAll(items);
    this.counts.add("claimed", claimed.length);
    if (claimed.length === 0) {
      return true;
    }
    return this.#deliver(turns, cursor, claimed);
  }

  /** Sends claimed items and deals with what comes back. False stops this event. */
  async #deliver(
    turns: GuildTurns,
    cursor: EventCursor,
    items: readonly Claimed[],
  ): Promise<boolean> {
    const messages = renderMessages(
      cursor.header,
      items.map((item) => item.line),
    );
    let messageId: string | null = null;
    try {
      for (const [index, message] of messages.entries()) {
        if (messageId !== null && this.#pastDeadline()) {
          // Left claimed, so a later run sends the whole of it again.
          this.#countIncomplete("retry_later", items.length);
          return false;
        }
        // On the last, where the text it belongs to has ended.
        const rows =
          index === messages.length - 1 ? items.map((item) => item.row) : [];
        messageId = await this.#sendMessage(turns, cursor.event, message, rows);
      }
    } catch (error) {
      return this.#handleSendFailure(
        turns,
        cursor,
        items,
        error,
        messageId !== null,
      );
    }
    if (messageId === null) {
      return true;
    }
    await this.#markSent(items, messageId);
    return true;
  }

  /** Failing here leaves the attempt counted, and at worst costs a later ping. */
  async #recordRefused(items: readonly Claimed[]): Promise<void> {
    let started = 0;
    await forEachLimited(
      items,
      () => this.#now().getTime() < this.#hardStop,
      async (item) => {
        started += 1;
        const recorded = await recordReminderRefused(this.#db, {
          ...item.ref,
          claimToken: item.claimToken,
        });
        if (!recorded.ok) {
          this.counts.add("refusals_not_recorded");
        }
      },
    );
    this.counts.add("refusals_not_recorded", items.length - started);
  }

  async #sendMessage(
    turns: GuildTurns,
    event: EventReminders,
    message: Chunk,
    components: readonly Part<"row">[],
  ): Promise<string> {
    return this.#sendToThread({
      guildId: turns.guild.guildId,
      threadId: event.threadId,
      content: message.content,
      mentionUserIds: message.mentionUserIds,
      mentionRoleIds: [],
      components,
    });
  }

  /** The one way a run posts. */
  async #sendToThread(message: ThreadMessage): Promise<string> {
    const { guildId, mentionRoleIds } = message;
    // Counted before the request: a refused send still costs a request, and a cap on
    // successes would let refused text use as many as it liked.
    this.#sendAttempts += 1;
    const resource = await this.#client.sendMessage(
      { kind: "thread", guildId, threadId: message.threadId },
      channelMessage({
        content: message.content,
        mentionUserIds: message.mentionUserIds,
        ...(mentionRoleIds.length === 0
          ? {}
          : { mentionRoleIds, roleGuildId: guildId }),
        ...(message.components === undefined
          ? {}
          : { components: message.components }),
      }),
    );
    this.counts.add("messages_sent");
    return resource.id;
  }

  /**
   * Marks with the last message's ID, since an item's text ended there. A mark not
   * started by the hard stop leaves its claim, so a later run sends it again: at most
   * one repeat, which is better than the platform killing the run mid-way.
   */
  async #markSent(items: readonly Claimed[], messageId: string): Promise<void> {
    let started = 0;
    await forEachLimited(
      items,
      () => this.#now().getTime() < this.#hardStop,
      async (item) => {
        started += 1;
        const marked = await markReminderSent(this.#db, {
          ...item.ref,
          claimToken: item.claimToken,
          messageId,
        });
        if (marked.ok && marked.value) {
          this.counts.add("reminders_sent");
        } else {
          this.#countIncomplete("mark_failed");
        }
      },
    );
    this.#countIncomplete("mark_failed", items.length - started);
  }

  async #handleSendFailure(
    turns: GuildTurns,
    cursor: EventCursor,
    items: readonly Claimed[],
    error: unknown,
    partlySent: boolean,
  ): Promise<boolean> {
    const failure = failureOf(error);
    if (failure === null) {
      this.#countIncomplete("send_errors", items.length);
      return false;
    }
    const action = actionForFailure(failure);
    // A refusal of the text goes on to try each item, and records what it then leaves.
    if (!partlySent && knownNotSent(failure) && action !== "skip_item") {
      await this.#recordRefused(items);
    }
    const outcome = await this.#handleFailure(
      targetOf(turns.guild, cursor.event),
      failure,
    );
    switch (outcome) {
      case "handled":
        return false;
      case "retry_later":
        this.#countIncomplete("retry_later", items.length);
        return false;
      case "skip_item":
        return this.#retryOneByOne(turns, cursor, items, failure, partlySent);
    }
  }

  /**
   * What a failed send to an event's thread says about the thread, its forum and the run.
   * Returns what is left for the caller, which knows what the send was for. A failure
   * that leaves the item for later stops the run unless it is about this event's target,
   * and the recovery cron takes over what it left.
   */
  async #handleFailure(
    target: ThreadTarget,
    failure: DiscordFailure,
  ): Promise<FailureOutcome> {
    if (isThreadRefusal(failure)) {
      this.#countIncomplete("channels_inaccessible");
      this.logLine(
        `Thread refused the bot for event ${target.eventId}: ${errorSummary(discordError(failure))}`,
      );
      return "handled";
    }
    const action = actionForFailure(failure);
    switch (action) {
      case "stop_run":
        this.#halt(failure);
        return "handled";
      case "mark_channel_unavailable":
        await this.#handleChannelUnavailable(target, failure);
        return "handled";
      case "retry_later":
        if (!isTargetFailure(failure)) {
          this.#halt(failure);
        }
        return action;
      case "skip_item":
        return action;
    }
  }

  /**
   * A refusal of the text cannot say which item caused it, so each item goes by itself.
   * One refused alone is recorded as skipped: retrying it daily would not help, and the
   * task's next reminder still gets its own try.
   */
  async #retryOneByOne(
    turns: GuildTurns,
    cursor: EventCursor,
    items: readonly Claimed[],
    failure: DiscordFailure,
    partlySent: boolean,
  ): Promise<boolean> {
    const [only, ...others] = items;
    if (only !== undefined && others.length === 0) {
      this.counts.add("items_refused");
      this.logLine(
        `Reminder refused for task ${only.ref.taskId}: ${errorSummary(discordError(failure))}`,
      );
      const skipped = await markReminderSkipped(this.#db, {
        ...only.ref,
        claimToken: only.claimToken,
      });
      if (!skipped.ok || !skipped.value) {
        this.#countIncomplete("mark_failed");
      }
      return true;
    }
    this.counts.add("batches_retried");
    for (const [index, item] of items.entries()) {
      if (this.#blockFor(turns, 1) !== null) {
        // Claimed already, so a later run takes these over.
        this.#countIncomplete("retry_later");
        if (!partlySent) {
          await this.#recordRefused([item]);
        }
        continue;
      }
      const carryOn = await this.#deliver(turns, cursor, [item]);
      if (!carryOn) {
        // The batch never landed, so the items not tried alone were not sent either.
        if (!partlySent) {
          await this.#recordRefused(items.slice(index + 1));
        }
        return false;
      }
    }
    return true;
  }

  /** The forum refuses the bot too, so this is not about the thread. */
  #countForumRefusal(target: ThreadTarget, failure: DiscordFailure): void {
    this.#countIncomplete("channels_inaccessible");
    this.logLine(
      `Forum refused the bot for event ${target.eventId}: ${errorSummary(discordError(failure))}`,
    );
  }

  /**
   * The send went to a thread, so this can only say the thread failed. Only an explicit
   * Unknown Channel counts as gone, and the forum is disabled only after a GET of the
   * forum itself says the same. A thread's absence does not condemn its forum, and a
   * permissions failure does not either, since it can be undone at any time. A forum that
   * refuses the bot says nothing about the thread, and is what a bot removed from the
   * server can see, so the run stays failed for it.
   */
  async #handleChannelUnavailable(
    target: ThreadTarget,
    failure: DiscordFailure,
  ): Promise<void> {
    if (
      failure.kind !== "channel_unavailable" ||
      failure.code !== DiscordErrorCode.UnknownChannel
    ) {
      this.#countIncomplete("channels_inaccessible");
      return;
    }
    const row = await getEvent(this.#db, {
      guildId: target.guildId,
      eventId: target.eventId,
    });
    if (!row.ok || row.value === null) {
      this.#countIncomplete("thread_check_failed");
      return;
    }
    const channelId = row.value.channel_id;
    const forum = await this.#forumState(target.guildId, channelId);
    if (forum === "gone") {
      const marked = await markChannelUnavailable(this.#db, {
        guildId: target.guildId,
        channelId,
      });
      if (marked.ok) {
        this.counts.add("channels_gone", marked.value ? 1 : 0);
      } else {
        this.#countIncomplete("thread_check_failed");
      }
    } else if (forum === "present") {
      const marked = await markEventThreadMissing(this.#db, {
        guildId: target.guildId,
        eventId: target.eventId,
      });
      if (marked.ok) {
        this.counts.add("threads_missing");
        this.#noteMissing(target.eventId);
      } else {
        this.#countIncomplete("thread_check_failed");
      }
    } else if (forum === "refused") {
      this.#countForumRefusal(target, failure);
    } else {
      this.#countIncomplete("thread_check_failed");
    }
  }

  async #forumState(guildId: string, channelId: string): Promise<ForumState> {
    const known = this.#forums.get(channelId);
    if (known !== undefined) {
      return known;
    }
    let state: ForumState = "unknown";
    try {
      await this.#client.getChannel(guildId, channelId);
      state = "present";
    } catch (error) {
      const failure = failureOf(error);
      if (failure !== null && actionForFailure(failure) === "stop_run") {
        this.#halt(failure);
      } else if (
        failure?.kind === "channel_unavailable" &&
        failure.code === DiscordErrorCode.UnknownChannel
      ) {
        state = "gone";
      } else if (failure !== null && isThreadRefusal(failure)) {
        state = "refused";
      }
    }
    this.#forums.set(channelId, state);
    return state;
  }

  /** Runs after the sends, because these are only records and sends matter more. */
  async #recordSkips(skips: readonly ReminderRef[]): Promise<void> {
    await forEachLimited(
      skips,
      () => this.#mayContinue(),
      async (ref) => {
        const held = await this.#claim(ref);
        if (held === null) {
          this.counts.add("skips_not_claimed");
          return;
        }
        const marked = await markReminderSkipped(this.#db, {
          ...ref,
          claimToken: held.claimToken,
        });
        if (marked.ok && marked.value) {
          this.counts.add("skips_recorded");
        } else {
          this.#countIncomplete("mark_failed");
        }
      },
    );
  }

  /**
   * Stale claims the plan does not name. These are closed if the task is finished and
   * otherwise left untouched, so a task the run will not send, such as one whose thread
   * is missing, keeps its count of attempts. A reminder the plan named but the run did
   * not reach stays as it is for the next run.
   */
  async #closeUnplannedStaleClaims(plans: readonly GuildPlan[]): Promise<void> {
    const planned = new Set<string>();
    for (const { plan } of plans) {
      for (const event of plan.events) {
        for (const ref of event.reminders) {
          planned.add(keyOf(ref));
        }
      }
      for (const ref of plan.skips) {
        planned.add(keyOf(ref));
      }
    }
    const unplanned = [...this.#staleClaims.values()].filter(
      (claim) =>
        !planned.has(
          keyOf({
            taskId: claim.task_id,
            kind: claim.kind,
            dueDate: claim.due_date,
          }),
        ),
    );
    await forEachLimited(
      unplanned,
      () => this.#mayContinue(),
      async (claim) => {
        const closed = await closeStaleClaim(this.#db, {
          taskId: claim.task_id,
          kind: claim.kind,
          dueDate: claim.due_date,
          claimToken: claim.claim_token,
        });
        if (closed.ok) {
          this.counts.add(`stale_${closed.value.outcome}`);
        } else {
          this.#countIncomplete("claim_failed");
        }
      },
    );
  }
}

export async function runReminders(
  dependencies: RunDependencies,
): Promise<RunResult> {
  const db = withDeadline(dependencies.db, DATABASE_CALL_MS);
  const now = dependencies.now ?? (() => new Date());
  const lock = await beginJobRun(db, {
    jobName: "reminders",
    staleAfterSeconds: LOCK_STALE_SECONDS,
    slotStart: new Date(slotStart(now())),
  });
  if (!lock.ok) {
    return {
      status: "failed",
      id: null,
      results: {},
      error: errorSummary(lock.error),
    };
  }
  if (lock.value === null) {
    return { status: "duplicate" };
  }

  const run = new Run(dependencies, db);
  try {
    await run.work();
  } catch {
    run.error ??= { category: "unexpected", code: null };
  }

  const results = run.results();
  const finished = await finishJobRun(db, {
    id: lock.value,
    now: now(),
    results,
    error: run.error,
  });
  if (!finished.ok) {
    run.logLine(
      `Reminder run could not be recorded: ${errorSummary(finished.error)}`,
    );
  }
  return {
    status: run.error === null && finished.ok ? "succeeded" : "failed",
    id: lock.value,
    results,
    error: run.error === null ? null : errorSummary(run.error),
  };
}
