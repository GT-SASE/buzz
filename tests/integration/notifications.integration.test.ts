import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  vi,
} from "bun:test";
import { stubEnv, unstubAllEnvs } from "../helpers/env";
import { FAKE_WEBHOOK } from "../helpers/webhook";

/**
 * Notifications on a real Postgres with a fake mail transport and a fake
 * `fetch`: who is told, who is skipped, and that nothing goes out before the
 * change it announces has committed. Each fake send reads the database from a
 * second connection (`probe`), so a send that left while the transaction was
 * still open would see the old row.
 */
mock.module("../../packages/auth/src/index.ts", () => ({
  auth: () => Promise.resolve(null),
  handlers: {},
  signIn: () => Promise.resolve(undefined),
  signOut: () => Promise.resolve(undefined),
}));

type Sent = {
  to: string;
  subject: string;
  method?: string;
  /** What `probe` read from the database at the moment of the send. */
  seen: unknown;
};
const sent: Sent[] = [];
const rejected = new Set<string>();
let probe: (() => Promise<unknown>) | null = null;

mock.module("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: async (message: {
        to: string;
        subject: string;
        icalEvent?: { method: string };
      }) => {
        if (rejected.has(message.to))
          throw new Error("550 mailbox unavailable");
        sent.push({
          to: message.to,
          subject: message.subject,
          method: message.icalEvent?.method,
          seen: probe ? await probe() : undefined,
        });
      },
    }),
  },
}));

const {
  auditLog,
  committeeApplications,
  db,
  electionCandidates,
  elections,
  eventCheckIns,
  eventRsvps,
  events,
  notificationPreferences,
  users,
} = await import("../../packages/db/src/index");
const { createCaller } = await import("../../packages/api/src/root");
const { noNotice, optedOutOf } = await import("../../packages/api/src/notify");
const { eq, inArray } = await import("drizzle-orm");

const SLOW = 60_000;
const HOUR_MS = 60 * 60 * 1000;
const WEBHOOK = FAKE_WEBHOOK;

type Role = "MEMBER" | "ADMIN";
type TestUser = { id: string; email: string; role: Role };

function callerFor(user: TestUser, database: typeof db = db) {
  return createCaller({
    db: database,
    session: {
      user: { id: user.id, role: user.role, email: user.email, name: user.id },
      expires: new Date(Date.now() + 24 * HOUR_MS).toISOString(),
    },
    headers: new Headers(),
  });
}

