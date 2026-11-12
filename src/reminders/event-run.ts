/**
 * The event workflow reminders, as a step of the daily reminder run. It runs under that
 * run's lock, shares its message cap, deadlines, per-person ping limit and Discord client,
 * and records its counts in the same `job_runs` row, under names starting `event_`.
 *
 * Each reminder is one message: claim, send, mark sent. A failed send is dealt with by the
 * run, exactly as for a task reminder, so a thread that refuses the bot is counted and
 * held, and a forum that is gone is disabled, the same way for both.
 */

import type { DbClient } from "../db/client.ts";
import {
  claimEventReminder,
  closeStaleEventClaim,
  listEventReminderCandidates,
  listStaleEventReminderClaims,
  markEventReminderSent,
  markEventReminderSkipped,
  reclaimEventReminder,
} from "../db/event-steps.ts";
import type {
  EventReminderCandidate,
  EventReminderStaleClaim,
} from "../db/types.ts";
import { isUsableTimeZone, parseIsoDate, type DateOnly } from "../lib/dates.ts";
import {
  planEventReminders,
  type EventReminderPlan,
  type EventReminderRef,
  type PlannedEventReminder,
} from "./event-plan.ts";
import {
  renderEventReminder,
  type RenderedEventReminder,
} from "./event-render.ts";
import { slotToday, STALE_CLAIM_MS } from "./plan.ts";
import type { FailureOutcome, ThreadMessage, ThreadTarget } from "./run.ts";

const MS_PER_DAY = 86_400_000;

/** What the reminder run lends this step. Nothing here sends or decides on its own. */
export interface EventRunContext {
  readonly db: DbClient;
  readonly allowedGuildIds: ReadonlySet<string>;
  /** Stop claiming for a guild after this many failures in a row that might clear. */
  readonly maxRetryLaterInARow: number;
  /** Refusals in a row after which a thread's reminders are held. */
  readonly holdAfterRefusals: number;
  /** A reminder goes out without pings once this many sends of it may have landed. */
  readonly maxAttemptsWithPing: number;
  count(key: string, by?: number): void;
  /** Counts something that means the run did not do all it should have. */
  countIncomplete(key: string, by?: number): void;
  logLine(line: string): void;
  /** Why no send may start now, or null. Only `deferred_cap` is a decision. */
  sendBlock(): "deferred_halted" | "deferred_deadline" | "deferred_cap" | null;
  /** Whether to go on with work that only touches the database. */
  mayContinue(): boolean;
  pastHardStop(): boolean;
  /** The start of the current schedule slot, in milliseconds. */
  slotStart(now: Date): number;
  /** Counts pings already sent in this slot, so a retry does not notify afresh. */
  seedPings(
    guildId: string,
    userIds: readonly string[],
    roleIds: readonly string[],
  ): void;
  sendToThread(message: ThreadMessage): Promise<string>;
  /** Null if the error is not a Discord failure. */
  handleFailure(
    target: ThreadTarget,
    error: unknown,
    reminders: number,
  ): Promise<FailureOutcome | null>;
  clearRefusals(target: ThreadTarget): Promise<boolean>;
  /** The run already saw this event's thread or forum fail. */
  threadFailed(eventId: string): boolean;
  hold(eventId: string): void;
  isHeld(eventId: string): boolean;
  noteMissing(eventId: string): void;
}

function keyOf(ref: EventReminderRef): string {
  return `${ref.eventId}:${ref.kind}:${ref.reminderDate}`;
}

interface GuildEvents {
  readonly guildId: string;
  readonly today: DateOnly;
  readonly plan: EventReminderPlan;
  readonly events: ReadonlyMap<string, EventReminderCandidate>;
  readonly threadRefusals: Map<string, number>;
  readonly queue: PlannedEventReminder[];
  retryLaterInARow: number;
  blocked: "deferred_cap" | "deferred_retrying" | null;
}

interface Held {
  readonly claimToken: string;
  /** Sends that may reach someone, counting the one this claim is for. */
  readonly possibleDeliveries: number;
}

