/**
 * One reminder run: take the job's lock, read what is due, plan it per guild, then for
 * each reminder claim, send and mark sent.
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
import {
  getManagedChannel,
  markChannelUnavailable,
} from "../db/managed-channels.ts";
import {
  claimReminder,
  clearThreadRefusals,
  closeStaleClaim,
  listReminderCandidates,
  listStaleClaims,
  markReminderSent,
  markReminderSkipped,
  recordReminderRefused,
  recordThreadRefusal,
  resolveStaleClaim,
  type ReminderKey,
  type TaskAsRead,
} from "../db/reminders.ts";
import type { ReminderCandidate, StaleClaim } from "../db/types.ts";
import {
  DiscordClientError,
  DiscordErrorCode,
  actionForFailure,
  type DiscordClient,
  type DiscordFailure,
  type ManagedChannelCheck,
} from "../discord/client.ts";
import { channelMessage, type Part } from "../discord/outbound.ts";
import type { Chunk, ChunkLine } from "../discord/safe-text.ts";
import {
  isUsableTimeZone,
  parseIsoDate,
  todayInZone,
  type DateOnly,
} from "../lib/dates.ts";
import {
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

/**
 * vercel.json gives this function 60 seconds. No new claim or send starts after
 * `RUN_WORK_MS`. What is under way can still take a claim and one Discord operation, and
 * no mark starts after `RUN_HARD_STOP_MS`, which leaves time for the last marks to end
 * and the run to record itself inside that limit.
 */
export const RUN_WORK_MS = 40_000;
export const RUN_HARD_STOP_MS = 52_000;
export const DISCORD_OPERATION_MS = 6_000;
export const DATABASE_CALL_MS = 4_000;
/** Longer than the function can live, so a 'running' row this old is a killed run. */
export const LOCK_STALE_SECONDS = 120;
/** When a schedule slot starts. Must match `begin_job_run`. */
const SLOT_START_HOUR_UTC = 14;
/**
 * A reminder goes out without notifying anyone once this many sends, counting the one about
 * to start, may have reached Discord. A send known to have been refused does not count.
 */
const MAX_ATTEMPTS_WITH_PING = 3;
/**
 * After this many runs in a row of a thread refusing the bot, its reminders are held. They
 * keep their claims and each run tries them again, but the run no longer fails for them, so
 * one post cannot keep the job's alarm firing and hide a real outage. With two crons a day
 * that leaves one day of failed runs for a person to see. Only a refusal specific to the
 * thread counts: if the event's forum refuses too, the job goes on failing.
 */
export const THREAD_REFUSALS_BEFORE_HOLD = 3;
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
  /** Messages per run that may notify one person. Later ones still show the mention. */
  readonly maxPingsPerPerson: number;
  readonly workMs: number;
  readonly hardStopMs: number;
  /** Stop claiming for a guild after this many failures in a row that might clear. */
  readonly maxRetryLaterInARow: number;
}

export const DEFAULT_LIMITS: RunLimits = {
  maxMessages: 100,
  maxPingsPerPerson: 20,
  workMs: RUN_WORK_MS,
  hardStopMs: RUN_HARD_STOP_MS,
  maxRetryLaterInARow: 3,
};

const DB_CONCURRENCY = 8;
const MAX_LOG_LINES = 50;
const MS_PER_DAY = 86_400_000;
// Today somewhere is at most one date ahead of UTC, and the first reminder opens
// three days before the due date.
const CANDIDATE_DAYS_AHEAD = 4;

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

/** The check the client runs before each send, from the live row. */
export function managedChannelCheck(db: DbClient): ManagedChannelCheck {
  return {
    async isManaged(guildId, channelId) {
      const row = await getManagedChannel(db, { guildId, channelId });
      if (!row.ok) {
        // The client turns this into a refused send. The error is not looked at.
        throw new Error("managed channel check failed");
      }
      return row.value?.status === "active";
    },
  };
}

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

function personKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