/** A handle whose transactions refuse writes to one table, so the change rolls back. */
function refusingInserts(table: unknown): typeof db {
  const guard = (tx: object) =>
    new Proxy(tx, {
      get(target, property, receiver) {
        if (property === "insert") {
          return (into: unknown) => {
            if (into === table) throw new Error("insert refused for the test");
            return (target as typeof db).insert(into as never);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return (run: (tx: object) => Promise<unknown>) =>
          target.transaction((tx) => run(guard(tx)));
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

let posts: { content: string; seen: unknown }[] = [];
const realFetch = globalThis.fetch;

function stubWebhook() {
  stubEnv("NOTIFY_DISCORD_WEBHOOK_URL", WEBHOOK);
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    posts.push({
      content: (JSON.parse(init.body as string) as { content: string }).content,
      seen: probe ? await probe() : undefined,
    });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
}

describe.skipIf(!process.env.DATABASE_URL)("notifications", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const eventIds: string[] = [];
  const electionIds: string[] = [];
  let seq = 0;

  let officer: TestUser;

  async function makeUser(label: string, role: Role = "MEMBER") {
    const id = `ntf-${label}-${suffix}`;
    const email = `${id}@vitest.local`;
    await db.insert(users).values({ id, email, role, name: `Ada ${label}` });
    userIds.push(id);
    return { id, email, role } satisfies TestUser;
  }

  async function makeEvent(label: string, startsAt: Date) {
    seq += 1;
    const [row] = await db
      .insert(events)
      .values({
        title: `ntf ${label} ${suffix}`,
        startsAt,
        checkInCode:
          `${suffix.slice(0, 6)}${String(seq).padStart(2, "0")}`.toUpperCase(),
        createdById: officer.id,
      })
      .returning();
    eventIds.push(row!.id);
    return row!;
  }

  async function optOut(
    user: TestUser,
    prefs: { eventEmails: boolean; electionEmails: boolean },
  ) {
    await callerFor(user).notification.save(prefs);
  }

  /** Mail sent to this run's test users only, whatever else is in the database. */
  const mine = () => sent.filter((mail) => mail.to.includes(suffix));

  beforeAll(async () => {
    officer = await makeUser("officer", "ADMIN");
  });

  afterAll(async () => {
    if (electionIds.length > 0) {
      await db.delete(elections).where(inArray(elections.id, electionIds));
    }
    await db
      .delete(eventCheckIns)
      .where(inArray(eventCheckIns.userId, userIds));
    if (eventIds.length > 0) {
      await db.delete(events).where(inArray(events.id, eventIds));
    }
    await db.delete(auditLog).where(inArray(auditLog.actorId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  beforeEach(() => {
    sent.length = 0;
    posts = [];
    rejected.clear();
    probe = null;
    stubEnv("GMAIL_USER", "chapter@example.com");
    stubEnv("GMAIL_APP_PASSWORD", "app-password");
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("preferences", () => {
    it(
      "start with everything on and need no row",
      async () => {
        const member = await makeUser("fresh");
        expect(await callerFor(member).notification.mine()).toEqual({
          eventEmails: true,
          electionEmails: true,
        });
        const rows = await db
          .select()
          .from(notificationPreferences)
          .where(eq(notificationPreferences.userId, member.id));
        expect(rows).toHaveLength(0);
      },
      SLOW,
    );

    it(
      "save a choice, change it, and keep one row per member",
      async () => {
        const member = await makeUser("saver");
        const other = await makeUser("bystander");

        await optOut(member, { eventEmails: false, electionEmails: true });
        expect(await callerFor(member).notification.mine()).toEqual({
          eventEmails: false,
          electionEmails: true,
        });

        await optOut(member, { eventEmails: true, electionEmails: false });
        expect(await callerFor(member).notification.mine()).toEqual({
          eventEmails: true,
          electionEmails: false,
        });

        const rows = await db
          .select()
          .from(notificationPreferences)
          .where(eq(notificationPreferences.userId, member.id));
        expect(rows).toHaveLength(1);
        expect(await callerFor(other).notification.mine()).toEqual({
          eventEmails: true,
          electionEmails: true,
        });
      },
      SLOW,
    );

    it(
      "read back per category as the members who turned it off",
      async () => {
        const noEvents = await makeUser("noevents");
        const noElections = await makeUser("noelections");
        await optOut(noEvents, { eventEmails: false, electionEmails: true });
        await optOut(noElections, { eventEmails: true, electionEmails: false });

        const event = await optedOutOf(db, "event");
        const election = await optedOutOf(db, "election");

        expect(event.has(noEvents.id)).toBe(true);
        expect(event.has(noElections.id)).toBe(false);
        expect(election.has(noElections.id)).toBe(true);
        expect(election.has(noEvents.id)).toBe(false);
      },
      SLOW,
    );

    it(
      "go with the member when the account is deleted",
      async () => {
        const member = await makeUser("leaver");
        await optOut(member, { eventEmails: false, electionEmails: false });
        await db.delete(users).where(eq(users.id, member.id));

        const rows = await db
          .select()
          .from(notificationPreferences)
          .where(eq(notificationPreferences.userId, member.id));
        expect(rows).toHaveLength(0);
      },
      SLOW,
    );
  });

  describe("application decisions", () => {
    async function apply(applicant: TestUser) {
      const [row] = await db
        .insert(committeeApplications)
        .values({
          userId: applicant.id,
          cycle: "fall-2026",
          wantsEvents: true,
          discordHandle: "applicant",
        })
        .returning({ id: committeeApplications.id });
      const status = async () =>
        (
          await db
            .select({ status: committeeApplications.status })
            .from(committeeApplications)
            .where(eq(committeeApplications.id, row!.id))
        )[0]!.status;
      return { id: row!.id, status };
    }

    it(
      "email the applicant, and only once the decision has committed",
      async () => {
        const applicant = await makeUser("applicant");
        const application = await apply(applicant);
        probe = application.status;

        const result = await callerFor(officer).committee.setStatus({
          id: application.id,
          status: "accepted",
        });

        expect(result.notice).toEqual({ ...noNotice, sent: 1 });
        expect(mine()).toHaveLength(1);
        expect(mine()[0]).toMatchObject({
          to: applicant.email,
          seen: "accepted",
        });
        expect(mine()[0]!.subject).toContain("accepted");
      },
      SLOW,
    );

    it(
      "are sent even to a member who switched every optional email off",
      async () => {
        const applicant = await makeUser("quiet");
        await optOut(applicant, { eventEmails: false, electionEmails: false });
        const application = await apply(applicant);

        const result = await callerFor(officer).committee.setStatus({
          id: application.id,
          status: "declined",
        });

        expect(result.notice).toEqual({ ...noNotice, sent: 1 });
        expect(mine().map((mail) => mail.to)).toEqual([applicant.email]);
      },
      SLOW,
    );

    it(
      "say nothing for a status that is not a decision, or one already set",
      async () => {
        const applicant = await makeUser("interview");
        const application = await apply(applicant);
        const caller = callerFor(officer);

        const interview = await caller.committee.setStatus({
          id: application.id,
          status: "interviewing",
        });
        await caller.committee.setStatus({
          id: application.id,
          status: "accepted",
        });
        sent.length = 0;
        const again = await caller.committee.setStatus({
          id: application.id,
          status: "accepted",
        });

        expect(interview.notice).toEqual(noNotice);
        expect(again.notice).toEqual(noNotice);
        expect(mine()).toHaveLength(0);
      },
      SLOW,
    );

    it(
      "keep the decision when the email bounces, and report it",
      async () => {
        const applicant = await makeUser("bounce");
        const application = await apply(applicant);
        rejected.add(applicant.email);
        vi.spyOn(console, "error").mockImplementation(() => undefined);

        const result = await callerFor(officer).committee.setStatus({
          id: application.id,
          status: "accepted",
        });

        expect(result.status).toBe("accepted");
        expect(result.notice).toEqual({ ...noNotice, failed: 1 });
        expect(await application.status()).toBe("accepted");
      },
      SLOW,
    );

    it(
      "keep the decision when email is not configured, and report it",
      async () => {
        const applicant = await makeUser("nomail");
        const application = await apply(applicant);
        stubEnv("GMAIL_USER", "");

        const result = await callerFor(officer).committee.setStatus({
          id: application.id,
          status: "declined",
        });

        expect(result.notice).toEqual({ ...noNotice, failed: 1 });
        expect(await application.status()).toBe("declined");
        expect(mine()).toHaveLength(0);
      },
      SLOW,
    );

    it(
      "send nothing when the decision rolls back",
      async () => {
        const applicant = await makeUser("rolledback");
        const application = await apply(applicant);

        await expect(
          callerFor(officer, refusingInserts(auditLog)).committee.setStatus({
            id: application.id,
            status: "accepted",
          }),
        ).rejects.toThrow();

        expect(await application.status()).toBe("submitted");
        expect(mine()).toHaveLength(0);
      },
      SLOW,
    );
  });

  describe("event changes", () => {
    let rsvpA: TestUser;
    let rsvpB: TestUser;
    let rsvpC: TestUser;

    beforeAll(async () => {
      rsvpA = await makeUser("rsvp-a");
      rsvpB = await makeUser("rsvp-b");
      rsvpC = await makeUser("rsvp-c");
      await optOut(rsvpB, { eventEmails: false, electionEmails: true });
    });

    async function upcoming(label: string) {
      const event = await makeEvent(label, new Date(Date.now() + 48 * HOUR_MS));
      await db.insert(eventRsvps).values(
        [rsvpA, rsvpB, rsvpC].map((user) => ({
          eventId: event.id,
          userId: user.id,
        })),
      );
      const archived = async () =>
        (
          await db
            .select({ archivedAt: events.archivedAt })
            .from(events)
            .where(eq(events.id, event.id))
        )[0]!.archivedAt !== null;
      const startsAt = async () =>
        (
          await db
            .select({ startsAt: events.startsAt })
            .from(events)
            .where(eq(events.id, event.id))
        )[0]!.startsAt.getTime();
      return { event, archived, startsAt };
    }

    it(
      "tell RSVPs of a new time once it has committed, except those who opted out",
      async () => {
        const { event, startsAt } = await upcoming("moved");
        const moved = new Date(event.startsAt.getTime() + 2 * HOUR_MS);
        probe = startsAt;

        const result = await callerFor(officer).event.update({
          id: event.id,
          title: event.title,
          startsAt: moved,
          pointsValue: event.pointsValue,
        });

        expect(result.invites).toEqual({ ...noNotice, sent: 2, skipped: 1 });
        expect(
          mine()
            .map((mail) => mail.to)
            .sort(),
        ).toEqual([rsvpA.email, rsvpC.email].sort());
        for (const mail of mine()) {
          expect(mail.method).toBe("REQUEST");
          expect(mail.seen).toBe(moved.getTime());
        }
      },
      SLOW,
    );

    it(
      "cancel the calendar entry when an upcoming event is archived, once",
      async () => {
        const { event, archived } = await upcoming("cancelled");
        probe = archived;
        const caller = callerFor(officer);

        const result = await caller.event.setArchived({
          id: event.id,
          archived: true,
        });
        const again = await caller.event.setArchived({
          id: event.id,
          archived: true,
        });

        expect(result.invites).toEqual({ ...noNotice, sent: 2, skipped: 1 });
        expect(again.invites).toEqual(noNotice);
        expect(mine()).toHaveLength(2);
        for (const mail of mine()) {
          expect(mail.method).toBe("CANCEL");
          expect(mail.subject).toStartWith("Cancelled:");
          expect(mail.seen).toBe(true);
        }
      },
      SLOW,
    );

    it(
      "put the entry back when the event is restored",
      async () => {
        const { event, archived } = await upcoming("restored");
        const caller = callerFor(officer);
        await caller.event.setArchived({ id: event.id, archived: true });
        sent.length = 0;
        probe = archived;

        const result = await caller.event.setArchived({
          id: event.id,
          archived: false,
        });

        expect(result.invites.sent).toBe(2);
        for (const mail of mine()) {
          expect(mail.method).toBe("REQUEST");
          expect(mail.subject).toStartWith("Back on:");
          expect(mail.seen).toBe(false);
        }
      },
      SLOW,
    );

    it(
      "leave a past event alone when it is archived",
      async () => {
        const past = await makeEvent(
          "past",
          new Date(Date.now() - 72 * HOUR_MS),
        );
        await db
          .insert(eventRsvps)
          .values({ eventId: past.id, userId: rsvpA.id });

        const result = await callerFor(officer).event.setArchived({
          id: past.id,
          archived: true,
        });

        expect(result.invites).toEqual(noNotice);
        expect(mine()).toHaveLength(0);
      },
      SLOW,
    );

    it(
      "keep the edit when a send bounces, and report it",
      async () => {
        const { event } = await upcoming("bounce");
        rejected.add(rsvpC.email);
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const moved = new Date(event.startsAt.getTime() + HOUR_MS);

        const result = await callerFor(officer).event.update({
          id: event.id,
          title: event.title,
          startsAt: moved,
          pointsValue: event.pointsValue,
        });

        expect(result.invites).toEqual({
          ...noNotice,
          sent: 1,
          failed: 1,
          skipped: 1,
        });
        expect(result.startsAt.getTime()).toBe(moved.getTime());
      },
      SLOW,
    );

    it(
      "post a cancellation to the channel after it has committed",
      async () => {
        const { event, archived } = await upcoming("channel");
        stubWebhook();
        probe = archived;

        const result = await callerFor(officer).event.setArchived({
          id: event.id,
          archived: true,
        });

        expect(result.invites.channel).toBe("posted");
        expect(posts).toHaveLength(1);
        expect(posts[0]!.content).toStartWith("Cancelled:");
        expect(posts[0]!.seen).toBe(true);
      },
      SLOW,
    );
  });

  describe("election announcements", () => {
    let voter: TestUser;
    let quiet: TestUser;
    let lapsed: TestUser;
    let outsider: TestUser;
    let runner: TestUser;

    beforeAll(async () => {
      voter = await makeUser("voter");
      quiet = await makeUser("quiet-voter");
      lapsed = await makeUser("lapsed");
      outsider = await makeUser("outsider");
      runner = await makeUser("runner");
      await optOut(quiet, { eventEmails: true, electionEmails: false });

      const counted = await makeEvent("counted", new Date());
      const archived = await makeEvent("archived", new Date());
      await db
        .update(events)
        .set({ archivedAt: new Date() })
        .where(eq(events.id, archived.id));
      await db.insert(eventCheckIns).values([
        ...[voter, quiet, runner].map((user) => ({
          eventId: counted.id,
          userId: user.id,
          pointsEarned: 10,
        })),
        { eventId: archived.id, userId: lapsed.id, pointsEarned: 10 },
      ]);
    });

    async function createElection(label: string) {
      const election = await callerFor(officer).election.create({
        title: `ntf ${label} ${suffix}`,
        positions: ["President"],
      });
      electionIds.push(election.id);
      return election;
    }

    const phaseOf = (id: string) => async () =>
      (
        await db
          .select({ phase: elections.phase })
          .from(elections)
          .where(eq(elections.id, id))
      )[0]!.phase;

    it(
      "tell members with a counted check-in this year that nominations opened",
      async () => {
        const election = await createElection("create");

        expect(election.notice.skipped).toBeGreaterThanOrEqual(1);
        expect(election.notice.failed).toBe(0);
        // The runner and the voter are eligible; the opted-out, the lapsed
        // (archived event only) and the outsider (no check-in) hear nothing.
        expect(
          mine()
            .map((mail) => mail.to)
            .sort(),
        ).toEqual([voter.email, runner.email].sort());
        for (const mail of mine()) {
          expect(mail.subject).toBe(`Nominations are open: ${election.title}`);
        }
        expect(mine().map((mail) => mail.to)).not.toContain(outsider.email);
      },
      SLOW,
    );

    it(
      "announce voting and results, not the polls closing or a reopening",
      async () => {
        const election = await createElection("phases");
        const [position] = await db.query.electionPositions.findMany({
          where: (table, { eq: same }) => same(table.electionId, election.id),
        });
        const [candidate] = await db
          .insert(electionCandidates)
          .values({
            positionId: position!.id,
            userId: runner.id,
            statement: "Boba for all.",
            status: "approved",
          })
          .returning({ id: electionCandidates.id });
        expect(candidate).toBeDefined();
        const caller = callerFor(officer);
        const move = (
          phase: "voting" | "closed" | "published" | "nominating",
        ) => caller.election.setPhase({ electionId: election.id, phase });
        sent.length = 0;

        probe = phaseOf(election.id);
        const opened = await move("voting");
        const openedMail = [...mine()];
        sent.length = 0;
        const closed = await move("closed");
        const closedMail = [...mine()];
        sent.length = 0;
        const published = await move("published");
        const publishedMail = [...mine()];

        expect(opened.notice.sent).toBe(2);
        expect(openedMail.map((mail) => mail.subject)).toEqual([
          `Voting is open: ${election.title}`,
          `Voting is open: ${election.title}`,
        ]);
        // Each email left only after the phase had committed.
        expect(openedMail.map((mail) => mail.seen)).toEqual([
          "voting",
          "voting",
        ]);
        expect(closed.notice).toEqual(noNotice);
        expect(closedMail).toHaveLength(0);
        expect(published.notice.sent).toBe(2);
        expect(publishedMail.map((mail) => mail.subject)).toEqual([
          `Results are in: ${election.title}`,
          `Results are in: ${election.title}`,
        ]);
        expect(publishedMail.map((mail) => mail.seen)).toEqual([
          "published",
          "published",
        ]);
      },
      SLOW,
    );

    it(
      "do not announce reopening nominations, which is a correction",
      async () => {
        const election = await createElection("reopen");
        const [position] = await db.query.electionPositions.findMany({
          where: (table, { eq: same }) => same(table.electionId, election.id),
        });
        await db.insert(electionCandidates).values({
          positionId: position!.id,
          userId: runner.id,
          statement: "Boba for all.",
          status: "approved",
        });
        const caller = callerFor(officer);
        await caller.election.setPhase({
          electionId: election.id,
          phase: "voting",
        });
        sent.length = 0;

        const back = await caller.election.setPhase({
          electionId: election.id,
          phase: "nominating",
        });

        expect(back.notice).toEqual(noNotice);
        expect(mine()).toHaveLength(0);
      },
      SLOW,
    );

    it(
      "keep the phase change when email is not configured, and report it",
      async () => {
        const election = await createElection("nomail");
        const [position] = await db.query.electionPositions.findMany({
          where: (table, { eq: same }) => same(table.electionId, election.id),
        });
        await db.insert(electionCandidates).values({
          positionId: position!.id,
          userId: runner.id,
          statement: "Boba for all.",
          status: "approved",
        });
        stubEnv("GMAIL_USER", "");
        sent.length = 0;

        const result = await callerFor(officer).election.setPhase({
          electionId: election.id,
          phase: "voting",
        });

        expect(result.phase).toBe("voting");
        expect(result.notice.failed).toBeGreaterThanOrEqual(1);
        expect(result.notice.sent).toBe(0);
        expect(await phaseOf(election.id)()).toBe("voting");
      },
      SLOW,
    );

    it(
      "post to the channel when a webhook is configured",
      async () => {
        stubWebhook();
        const election = await createElection("channel");

        expect(election.notice.channel).toBe("posted");
        expect(posts).toHaveLength(1);
        expect(posts[0]!.content).toContain(
          `Nominations are open: ${election.title}`,
        );
      },
      SLOW,
    );
  });
});