/** Yesterday in UTC: today everywhere is that date or later. */
function earliestToday(now: Date): DateOnly | null {
  return parseIsoDate(
    new Date(now.getTime() - MS_PER_DAY).toISOString().slice(0, 10),
  );
}

export class EventReminderStep {
  readonly #ctx: EventRunContext;
  readonly #stale = new Map<string, EventReminderStaleClaim>();

  constructor(context: EventRunContext) {
    this.#ctx = context;
  }

  async run(now: Date): Promise<void> {
    const ctx = this.#ctx;
    const fromDate = earliestToday(now);
    if (fromDate === null) {
      ctx.countIncomplete("event_bad_clock");
      return;
    }
    const candidates = await listEventReminderCandidates(ctx.db, { fromDate });
    if (!candidates.ok) {
      ctx.countIncomplete("event_read_failed");
      return;
    }
    const { rows, truncated } = candidates.value;
    ctx.count("event_candidates", rows.length);
    if (truncated) {
      ctx.count("event_truncated");
      ctx.logLine("Event reminder candidates truncated: events remain unread");
    }
    await this.#readStaleClaims(now);
    const guilds = this.#planGuilds(rows, now);
    await this.#sendInTurns(guilds);
    for (const guild of guilds) {
      await this.#recordSkips(guild.plan.skips);
    }
    await this.#closeDeadClaims(rows, fromDate, guilds);
  }