interface GuildPlan {
  readonly guildId: string;
  readonly today: DateOnly;
  readonly plan: ReminderPlan;
  readonly rows: ReadonlyMap<string, ReminderCandidate>;
  /** As read, and set to 0 here once a send to the thread lands. */
  readonly threadRefusals: Map<string, number>;
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
 * False for a failure after which the message may exist: no response, a response that could
 * not be read, a server error, or an error that is not the client's.
 */
function knownNotSent(failure: DiscordFailure): boolean {
  if (failure.kind === "network" || failure.kind === "invalid_response") {
    return false;
  }
  return failure.kind !== "api" || failure.status < 500;
}

/** The start of the current schedule slot, as in the `begin_job_run` function. */
function slotStart(now: Date): number {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    SLOT_START_HOUR_UTC,
  );
  return today <= now.getTime() ? today : today - MS_PER_DAY;
}

/** One event's messages, and how far through them a run has got. */
interface EventCursor {
  readonly event: EventReminders;
  readonly header: ChunkLine;
  readonly batches: readonly Batch<Item>[];
  index: number;
}

type GuildBlock = "deferred_cap" | "deferred_retrying";

/** What one guild has left to send. A failure here says nothing about other guilds. */
interface GuildTurns {
  readonly guild: GuildPlan;
  readonly events: readonly EventReminders[];
  nextEvent: number;
  current: EventCursor | null;
  retryLaterInARow: number;
  blocked: GuildBlock | null;
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
  readonly #pings = new Map<string, number>();
  readonly #forums = new Map<string, ForumState>();
  readonly #heldEventIds = new Set<string>();
  readonly #missingEventIds = new Set<string>();
  #sendAttempts = 0;
  #logLines = 0;
  #claimFailures = 0;
  /** Discord refused the bot or limited it globally: nothing further this run. */
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
      ...(this.#heldEventIds.size > 0
        ? { held_event_ids: named(this.#heldEventIds) }
        : {}),
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

  #countRetryLater(turns: GuildTurns): void {
    turns.retryLaterInARow += 1;
    if (turns.retryLaterInARow >= this.#limits.maxRetryLaterInARow) {
      turns.blocked ??= "deferred_retrying";
    }
  }

  async work(): Promise<void> {
    const now = this.#now();
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
    const { rows, excluded, truncated } = candidates.value;
    this.counts.add("candidates", rows.length);
    this.counts.add("excluded_rows", excluded.length);
    if (truncated) {
      this.counts.add("truncated");
      this.logLine("Reminder candidates truncated: rows remain unread");
    }
    for (const row of excluded) {
      this.logLine(
        `Reminder candidate left out: ${row.table}.${row.field} ${row.id ?? "unknown"}`,
      );
    }

    await this.#readStaleClaims(now);
    const plans = this.#planGuilds(rows, now);

    await this.#sendInTurns(plans);
    for (const guild of plans) {
      await this.#recordSkips(guild.plan.skips);
    }
    await this.#closeUnplannedStaleClaims(plans);

    if (this.#incomplete) {
      // A failed run leaves the slot open, so the recovery cron tries again today, and
      // a monitor reading the last success sees the gap.
      this.error ??= { category: "reminders_incomplete", code: null };
    }
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
    this.counts.add("excluded_rows", stale.value.excluded.length);
    if (stale.value.truncated) {
      this.counts.add("stale_truncated");
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
        this.#seedPings(guildId, guildRows, now);
        plans.push(plan);
      }
    }
    return plans;
  }

