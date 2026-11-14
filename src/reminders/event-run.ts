/**
 * The event workflow reminders, as a step of the daily reminder run. It runs under that
 * run's lock, shares its message cap, deadlines and Discord client, and records its counts
 * in the same `job_runs` row, under names starting `event_`.
 *
 * Each reminder is one message: claim, send, mark sent. A failed send is dealt with by the
 * run, exactly as for a task reminder, so a forum that is gone is disabled the same way
 * for both.
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
import { MAX_ATTEMPTS_WITH_PING, slotToday, STALE_CLAIM_MS } from "./plan.ts";
import type { FailureOutcome, ThreadMessage, ThreadTarget } from "./run.ts";

const MS_PER_DAY = 86_400_000;

/**
 * How much of the run is left. Sends need "open". Work that only touches the database
 * goes on through "cap" and stops at the rest, and a mark after a send goes on until
 * "hard_stop".
 */
export type RunBudget = "open" | "cap" | "deadline" | "halted" | "hard_stop";

/** What the reminder run does for this step. Nothing here sends or decides on its own. */
export interface EventRunHost {
  send(message: ThreadMessage): Promise<string>;
  /** Null if the error is not a Discord failure. */
  handleFailure(
    target: ThreadTarget,
    error: unknown,
  ): Promise<FailureOutcome | null>;
  /** `incomplete` means the run did not do all it should have. */
  count(key: string, by?: number, incomplete?: boolean): void;
  log(line: string): void;
  budget(): RunBudget;
}

/** Why no send may start: the count that what is left is added to. */
function blockOf(
  budget: RunBudget,
): "deferred_halted" | "deferred_deadline" | "deferred_cap" | null {
  switch (budget) {
    case "open":
      return null;
    case "cap":
      return "deferred_cap";
    case "halted":
      return "deferred_halted";
    case "deadline":
    case "hard_stop":
      return "deferred_deadline";
  }
}

/** Whether to go on with work that only touches the database. */
function mayContinue(budget: RunBudget): boolean {
  return budget === "open" || budget === "cap";
}

function keyOf(ref: EventReminderRef): string {
  return `${ref.eventId}:${ref.kind}:${ref.reminderDate}`;
}

interface GuildEvents {
  readonly guildId: string;
  readonly today: DateOnly;
  readonly plan: EventReminderPlan;
  readonly events: ReadonlyMap<string, EventReminderCandidate>;
  readonly queue: PlannedEventReminder[];
  blocked: "deferred_cap" | null;
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

export interface EventStepResult {
  /** Events whose post is gone, so their reminders stopped. */
  readonly missingEventIds: readonly string[];
}

export class EventReminderStep {
  readonly #db: DbClient;
  readonly #allowedGuildIds: ReadonlySet<string>;
  readonly #host: EventRunHost;
  readonly #stale = new Map<string, EventReminderStaleClaim>();
  readonly #missingEventIds: string[] = [];

  constructor(
    db: DbClient,
    allowedGuildIds: ReadonlySet<string>,
    host: EventRunHost,
  ) {
    this.#db = db;
    this.#allowedGuildIds = allowedGuildIds;
    this.#host = host;
  }

  async run(now: Date): Promise<EventStepResult> {
    const host = this.#host;
    const result = { missingEventIds: this.#missingEventIds };
    const fromDate = earliestToday(now);
    if (fromDate === null) {
      host.count("event_bad_clock", 1, true);
      return result;
    }
    const candidates = await listEventReminderCandidates(this.#db, {
      fromDate,
    });
    if (!candidates.ok) {
      host.count("event_read_failed", 1, true);
      return result;
    }
    const { rows, truncated } = candidates.value;
    host.count("event_candidates", rows.length);
    if (truncated) {
      host.count("event_truncated");
      host.log("Event reminder candidates truncated: events remain unread");
    }
    await this.#readStaleClaims(now);
    const guilds = this.#planGuilds(rows, now);
    await this.#sendInTurns(guilds);
    for (const guild of guilds) {
      await this.#recordSkips(guild.plan.skips);
    }
    await this.#closeDeadClaims(rows, fromDate, guilds);
    return result;
  }