  async #readStaleClaims(now: Date): Promise<void> {
    const stale = await listStaleEventReminderClaims(this.#ctx.db, {
      claimedBefore: new Date(now.getTime() - STALE_CLAIM_MS),
    });
    if (!stale.ok) {
      // A stale claim waits for the next run, and claiming it here returns null.
      this.#ctx.countIncomplete("event_stale_read_failed");
      return;
    }
    this.#ctx.count("event_stale_found", stale.value.rows.length);
    if (stale.value.truncated) {
      // The oldest are read first, and closing them makes room for the rest, so the
      // recovery run is asked to go on with those beyond the cap.
      this.#ctx.countIncomplete("event_stale_truncated");
    }
    for (const claim of stale.value.rows) {
      this.#stale.set(
        keyOf({
          eventId: claim.event_id,
          kind: claim.kind,
          reminderDate: claim.reminder_date,
        }),
        claim,
      );
    }
  }

  #planGuilds(
    rows: readonly EventReminderCandidate[],
    now: Date,
  ): GuildEvents[] {
    const byGuild = new Map<string, EventReminderCandidate[]>();
    for (const row of rows) {
      byGuild.set(row.guild_id, [...(byGuild.get(row.guild_id) ?? []), row]);
    }
    const guilds: GuildEvents[] = [];
    for (const [guildId, events] of byGuild) {
      if (!this.#ctx.allowedGuildIds.has(guildId)) {
        this.#ctx.count("event_guilds_not_allowed");
        continue;
      }
      const guild = this.#planGuild(guildId, events, now);
      if (guild !== null) {
        guilds.push(guild);
      }
    }
    return guilds;
  }

  #planGuild(
    guildId: string,
    events: readonly EventReminderCandidate[],
    now: Date,
  ): GuildEvents | null {
    const ctx = this.#ctx;
    let today: DateOnly;
    let plan: EventReminderPlan;
    try {
      const timezone = events[0]?.timezone ?? "";
      if (!isUsableTimeZone(timezone)) {
        throw new RangeError("unusable time zone");
      }
      today = slotToday(now, timezone);
      plan = planEventReminders({ today, now, events });
    } catch {
      ctx.countIncomplete("event_guilds_invalid_zone");
      ctx.logLine(`Event reminder plan failed for guild ${guildId}`);
      return null;
    }
    const byId = new Map(events.map((event) => [event.id, event]));
    const threadRefusals = new Map(
      events.map((event) => [event.id, event.thread_refusals]),
    );
    this.#seedPings(guildId, events, today, now);
    ctx.count("event_planned", plan.sends.length);
    ctx.count("event_skips_planned", plan.skips.length);
    for (const ref of plan.freshClaims) {
      if ((threadRefusals.get(ref.eventId) ?? 0) >= ctx.holdAfterRefusals) {
        ctx.hold(ref.eventId);
        ctx.count("held_reminders");
      } else {
        // Without this a rerun soon after a failed run would close the slot unsent.
        ctx.countIncomplete("event_fresh_claims_waiting");
      }
    }
    for (const eventId of plan.missingThreadEventIds) {
      ctx.count("events_stopped");
      ctx.noteMissing(eventId);
    }
    // Events that failed before, by a stale claim or a refusal, wait behind fresh ones.
    const goesLast = (send: PlannedEventReminder) =>
      (threadRefusals.get(send.ref.eventId) ?? 0) > 0 ||
      this.#stale.has(keyOf(send.ref));
    return {
      guildId,
      today,
      plan,
      events: byId,
      threadRefusals,
      queue: [
        ...plan.sends.filter((send) => !goesLast(send)),
        ...plan.sends.filter(goesLast),
      ],
      retryLaterInARow: 0,
      blocked: null,
    };
  }

  /** Each reminder already sent in this slot counts as a ping to those it names now. */
  #seedPings(
    guildId: string,
    events: readonly EventReminderCandidate[],
    today: DateOnly,
    now: Date,
  ): void {
    const since = this.#ctx.slotStart(now);
    for (const event of events) {
      for (const entry of event.log) {
        if (
          entry.state !== "sent" ||
          entry.reminder_date !== today ||
          new Date(entry.claimed_at).getTime() < since
        ) {
          continue;
        }
        try {
          const rendered = renderEventReminder(entry.kind, event, today);
          this.#ctx.seedPings(
            guildId,
            rendered.mentionUserIds,
            rendered.mentionRoleIds,
          );
        } catch {
          // Nothing left to name, so nobody to count.
        }
      }
    }
  }

  /** Guilds take turns, one message each, so a busy guild shares the cap. */
  async #sendInTurns(guilds: readonly GuildEvents[]): Promise<void> {
    let active = [...guilds];
    while (active.length > 0) {
      const still: GuildEvents[] = [];
      for (const guild of active) {
        if (await this.#takeTurn(guild)) {
          still.push(guild);
        }
      }
      active = still;
    }
  }

  /** Sends one reminder. False once this guild has no more to do this run. */
  async #takeTurn(guild: GuildEvents): Promise<boolean> {
    const ctx = this.#ctx;
    if (guild.queue.length === 0) {
      return false;
    }
    const shared = ctx.sendBlock();
    if (shared === "deferred_cap") {
      guild.blocked ??= "deferred_cap";
    }
    const block =
      shared === "deferred_halted" || shared === "deferred_deadline"
        ? shared
        : guild.blocked;
    if (block !== null) {
      const left = guild.queue.length;
      if (block === "deferred_cap") {
        ctx.count("deferred_cap", left);
        ctx.logLine(
          `Event reminders left for later at the message cap: ${String(left)} in guild ${guild.guildId}`,
        );
      } else {
        ctx.countIncomplete(block, left);
      }
      guild.queue.length = 0;
      return false;
    }
    const send = guild.queue.shift();
    if (send === undefined) {
      return false;
    }
    try {
      await this.#sendOne(guild, send);
    } catch {
      ctx.countIncomplete("event_errors");
    }
    return true;
  }

  async #sendOne(
    guild: GuildEvents,
    send: PlannedEventReminder,
  ): Promise<void> {
    const ctx = this.#ctx;
    const { ref } = send;
    const event = guild.events.get(ref.eventId);
    if (event === undefined) {
      ctx.count("event_render_failed");
      return;
    }
    if (ctx.threadFailed(ref.eventId)) {
      // The task reminders found this thread failing. Trying again would count a second
      // refusal for one run, so it waits for the next run like they do.
      if (ctx.isHeld(ref.eventId)) {
        ctx.count("held_reminders");
      } else {
        ctx.countIncomplete("deferred_event");
      }
      return;
    }
    let rendered: RenderedEventReminder;
    try {
      rendered = renderEventReminder(ref.kind, event, guild.today);
    } catch {
      ctx.count("event_render_failed");
      ctx.logLine(
        `Event reminder could not be written for event ${ref.eventId}`,
      );
      return;
    }
    const held = await this.#claim(guild, ref);
    if (held === null) {
      return;
    }
    ctx.count("event_claimed");
    const message = this.#withoutRepeatPing(ref, rendered, held);
    const target: ThreadTarget = {
      guildId: guild.guildId,
      eventId: ref.eventId,
      threadRefusals: guild.threadRefusals,
    };
    let messageId: string;
    try {
      messageId = await ctx.sendToThread({
        guildId: guild.guildId,
        threadId: send.threadId,
        content: message.content,
        mentionUserIds: message.mentionUserIds,
        mentionRoleIds: message.mentionRoleIds,
      });
    } catch (error) {
      await this.#handleSendFailure(guild, target, ref, held, error);
      return;
    }
    guild.retryLaterInARow = 0;
    await this.#markSent(ref, held, messageId);
    if (await ctx.clearRefusals(target)) {
      ctx.logLine(`Reminders resumed for event ${ref.eventId}`);
    }
  }

  /** Sent this many times, it has probably pinged: keep it, without the noise. */
  #withoutRepeatPing(
    ref: EventReminderRef,
    rendered: RenderedEventReminder,
    held: Held,
  ): RenderedEventReminder {
    if (held.possibleDeliveries < this.#ctx.maxAttemptsWithPing) {
      return rendered;
    }
    this.#ctx.count("repeat_pings_withheld");
    this.#ctx.logLine(
      `Event reminder resent without a ping for event ${ref.eventId}`,
    );
    return { ...rendered, mentionUserIds: [], mentionRoleIds: [] };
  }

  #countRetryLater(guild: GuildEvents): void {
    guild.retryLaterInARow += 1;
    if (guild.retryLaterInARow >= this.#ctx.maxRetryLaterInARow) {
      guild.blocked ??= "deferred_retrying";
    }
  }

  /** A stale claim is taken over here, just before its send. Null if not held. */
  async #claim(
    guild: GuildEvents,
    ref: EventReminderRef,
  ): Promise<Held | null> {
    const ctx = this.#ctx;
    const key = keyOf(ref);
    const stale = this.#stale.get(key);
    this.#stale.delete(key);
    const claim =
      stale === undefined
        ? await claimEventReminder(ctx.db, ref)
        : await reclaimEventReminder(ctx.db, {
            ...ref,
            claimToken: stale.claim_token,
          });
    if (!claim.ok) {
      ctx.countIncomplete("event_claim_failed");
      this.#countRetryLater(guild);
      return null;
    }
    if (claim.value === null) {
      ctx.count("event_claim_lost");
      if (stale !== undefined) {
        // The plan meant to send it today, and it could not be taken over.
        ctx.countIncomplete("event_stale_claim_lost");
      }
      return null;
    }
    if (stale !== undefined) {
      ctx.count("event_stale_reclaimed");
    }
    return {
      claimToken: claim.value,
      possibleDeliveries: stale === undefined ? 1 : stale.attempts + 1,
    };
  }

  async #markSent(
    ref: EventReminderRef,
    held: Held,
    messageId: string,
  ): Promise<void> {
    const ctx = this.#ctx;
    if (ctx.pastHardStop()) {
      // Left claimed, so a later run sends it again: at most one repeat.
      ctx.countIncomplete("mark_failed");
      return;
    }
    const marked = await markEventReminderSent(ctx.db, {
      ...ref,
      claimToken: held.claimToken,
      messageId,
    });
    if (marked.ok && marked.value) {
      ctx.count("event_reminders_sent");
      ctx.count(`event_${ref.kind}_sent`);
    } else {
      ctx.countIncomplete("mark_failed");
    }
  }

  /** The claim stays unless the text itself was refused, so a later run tries again. */
  async #handleSendFailure(
    guild: GuildEvents,
    target: ThreadTarget,
    ref: EventReminderRef,
    held: Held,
    error: unknown,
  ): Promise<void> {
    const ctx = this.#ctx;
    const outcome = await ctx.handleFailure(target, error, 1);
    switch (outcome) {
      case null:
        ctx.countIncomplete("send_errors");
        return;
      case "handled":
        return;
      case "retry_later":
        ctx.countIncomplete("retry_later");
        this.#countRetryLater(guild);
        return;
      case "skip_item": {
        // Retrying text Discord refused would not help, and tomorrow brings a new one.
        ctx.count("event_items_refused");
        ctx.logLine(`Event reminder refused for event ${ref.eventId}`);
        const skipped = await markEventReminderSkipped(ctx.db, {
          ...ref,
          claimToken: held.claimToken,
        });
        if (!skipped.ok || !skipped.value) {
          ctx.countIncomplete("mark_failed");
        }
      }
    }
  }

  /** Closes stale claims on reminders that will not go out. Only records. */
  async #recordSkips(skips: readonly EventReminderRef[]): Promise<void> {
    const ctx = this.#ctx;
    for (const ref of skips) {
      if (!ctx.mayContinue()) {
        return;
      }
      const stale = this.#stale.get(keyOf(ref));
      if (stale === undefined) {
        ctx.count("event_skips_not_claimed");
        continue;
      }
      await this.#closeStale(stale);
    }
  }

  /**
   * Closes a stale claim as skipped with the token it was left with. A takeover would be
   * refused here, since the database no longer allows a reminder for a past day, a closed
   * or deleted event or an unmanaged forum, and the claim would stay open for good. The
   * token changes on any takeover, so a claim someone else took is left alone.
   */
  async #closeStale(stale: EventReminderStaleClaim): Promise<void> {
    const ctx = this.#ctx;
    const ref = {
      eventId: stale.event_id,
      kind: stale.kind,
      reminderDate: stale.reminder_date,
    };
    const key = keyOf(ref);
    this.#stale.delete(key);
    const marked = await markEventReminderSkipped(ctx.db, {
      ...ref,
      claimToken: stale.claim_token,
    });
    if (!marked.ok) {
      ctx.countIncomplete("mark_failed");
    } else if (marked.value) {
      ctx.count("event_skips_recorded");
    } else {
      ctx.count("event_skips_not_claimed");
    }
  }

  /**
   * Stale claims that no plan named. On an event the candidates hold, a claim for a day
   * before the guild's today can never go out and is closed. Any other is closed only once
   * its event, read again now, shows it never can: gone, deleted, closed, its post gone,
   * or dated before every guild's today. A claim on a guild with reminders off, in a forum
   * no longer managed or on a row the candidate read left out is left as it is, so it
   * goes out if a later run plans it, such as after reminders are turned back on.
   */
  async #closeDeadClaims(
    rows: readonly EventReminderCandidate[],
    fromDate: DateOnly,
    guilds: readonly GuildEvents[],
  ): Promise<void> {
    const candidateIds = new Set(rows.map((row) => row.id));
    const todayOf = new Map<string, DateOnly>();
    for (const guild of guilds) {
      for (const eventId of guild.events.keys()) {
        todayOf.set(eventId, guild.today);
      }
    }
    for (const stale of [...this.#stale.values()]) {
      if (!this.#ctx.mayContinue()) {
        return;
      }
      if (candidateIds.has(stale.event_id)) {
        const today = todayOf.get(stale.event_id);
        if (today !== undefined && stale.reminder_date < today) {
          this.#ctx.count("event_stale_unplanned");
          await this.#closeStale(stale);
        }
        continue;
      }
      await this.#closeIfDead(stale, fromDate);
    }
  }

  /** Reads an unplanned claim's event again, and closes the claim only if it is dead. */
  async #closeIfDead(
    stale: EventReminderStaleClaim,
    fromDate: DateOnly,
  ): Promise<void> {
    const ctx = this.#ctx;
    const ref = {
      eventId: stale.event_id,
      kind: stale.kind,
      reminderDate: stale.reminder_date,
    };
    const key = keyOf(ref);
    this.#stale.delete(key);
    const closed = await closeStaleEventClaim(ctx.db, {
      ...ref,
      claimToken: stale.claim_token,
      beforeDate: fromDate,
    });
    if (!closed.ok) {
      ctx.countIncomplete("mark_failed");
    } else if (closed.value === "closed") {
      ctx.count("event_stale_unplanned");
      ctx.count("event_skips_recorded");
    } else {
      ctx.count("event_stale_left");
    }
  }
}