  /**
   * A retry after a failed run must not notify people afresh. Each event with a reminder
   * already sent to someone in this slot counts as one message to them.
   */
  #seedPings(
    guildId: string,
    rows: readonly ReminderCandidate[],
    now: Date,
  ): void {
    const since = slotStart(now);
    const seen = new Set<string>();
    for (const row of rows) {
      const sentInSlot = row.log.some(
        (entry) =>
          entry.state === "sent" &&
          new Date(entry.claimedAt).getTime() >= since,
      );
      const key = `${row.assignee_id}:${row.event.id}`;
      if (sentInSlot && !seen.has(key)) {
        seen.add(key);
        const person = personKey(guildId, row.assignee_id);
        this.#pings.set(person, (this.#pings.get(person) ?? 0) + 1);
      }
    }
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
      today = todayInZone(now, timezone);
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
    const threadRefusals = new Map(
      rows.map((row) => [row.event.id, row.thread_refusals]),
    );
    for (const { eventId } of plan.freshClaims) {
      if ((threadRefusals.get(eventId) ?? 0) >= THREAD_REFUSALS_BEFORE_HOLD) {
        this.#hold(eventId);
        this.counts.add("held_reminders");
      } else {
        // Without this, a rerun soon after a failed run would find nothing to do, record
        // a success and close the slot, and the recovery cron would not send them.
        this.#countIncomplete("fresh_claims_waiting");
      }
    }
    for (const eventId of plan.missingThreadEventIds) {
      this.counts.add("events_stopped");
      this.#noteMissing(eventId);
    }
    return {
      guildId,
      today,
      plan,
      rows: new Map(rows.map((row) => [row.task.id, row])),
      threadRefusals,
    };
  }

  /** A reminder held here is not lost: it stays claimed and each run tries it again. */
  #hold(eventId: string): void {
    if (!this.#heldEventIds.has(eventId)) {
      this.#heldEventIds.add(eventId);
      this.counts.add("threads_held");
      this.logLine(
        `Reminders held for event ${eventId}: its thread refuses the bot`,
      );
    }
  }

  #noteMissing(eventId: string): void {
    if (!this.#missingEventIds.has(eventId)) {
      this.#missingEventIds.add(eventId);
      this.logLine(
        `Reminders stopped for event ${eventId}: its post is gone, until /event link gives it a new one`,
      );
    }
  }

  /** Events that failed before, by a stale claim or a refusal, wait behind fresh ones. */
  #eventsInOrder(guild: GuildPlan): EventReminders[] {
    const goesLast = (event: EventReminders) =>
      (guild.threadRefusals.get(event.eventId) ?? 0) > 0 ||
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
      retryLaterInARow: 0,
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
  ): GuildBlock | "deferred_halted" | "deferred_deadline" | null {
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
      if (this.#heldEventIds.has(cursor.event.eventId)) {
        this.counts.add("held_reminders", left);
      } else {
        this.#countIncomplete("deferred_event", left);
      }
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
      this.#claimFailures += 1;
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
    this.#claimFailures = 0;
    const claimed = await this.#claimAll(items);
    this.counts.add("claimed", claimed.length);
    if (this.#claimFailures === items.length) {
      this.#countRetryLater(turns);
    }
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
    turns.retryLaterInARow = 0;
    await this.#markSent(items, messageId);
    if (await this.#clearRefusals(turns.guild, cursor.event)) {
      this.logLine(`Reminders resumed for event ${cursor.event.eventId}`);
    }
    return true;
  }

  /** Starts the thread's count again from nothing. True if there was a count to clear. */
  async #clearRefusals(
    guild: GuildPlan,
    event: EventReminders,
  ): Promise<boolean> {
    if ((guild.threadRefusals.get(event.eventId) ?? 0) === 0) {
      return false;
    }
    guild.threadRefusals.set(event.eventId, 0);
    const cleared = await clearThreadRefusals(this.#db, {
      guildId: guild.guildId,
      eventId: event.eventId,
    });
    if (!cleared.ok) {
      // Only makes the event's next refusal count from where this one left off.
      this.counts.add("refusals_not_cleared");
    }
    return cleared.ok;
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
    const { guildId } = turns.guild;
    const pinged = message.mentionUserIds.filter(
      (userId) =>
        (this.#pings.get(personKey(guildId, userId)) ?? 0) <
        this.#limits.maxPingsPerPerson,
    );
    this.counts.add(
      "pings_withheld",
      message.mentionUserIds.length - pinged.length,
    );
    // Counted before the request: a refused send still costs a request, and a cap on
    // successes would let refused text use as many as it liked.
    this.#sendAttempts += 1;
    const resource = await this.#client.sendMessage(
      { kind: "thread", guildId, threadId: event.threadId },
      channelMessage({
        content: message.content,
        mentionUserIds: pinged,
        components,
      }),
    );
    for (const userId of pinged) {
      const person = personKey(guildId, userId);
      this.#pings.set(person, (this.#pings.get(person) ?? 0) + 1);
    }
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
    if (isThreadRefusal(failure)) {
      await this.#handleThreadRefusal(
        turns.guild,
        cursor.event,
        failure,
        items.length,
      );
      return false;
    }
    switch (action) {
      case "stop_run":
        this.#halt(failure);
        return false;
      case "mark_channel_unavailable":
        await this.#handleChannelUnavailable(
          turns.guild,
          cursor.event,
          failure,
        );
        return false;
      case "retry_later":
        this.#countIncomplete("retry_later", items.length);
        this.#countRetryLater(turns);
        return false;
      case "skip_item":
        return this.#retryOneByOne(turns, cursor, items, failure, partlySent);
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

  /**
   * Whether a refusal is the thread's own depends on the forum. A bot removed from the
   * server, or a role that lost access everywhere, gets the same answer from both, and
   * holding that would turn an outage into a green job with nothing sent.
   */
  async #handleThreadRefusal(
    guild: GuildPlan,
    event: EventReminders,
    failure: DiscordFailure,
    reminders: number,
  ): Promise<void> {
    const row = await getEvent(this.#db, {
      guildId: guild.guildId,
      eventId: event.eventId,
    });
    const forum =
      row.ok && row.value !== null
        ? await this.#forumState(guild.guildId, row.value.channel_id)
        : "unknown";
    switch (forum) {
      case "present":
        await this.#countThreadRefusal(guild, event, failure, reminders);
        return;
      case "unknown":
        this.#countIncomplete("thread_check_failed");
        return;
      case "gone":
      case "refused":
        await this.#countForumRefusal(guild, event, failure);
    }
  }

  /**
   * The forum refuses the bot too, so this is not about the thread, and the run stays failed.
   * The thread's count goes as well: a rerun finding a claim on an event still counted as
   * held would otherwise record a success with nothing sent.
   */
  async #countForumRefusal(
    guild: GuildPlan,
    event: EventReminders,
    failure: DiscordFailure,
  ): Promise<void> {
    this.#countIncomplete("channels_inaccessible");
    await this.#clearRefusals(guild, event);
    this.logLine(
      `Forum refused the bot for event ${event.eventId}: ${errorSummary(discordError(failure))}`,
    );
  }

  /**
   * A thread that refuses the bot, which a person can undo at any time, so nothing is
   * disabled. The run fails for it only until the event is held, which bounds how long one
   * thread can keep the job failing. It says nothing about other events, so it does not
   * count towards stopping this guild's sends.
   */
  async #countThreadRefusal(
    guild: GuildPlan,
    event: EventReminders,
    failure: DiscordFailure,
    reminders: number,
  ): Promise<void> {
    const refusals = await recordThreadRefusal(this.#db, {
      guildId: guild.guildId,
      eventId: event.eventId,
    });
    if (!refusals.ok) {
      this.#countIncomplete("thread_check_failed");
      return;
    }
    if (refusals.value >= THREAD_REFUSALS_BEFORE_HOLD) {
      this.counts.add("channels_inaccessible");
      this.counts.add("held_reminders", reminders);
      this.#hold(event.eventId);
      return;
    }
    this.#countIncomplete("channels_inaccessible");
    this.logLine(
      `Thread refused the bot for event ${event.eventId}: ${errorSummary(discordError(failure))}, refusal ${String(refusals.value)} of ${String(THREAD_REFUSALS_BEFORE_HOLD)} before its reminders are held`,
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
    guild: GuildPlan,
    event: EventReminders,
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
      guildId: guild.guildId,
      eventId: event.eventId,
    });
    if (!row.ok || row.value === null) {
      this.#countIncomplete("thread_check_failed");
      return;
    }
    const channelId = row.value.channel_id;
    const forum = await this.#forumState(guild.guildId, channelId);
    if (forum === "gone") {
      const marked = await markChannelUnavailable(this.#db, {
        guildId: guild.guildId,
        channelId,
      });
      if (marked.ok) {
        this.counts.add("channels_gone", marked.value ? 1 : 0);
      } else {
        this.#countIncomplete("thread_check_failed");
      }
    } else if (forum === "present") {
      const marked = await markEventThreadMissing(this.#db, {
        guildId: guild.guildId,
        eventId: event.eventId,
      });
      if (marked.ok) {
        this.counts.add("threads_missing");
        this.#noteMissing(event.eventId);
      } else {
        this.#countIncomplete("thread_check_failed");
      }
    } else if (forum === "refused") {
      await this.#countForumRefusal(guild, event, failure);
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
  const lock = await beginJobRun(db, {
    jobName: "reminders",
    staleAfterSeconds: LOCK_STALE_SECONDS,
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
    now: (dependencies.now ?? (() => new Date()))(),
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