  async #readStaleClaims(now: Date): Promise<void> {
    const stale = await listStaleEventReminderClaims(this.#db, {
      claimedBefore: new Date(now.getTime() - STALE_CLAIM_MS),
    });
    if (!stale.ok) {
      // A stale claim waits for the next run, and claiming it here returns null.
      this.#host.count("event_stale_read_failed", 1, true);
      return;
    }
    this.#host.count("event_stale_found", stale.value.rows.length);
    if (stale.value.truncated) {
      // The oldest are read first, and closing them makes room for the rest, so the
      // recovery run is asked to go on with those beyond the cap.
      this.#host.count("event_stale_truncated", 1, true);
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
      if (!this.#allowedGuildIds.has(guildId)) {
        this.#host.count("event_guilds_not_allowed");
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
    const host = this.#host;
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
      host.count("event_guilds_invalid_zone", 1, true);
      host.log(`Event reminder plan failed for guild ${guildId}`);
      return null;
    }
    const byId = new Map(events.map((event) => [event.id, event]));
    host.count("event_planned", plan.sends.length);
    host.count("event_skips_planned", plan.skips.length);
    // Without this a rerun soon after a failed run would close the slot unsent.
    host.count("event_fresh_claims_waiting", plan.freshClaims.length, true);
    for (const eventId of plan.missingThreadEventIds) {
      host.count("events_stopped");
      this.#missingEventIds.push(eventId);
    }
    // Events with a stale claim failed before, so they wait behind fresh ones.
    const goesLast = (send: PlannedEventReminder) =>
      this.#stale.has(keyOf(send.ref));
    return {
      guildId,
      today,
      plan,
      events: byId,
      queue: [
        ...plan.sends.filter((send) => !goesLast(send)),
        ...plan.sends.filter(goesLast),
      ],
      blocked: null,
    };
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
    const host = this.#host;
    if (guild.queue.length === 0) {
      return false;
    }
    const shared = blockOf(host.budget());
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
        host.count("deferred_cap", left);
        host.log(
          `Event reminders left for later at the message cap: ${String(left)} in guild ${guild.guildId}`,
        );
      } else {
        host.count(block, left, true);
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
      host.count("event_errors", 1, true);
    }
    return true;
  }

  async #sendOne(
    guild: GuildEvents,
    send: PlannedEventReminder,
  ): Promise<void> {
    const host = this.#host;
    const { ref } = send;
    const event = guild.events.get(ref.eventId);
    if (event === undefined) {
      host.count("event_render_failed");
      return;
    }
    let rendered: RenderedEventReminder;
    try {
      rendered = renderEventReminder(ref.kind, event, guild.today);
    } catch {
      host.count("event_render_failed");
      host.log(`Event reminder could not be written for event ${ref.eventId}`);
      return;
    }
    const held = await this.#claim(ref);
    if (held === null) {
      return;
    }
    host.count("event_claimed");
    const message = this.#withoutRepeatPing(ref, rendered, held);
    const target: ThreadTarget = {
      guildId: guild.guildId,
      eventId: ref.eventId,
    };
    let messageId: string;
    try {
      messageId = await host.send({
        guildId: guild.guildId,
        threadId: send.threadId,
        content: message.content,
        mentionUserIds: message.mentionUserIds,
        mentionRoleIds: message.mentionRoleIds,
      });
    } catch (error) {
      await this.#handleSendFailure(target, ref, held, error);
      return;
    }
    await this.#markSent(ref, held, messageId);
  }

  /** Sent this many times, it has probably pinged: keep it, without the noise. */
  #withoutRepeatPing(
    ref: EventReminderRef,
    rendered: RenderedEventReminder,
    held: Held,
  ): RenderedEventReminder {
    if (held.possibleDeliveries < MAX_ATTEMPTS_WITH_PING) {
      return rendered;
    }
    this.#host.count("repeat_pings_withheld");
    this.#host.log(
      `Event reminder resent without a ping for event ${ref.eventId}`,
    );
    return { ...rendered, mentionUserIds: [], mentionRoleIds: [] };
  }

  /** A stale claim is taken over here, just before its send. Null if not held. */
  async #claim(ref: EventReminderRef): Promise<Held | null> {
    const host = this.#host;
    const key = keyOf(ref);
    const stale = this.#stale.get(key);
    this.#stale.delete(key);
    const claim =
      stale === undefined
        ? await claimEventReminder(this.#db, ref)
        : await reclaimEventReminder(this.#db, {
            ...ref,
            claimToken: stale.claim_token,
          });
    if (!claim.ok) {
      host.count("event_claim_failed", 1, true);
      return null;
    }
    if (claim.value === null) {
      host.count("event_claim_lost");
      if (stale !== undefined) {
        // The plan meant to send it today, and it could not be taken over.
        host.count("event_stale_claim_lost", 1, true);
      }
      return null;
    }
    if (stale !== undefined) {
      host.count("event_stale_reclaimed");
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
    const host = this.#host;
    if (host.budget() === "hard_stop") {
      // Left claimed, so a later run sends it again: at most one repeat.
      host.count("mark_failed", 1, true);
      return;
    }
    const marked = await markEventReminderSent(this.#db, {
      ...ref,
      claimToken: held.claimToken,
      messageId,
    });
    if (marked.ok && marked.value) {
      host.count("event_reminders_sent");
      host.count(`event_${ref.kind}_sent`);
    } else {
      host.count("mark_failed", 1, true);
    }
  }

  /** The claim stays unless the text itself was refused, so a later run tries again. */
  async #handleSendFailure(
    target: ThreadTarget,
    ref: EventReminderRef,
    held: Held,
    error: unknown,
  ): Promise<void> {
    const host = this.#host;
    const outcome = await host.handleFailure(target, error);
    switch (outcome) {
      case null:
        host.count("send_errors", 1, true);
        return;
      case "handled":
        return;
      case "retry_later":
        host.count("retry_later", 1, true);
        return;
      case "skip_item": {
        // Retrying text Discord refused would not help, and tomorrow brings a new one.
        host.count("event_items_refused");
        host.log(`Event reminder refused for event ${ref.eventId}`);
        const skipped = await markEventReminderSkipped(this.#db, {
          ...ref,
          claimToken: held.claimToken,
        });
        if (!skipped.ok || !skipped.value) {
          host.count("mark_failed", 1, true);
        }
      }
    }
  }

  /** Closes stale claims on reminders that will not go out. Only records. */
  async #recordSkips(skips: readonly EventReminderRef[]): Promise<void> {
    const host = this.#host;
    for (const ref of skips) {
      if (!mayContinue(host.budget())) {
        return;
      }
      const stale = this.#stale.get(keyOf(ref));
      if (stale === undefined) {
        host.count("event_skips_not_claimed");
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
    const host = this.#host;
    const ref = {
      eventId: stale.event_id,
      kind: stale.kind,
      reminderDate: stale.reminder_date,
    };
    const key = keyOf(ref);
    this.#stale.delete(key);
    const marked = await markEventReminderSkipped(this.#db, {
      ...ref,
      claimToken: stale.claim_token,
    });
    if (!marked.ok) {
      host.count("mark_failed", 1, true);
    } else if (marked.value) {
      host.count("event_skips_recorded");
    } else {
      host.count("event_skips_not_claimed");
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
      if (!mayContinue(this.#host.budget())) {
        return;
      }
      if (candidateIds.has(stale.event_id)) {
        const today = todayOf.get(stale.event_id);
        if (today !== undefined && stale.reminder_date < today) {
          this.#host.count("event_stale_unplanned");
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
    const host = this.#host;
    const ref = {
      eventId: stale.event_id,
      kind: stale.kind,
      reminderDate: stale.reminder_date,
    };
    const key = keyOf(ref);
    this.#stale.delete(key);
    const closed = await closeStaleEventClaim(this.#db, {
      ...ref,
      claimToken: stale.claim_token,
      beforeDate: fromDate,
    });
    if (!closed.ok) {
      host.count("mark_failed", 1, true);
    } else if (closed.value === "closed") {
      host.count("event_stale_unplanned");
      host.count("event_skips_recorded");
    } else {
      host.count("event_stale_left");
    }
  }
}
