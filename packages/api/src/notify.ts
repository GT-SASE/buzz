import { eq } from "drizzle-orm";

import {
  sendCalendarInvite,
  type EventChange,
  type InviteEvent,
} from "./calendar-invite";
import { deliver, mailer, type Mailer } from "./mail";
import { isUndefinedTable } from "./pg-errors";
import { semesterLabel } from "./terms";
import {
  notificationPreferences,
  type db as Db,
  type ElectionPhase,
} from "@buzz/db";

/**
 * Every message the chapter sends on its own: committee decisions, event
 * changes and election announcements. One module so they share a transport,
 * the opt-out rules and the batching, and so a route handler's only job is to
 * say what happened once its transaction has committed.
 *
 * Rules every caller relies on:
 * - Nothing here throws. A failed send is logged and counted in the `Notice`
 *   the officer sees; it never undoes the change that triggered it.
 * - Nothing here runs inside a transaction. Call after the commit.
 * - Email goes through `mail.ts` (Gmail, unconfigured means not sent). The
 *   Discord post is a plain channel webhook, skipped silently when
 *   `NOTIFY_DISCORD_WEBHOOK_URL` is unset.
 */

type Database = typeof Db;

/** The deployment's public origin, for links in messages. */
const SITE_URL = "https://buzzsase.vercel.app";

/** Sends in small batches: Gmail throttles a burst of parallel connections. */
export const SEND_BATCH = 5;

/** What an officer is told after a change that notified people. */
export type Notice = {
  sent: number;
  failed: number;
  /** Members who switched this kind of email off. Not a failure. */
  skipped: number;
  /** The Discord channel post; "off" when no webhook is configured. */
  channel: "posted" | "failed" | "off";
};

export const noNotice: Notice = {
  sent: 0,
  failed: 0,
  skipped: 0,
  channel: "off",
};

/** Optional email kinds a member can switch off. Application decisions are not one. */
export type OptionalCategory = "event" | "election";

const preferenceColumn = {
  event: notificationPreferences.eventEmails,
  election: notificationPreferences.electionEmails,
} as const;

export type Recipient = { id: string; email: string };

/**
 * Ids of members who turned `category` off. The set is small (a row exists
 * only for a member who saved a choice), so it is read whole rather than
 * joined against a recipient list. A deployment whose migration has not run
 * yet has no opt-outs to honour.
 */
export async function optedOutOf(db: Database, category: OptionalCategory) {
  try {
    const rows = await db
      .select({ id: notificationPreferences.userId })
      .from(notificationPreferences)
      .where(eq(preferenceColumn[category], false));
    return new Set(rows.map((row) => row.id));
  } catch (error) {
    if (isUndefinedTable(error)) return new Set<string>();
    throw error;
  }
}

async function inBatches<T>(items: T[], send: (item: T) => Promise<boolean>) {
  let failed = 0;
  for (let i = 0; i < items.length; i += SEND_BATCH) {
    const results = await Promise.all(items.slice(i, i + SEND_BATCH).map(send));
    failed += results.filter((ok) => !ok).length;
  }
  return { sent: items.length - failed, failed };
}

const WEBHOOK_PATTERN =
  /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\//;

/**
 * Posts to the chapter's Discord channel through a webhook. The webhook URL is
 * a secret, so it is never logged. `allowed_mentions` is empty so an event
 * title that contains `@everyone` cannot ping anyone.
 */
export async function postToChannel(
  content: string,
): Promise<Notice["channel"]> {
  const url = process.env.NOTIFY_DISCORD_WEBHOOK_URL;
  if (!url) return "off";
  if (!WEBHOOK_PATTERN.test(url)) {
    console.error("NOTIFY_DISCORD_WEBHOOK_URL is not a Discord webhook URL.");
    return "failed";
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "GT SASE",
        content: content.slice(0, 2000),
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.error(`Discord post failed: HTTP ${response.status}`);
      return "failed";
    }
    return "posted";
  } catch (error) {
    console.error(
      "Discord post failed:",
      error instanceof Error ? error.name : "unknown error",
    );
    return "failed";
  }
}

/**
 * Sends one message to each member who has not opted out of `category`, in
 * batches, and tells the officer how it went. `send` gets the shared transport
 * so a fan-out opens one connection config, not one per member. A lookup that
 * fails counts as one failure so the officer is still told.
 */
async function toMembers(
  db: Database,
  category: OptionalCategory,
  loadRecipients: () => Promise<Recipient[]>,
  send: (mail: Mailer | null, to: string) => Promise<boolean>,
): Promise<Omit<Notice, "channel">> {
  try {
    const [recipients, optedOut] = await Promise.all([
      loadRecipients(),
      optedOutOf(db, category),
    ]);
    const wanted = recipients.filter((member) => !optedOut.has(member.id));
    const mail = mailer();
    const { sent, failed } = await inBatches(wanted, (member) =>
      send(mail, member.email),
    );
    return { sent, failed, skipped: recipients.length - wanted.length };
  } catch (error) {
    console.error(`Could not notify members (${category}):`, error);
    return { sent: 0, failed: 1, skipped: 0 };
  }
}

function firstName(name: string | null) {
  const first = name?.trim().split(/\s+/)[0];
  return first === undefined || first === "" ? "there" : first;
}

/**
 * A committee decision, to the applicant. Transactional: it answers something
 * the member did, so it ignores the opt-outs. Only an acceptance or a decline
 * is a decision; every other status change is internal.
 */
export async function notifyApplicationDecision(
  applicant: { email: string; name: string | null },
  decision: string,
  cycle: string,
): Promise<Notice> {
  if (decision !== "accepted" && decision !== "declined") return noNotice;

  const term = semesterLabel(cycle);
  const greeting = `Hi ${firstName(applicant.name)},`;
  const message =
    decision === "accepted"
      ? {
          subject: "Your GT SASE committee application: accepted",
          text: `${greeting}\n\nYou have been accepted to a GT SASE committee for ${term}. An officer will follow up with next steps. Questions? Reply to this email.\n\nYour application: ${SITE_URL}/portal/committees\n\nGT SASE`,
        }
      : {
          subject: "Your GT SASE committee application",
          text: `${greeting}\n\nThank you for applying to a GT SASE committee for ${term}. We are not able to offer you a place this cycle. You are always welcome at our events, and we hope you apply again next semester. Questions? Reply to this email.\n\nGT SASE`,
        };

  const mail = mailer();
  const ok = mail
    ? await deliver(
        mail,
        { to: applicant.email, ...message },
        "Application decision email",
      )
    : false;
  return { ...noNotice, sent: ok ? 1 : 0, failed: ok ? 0 : 1 };
}

const whenFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

function eventChannelPost(event: InviteEvent, change: EventChange) {
  const when = whenFormat.format(event.startsAt);
  const where = event.location ? ` at ${event.location}` : "";
  const link = `${SITE_URL}/events/${event.id}`;
  if (change === "cancelled") {
    return `Cancelled: ${event.title} (${when}).`;
  }
  return change === "restored"
    ? `Back on: ${event.title}, ${when}${where}.\n${link}`
    : `Changed: ${event.title} is now ${when}${where}.\n${link}`;
}

/**
 * A time or place change, a cancellation or a restore, to everyone who RSVPed.
 * The email is the calendar invite itself (same entry, later sequence), so the
 * calendar updates and nobody gets two messages. A member who switched event
 * emails off keeps the old entry. The channel post goes out whoever RSVPed.
 */
export async function notifyEventChange(
  db: Database,
  event: InviteEvent,
  change: EventChange,
  loadRecipients: () => Promise<Recipient[]>,
  { channel: post = true }: { channel?: boolean } = {},
): Promise<Notice> {
  const [members, channel] = await Promise.all([
    toMembers(db, "event", loadRecipients, (mail, to) =>
      sendCalendarInvite(
        change === "cancelled" ? "CANCEL" : "REQUEST",
        event,
        to,
        { change, mail },
      ),
    ),
    post
      ? postToChannel(eventChannelPost(event, change))
      : Promise.resolve("off" as const),
  ]);
  return { ...members, channel };
}

/**
 * Members who just moved off a waitlist onto a seat. Transactional like a
 * committee decision, so it ignores the event-email opt-out: it answers
 * something the member did (joining the waitlist), and they are holding a
 * seat that goes to the next person if they never learn they have it. The
 * email is the calendar invite, the same entry an RSVP creates. No channel
 * post: it concerns one member, not the chapter.
 */
export async function notifyWaitlistPromotion(
  event: InviteEvent,
  promoted: Recipient[],
): Promise<Notice> {
  if (promoted.length === 0) return noNotice;
  try {
    const mail = mailer();
    const { sent, failed } = await inBatches(promoted, (member) =>
      sendCalendarInvite("REQUEST", event, member.email, {
        change: "promoted",
        mail,
      }),
    );
    return { ...noNotice, sent, failed };
  } catch (error) {
    console.error("Could not notify promoted members:", error);
    return { ...noNotice, failed: promoted.length };
  }
}

/** Several notices as one, for an edit that touched a whole series. */
export function sumNotices(notices: Notice[]): Notice {
  const channel: Notice["channel"][] = notices.map((n) => n.channel);
  return {
    sent: notices.reduce((total, n) => total + n.sent, 0),
    failed: notices.reduce((total, n) => total + n.failed, 0),
    skipped: notices.reduce((total, n) => total + n.skipped, 0),
    channel: channel.includes("failed")
      ? "failed"
      : channel.includes("posted")
        ? "posted"
        : "off",
  };
}

const ELECTION_COPY: Partial<
  Record<ElectionPhase, (title: string) => { subject: string; text: string }>
> = {
  nominating: (title) => ({
    subject: `Nominations are open: ${title}`,
    text: `Nominations are open for ${title}. Put your name forward for a position in the portal.\n\n${SITE_URL}/portal/elections`,
  }),
  voting: (title) => ({
    subject: `Voting is open: ${title}`,
    text: `Voting is open for ${title}. Members who have checked in to an event this school year can vote in the portal.\n\n${SITE_URL}/portal/elections`,
  }),
  published: (title) => ({
    subject: `Results are in: ${title}`,
    text: `The results of ${title} are published.\n\n${SITE_URL}/portal/elections`,
  }),
};

/**
 * An election opening nominations, opening voting or publishing results, to
 * the members who can take part. `loadRecipients` is the router's own
 * eligibility rule, so who is told and who may vote cannot drift apart.
 */
export async function notifyElectionPhase(
  db: Database,
  election: { title: string },
  phase: ElectionPhase,
  loadRecipients: () => Promise<Recipient[]>,
): Promise<Notice> {
  const copy = ELECTION_COPY[phase]?.(election.title);
  if (!copy) return noNotice;

  const [members, channel] = await Promise.all([
    toMembers(db, "election", loadRecipients, async (mail, to) =>
      mail ? deliver(mail, { to, ...copy }, "Election email") : false,
    ),
    postToChannel(`${copy.subject}\n${SITE_URL}/portal/elections`),
  ]);
  return { ...members, channel };
}
