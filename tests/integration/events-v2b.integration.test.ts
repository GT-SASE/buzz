import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
} from "bun:test";
import { liveCode } from "../helpers/check-in-code";
import { stubEnv, unstubAllEnvs } from "../helpers/env";

mock.module("../../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

/** What would have been emailed, instead of talking to Gmail. */
const sent: { to: string; method: string; subject: string }[] = [];
mock.module("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: async (message: {
        to: string;
        subject: string;
        icalEvent: { method: string };
      }) => {
        sent.push({
          to: message.to,
          method: message.icalEvent.method,
          subject: message.subject,
        });
      },
    }),
  },
}));

const {
  auditLog,
  db,
  eventCheckIns,
  eventRsvps,
  events,
  eventSeriesMembers,
  eventWaitlist,
  notificationPreferences,
  pointsLedger,
  users,
} = await import("../../packages/db/src/index");
const { createCaller } = await import("../../packages/api/src/root");
const { WINDOW_MS } = await import("../../packages/api/src/check-in-code");
const { and, asc, eq, inArray, sql } =
  await import("../../packages/db/node_modules/drizzle-orm/index.js");

const SLOW = 30_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type TestUser = { id: string; email: string; role: "MEMBER" | "ADMIN" };

function callerFor(user: TestUser | null) {
  return createCaller({
    db,
    session: user && {
      user: { id: user.id, role: user.role, email: user.email, name: "vitest" },
      expires: new Date(Date.now() + DAY_MS).toISOString(),
    },
    headers: new Headers(),
  });
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
    return { code: "NO_ERROR", message: "" };
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    return { code: code ?? "UNKNOWN", message: message ?? "" };
  }
}

describe.skipIf(!process.env.DATABASE_URL)("events v2b", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const eventIds: string[] = [];
  let admin: TestUser;
  let people: TestUser[] = [];

  async function makeUser(tag: string, role: "MEMBER" | "ADMIN" = "MEMBER") {
    const [row] = await db
      .insert(users)
      .values({
        email: `v2b-${tag}-${suffix}@example.invalid`,
        name: `v2b ${tag}`,
        role,
      })
      .returning();
    if (!row) throw new Error(`could not create ${tag}`);
    userIds.push(row.id);
    return { id: row.id, email: row.email, role } satisfies TestUser;
  }

  /** Creates through the router, like an officer, and remembers the rows. */
  async function createEvent(
    input: Partial<
      Parameters<ReturnType<typeof callerFor>["event"]["create"]>[0]
    > = {},
  ) {
    const created = await callerFor(admin).event.create({
      title: `v2b ${suffix}`,
      startsAt: new Date(Date.now() + 2 * DAY_MS),
      pointsValue: 10,
      ...input,
    });
    return created;
  }

  async function trackSeries(firstId: string) {
    const [member] = await db
      .select()
      .from(eventSeriesMembers)
      .where(eq(eventSeriesMembers.eventId, firstId));
    const ids = member
      ? (
          await db
            .select({ id: eventSeriesMembers.eventId })
            .from(eventSeriesMembers)
            .where(eq(eventSeriesMembers.seriesId, member.seriesId))
        ).map((row) => row.id)
      : [firstId];
    for (const id of ids) if (!eventIds.includes(id)) eventIds.push(id);
    return ids;
  }

  async function occurrences(seriesOf: string) {
    const [member] = await db
      .select()
      .from(eventSeriesMembers)
      .where(eq(eventSeriesMembers.eventId, seriesOf));
    return db
      .select({
        id: events.id,
        title: events.title,
        location: events.location,
        startsAt: events.startsAt,
        archivedAt: events.archivedAt,
        position: eventSeriesMembers.position,
      })
      .from(eventSeriesMembers)
      .innerJoin(events, eq(events.id, eventSeriesMembers.eventId))
      .where(eq(eventSeriesMembers.seriesId, member!.seriesId))
      .orderBy(asc(eventSeriesMembers.position));
  }

  async function auditFor(action: string, targetId: string) {
    return db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorId, admin.id),
          eq(auditLog.action, action as never),
          eq(auditLog.targetId, targetId),
        ),
      );
  }

  async function going(eventId: string) {
    const rows = await db
      .select({ userId: eventRsvps.userId })
      .from(eventRsvps)
      .where(eq(eventRsvps.eventId, eventId));
    return rows.map((row) => row.userId).sort();
  }

  async function waiting(eventId: string) {
    const rows = await db
      .select({ userId: eventWaitlist.userId })
      .from(eventWaitlist)
      .where(eq(eventWaitlist.eventId, eventId))
      .orderBy(asc(eventWaitlist.createdAt), asc(eventWaitlist.userId));
    return rows.map((row) => row.userId);
  }

  beforeAll(async () => {
    admin = await makeUser("officer", "ADMIN");
    people = await Promise.all(
      ["a", "b", "c", "d", "e", "f"].map((tag) => makeUser(tag)),
    );
  }, SLOW);

  afterAll(async () => {
    setSystemTime();
    if (eventIds.length > 0) {
      await db
        .delete(eventCheckIns)
        .where(inArray(eventCheckIns.eventId, eventIds));
      await db
        .delete(pointsLedger)
        .where(inArray(pointsLedger.eventId, eventIds));
      await db.delete(events).where(inArray(events.id, eventIds));
    }
    await db.delete(auditLog).where(eq(auditLog.actorId, admin.id));
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  }, SLOW);

  afterEach(() => {
    setSystemTime();
    unstubAllEnvs();
    sent.length = 0;
  });

  // ------------------------------------------------------------ recurring

  describe("recurring events", () => {
    it(
      "expands a weekly series into real events, one audit row for the lot",
      async () => {
        const first = new Date(Date.now() + 3 * DAY_MS);
        const created = await createEvent({
          title: `weekly ${suffix}`,
          startsAt: first,
          maxCheckIns: 25,
          repeat: { cadence: "weekly", count: 4 },
        });
        const ids = await trackSeries(created.id);
        expect(created.occurrences).toBe(4);
        expect(ids).toHaveLength(4);

        const rows = await occurrences(created.id);
        expect(rows.map((row) => row.position)).toEqual([0, 1, 2, 3]);
        expect(rows[0]!.startsAt.getTime()).toBe(first.getTime());
        for (let i = 1; i < rows.length; i++) {
          const gap =
            rows[i]!.startsAt.getTime() - rows[i - 1]!.startsAt.getTime();
          // A week, give or take the hour a clock change moves it.
          expect(Math.abs(gap - 7 * DAY_MS)).toBeLessThanOrEqual(HOUR_MS);
        }

        // Real rows: each has its own code, seats and defaults.
        const stored = await db
          .select()
          .from(events)
          .where(inArray(events.id, ids));
        expect(new Set(stored.map((row) => row.checkInCode)).size).toBe(4);
        expect(stored.every((row) => row.maxCheckIns === 25)).toBe(true);
        expect(stored.every((row) => row.createdById === admin.id)).toBe(true);

        const audit = await auditFor("event.create_series", created.id);
        expect(audit).toHaveLength(1);
        expect(audit[0]!.after).toMatchObject({
          cadence: "weekly",
          occurrences: 4,
        });
        expect(JSON.stringify(audit[0])).not.toContain(stored[0]!.checkInCode);
      },
      SLOW,
    );

    it(
      "repeats every two weeks until an end date",
      async () => {
        const first = new Date(Date.now() + 2 * DAY_MS);
        const created = await createEvent({
          title: `biweekly ${suffix}`,
          startsAt: first,
          repeat: {
            cadence: "biweekly",
            until: new Date(first.getTime() + 29 * DAY_MS),
          },
        });
        await trackSeries(created.id);
        // Day 0, 14, 28 are in; 42 is out.
        expect(created.occurrences).toBe(3);
      },
      SLOW,
    );

    it(
      "refuses a repeat with both or neither of count and end date, and a one-event series",
      async () => {
        const startsAt = new Date(Date.now() + 2 * DAY_MS);
        const caller = callerFor(admin);
        const base = { title: "x", startsAt, pointsValue: 1 };
        expect(
          (
            await errorOf(
              caller.event.create({
                ...base,
                repeat: {
                  cadence: "weekly",
                  count: 3,
                  until: new Date(startsAt.getTime() + 30 * DAY_MS),
                },
              }),
            )
          ).code,
        ).toBe("BAD_REQUEST");
        expect(
          (
            await errorOf(
              caller.event.create({ ...base, repeat: { cadence: "weekly" } }),
            )
          ).code,
        ).toBe("BAD_REQUEST");
        expect(
          (
            await errorOf(
              caller.event.create({
                ...base,
                repeat: { cadence: "weekly", count: 27 },
              }),
            )
          ).code,
        ).toBe("BAD_REQUEST");
        expect(
          (
            await errorOf(
              caller.event.create({
                ...base,
                repeat: {
                  cadence: "weekly",
                  until: new Date(startsAt.getTime() + DAY_MS),
                },
              }),
            )
          ).code,
        ).toBe("BAD_REQUEST");
      },
      SLOW,
    );

    it(
      "edits one occurrence without touching the others",
      async () => {
        const created = await createEvent({
          title: `one ${suffix}`,
          repeat: { cadence: "weekly", count: 3 },
        });
        await trackSeries(created.id);
        const [a, b, c] = await occurrences(created.id);

        const result = await callerFor(admin).event.update({
          id: b!.id,
          title: `one ${suffix} renamed`,
          startsAt: b!.startsAt,
          pointsValue: 10,
          scope: "one",
        });
        expect(result.occurrences).toBe(1);

        const after = await occurrences(created.id);
        expect(after.map((row) => row.title)).toEqual([
          a!.title,
          `one ${suffix} renamed`,
          c!.title,
        ]);
        const audit = await auditFor("event.update", b!.id);
        expect(audit).toHaveLength(1);
        expect(audit[0]!.before).toEqual({ title: a!.title });
        expect(audit[0]!.after).toEqual({ title: `one ${suffix} renamed` });
      },
      SLOW,
    );

    it(
      "edits this and later occurrences, never earlier ones, and only the fields that changed",
      async () => {
        const created = await createEvent({
          title: `all ${suffix}`,
          location: "Klaus 1116",
          repeat: { cadence: "weekly", count: 4 },
        });
        await trackSeries(created.id);
        const [a, b, c, d] = await occurrences(created.id);
        // One later week already moved rooms by hand.
        await callerFor(admin).event.update({
          id: c!.id,
          title: c!.title,
          location: "CULC 144",
          startsAt: c!.startsAt,
          pointsValue: 10,
          scope: "one",
        });

        const result = await callerFor(admin).event.update({
          id: b!.id,
          title: `all ${suffix} renamed`,
          location: "Klaus 1116",
          startsAt: b!.startsAt,
          pointsValue: 25,
          scope: "future",
        });
        expect(result.occurrences).toBe(3);

        const after = await occurrences(created.id);
        expect(after.map((row) => row.title)).toEqual([
          a!.title,
          `all ${suffix} renamed`,
          `all ${suffix} renamed`,
          `all ${suffix} renamed`,
        ]);
        // The hand-edited room survives: location was not part of this edit.
        expect(after.map((row) => row.location)).toEqual([
          "Klaus 1116",
          "Klaus 1116",
          "CULC 144",
          "Klaus 1116",
        ]);
        const points = await db
          .select({ id: events.id, pointsValue: events.pointsValue })
          .from(events)
          .where(inArray(events.id, [a!.id, b!.id, c!.id, d!.id]));
        const byId = new Map(points.map((row) => [row.id, row.pointsValue]));
        expect([a, b, c, d].map((row) => byId.get(row!.id))).toEqual([
          10, 25, 25, 25,
        ]);

        const audit = await auditFor("event.update_series", b!.id);
        expect(audit).toHaveLength(1);
        expect(audit[0]!.after).toMatchObject({ occurrences: 3, points: 25 });
      },
      SLOW,
    );

    it(
      "moves later occurrences by the same shift when the time changes",
      async () => {
        const created = await createEvent({
          title: `shift ${suffix}`,
          repeat: { cadence: "weekly", count: 3 },
        });
        await trackSeries(created.id);
        const [a, b, c] = await occurrences(created.id);

        await callerFor(admin).event.update({
          id: b!.id,
          title: b!.title,
          startsAt: new Date(b!.startsAt.getTime() + 2 * HOUR_MS),
          pointsValue: 10,
          scope: "future",
        });
        const after = await occurrences(created.id);
        expect(after[0]!.startsAt.getTime()).toBe(a!.startsAt.getTime());
        expect(after[1]!.startsAt.getTime()).toBe(
          b!.startsAt.getTime() + 2 * HOUR_MS,
        );
        // The same wall-clock shift, so within an hour of two hours.
        expect(
          Math.abs(
            after[2]!.startsAt.getTime() -
              (c!.startsAt.getTime() + 2 * HOUR_MS),
          ),
        ).toBeLessThanOrEqual(HOUR_MS);
      },
      SLOW,
    );

    it(
      "archives and restores one occurrence or this and all later ones, with audit rows",
      async () => {
        const created = await createEvent({
          title: `arch ${suffix}`,
          repeat: { cadence: "weekly", count: 4 },
        });
        await trackSeries(created.id);
        const [a, b, c, d] = await occurrences(created.id);
        const officer = callerFor(admin);

        const one = await officer.event.setArchived({
          id: a!.id,
          archived: true,
          scope: "one",
        });
        expect(one.occurrences).toBe(1);
        let state = await occurrences(created.id);
        expect(state.map((row) => row.archivedAt !== null)).toEqual([
          true,
          false,
          false,
          false,
        ]);
        expect(await auditFor("event.archive", a!.id)).toHaveLength(1);

        const future = await officer.event.setArchived({
          id: c!.id,
          archived: true,
          scope: "future",
        });
        expect(future.occurrences).toBe(2);
        state = await occurrences(created.id);
        expect(state.map((row) => row.archivedAt !== null)).toEqual([
          true,
          false,
          true,
          true,
        ]);
        expect(
          (await auditFor("event.archive_series", c!.id))[0]!.after,
        ).toEqual({ archived: true, occurrences: 2 });

        // Restoring from the second on skips what is already live.
        const restored = await officer.event.setArchived({
          id: b!.id,
          archived: false,
          scope: "future",
        });
        expect(restored.occurrences).toBe(2);
        state = await occurrences(created.id);
        expect(state.map((row) => row.archivedAt !== null)).toEqual([
          true,
          false,
          false,
          false,
        ]);
        expect(d).toBeDefined();
      },
      SLOW,
    );

    it(
      "keeps RSVPs and check-ins per occurrence",
      async () => {
        const created = await createEvent({
          title: `per ${suffix}`,
          startsAt: new Date(Date.now() + HOUR_MS),
          repeat: { cadence: "weekly", count: 2 },
        });
        await trackSeries(created.id);
        const [a, b] = await occurrences(created.id);
        const who = people[0]!;

        await callerFor(who).event.rsvp({ eventId: b!.id });
        expect(await going(a!.id)).toEqual([]);
        expect(await going(b!.id)).toEqual([who.id]);

        // The first one is inside its check-in window: scan it.
        const [row] = await db
          .select()
          .from(events)
          .where(eq(events.id, a!.id));
        const result = await callerFor(who).event.checkIn({
          code: liveCode(row!),
        });
        expect(result.eventTitle).toBe(a!.title);
        const checkIns = await db
          .select()
          .from(eventCheckIns)
          .where(inArray(eventCheckIns.eventId, [a!.id, b!.id]));
        expect(checkIns.map((c) => c.eventId)).toEqual([a!.id]);
      },
      SLOW,
    );

    it(
      "says a series member is in a series on the officer list, and a one-off is not",
      async () => {
        const created = await createEvent({
          title: `list ${suffix}`,
          repeat: { cadence: "biweekly", count: 2 },
        });
        await trackSeries(created.id);
        const lone = await createEvent({ title: `lone ${suffix}` });
        eventIds.push(lone.id);
        const list = await callerFor(admin).event.listAll({ limit: 200 });
        const mine = list.events.find((row) => row.id === created.id);
        expect(mine?.series).toMatchObject({
          cadence: "biweekly",
          position: 0,
        });
        expect(
          list.events.find((row) => row.id === lone.id)?.series,
        ).toBeNull();
        // The stored key is not an officer-screen field any more.
        expect(mine).not.toHaveProperty("checkInCode");
        const detail = await callerFor(admin).event.getById({ id: created.id });
        expect(detail.event).not.toHaveProperty("checkInCode");
        expect(detail.series?.cadence).toBe("biweekly");
      },
      SLOW,
    );
  });

  // ------------------------------------------------------------- waitlist

  describe("capacity and the waitlist", () => {
    async function seatedEvent(seats: number, title = "wl") {
      const created = await createEvent({
        title: `${title} ${suffix}`,
        maxCheckIns: seats,
      });
      eventIds.push(created.id);
      return created.id;
    }

    it(
      "seats members up to capacity, then queues them in order",
      async () => {
        const id = await seatedEvent(2);
        const [a, b, c, d] = people;
        for (const who of [a!, b!]) {
          expect(
            await callerFor(who).event.rsvp({ eventId: id }),
          ).toMatchObject({
            rsvped: true,
            waitlisted: false,
          });
        }
        expect(await callerFor(c!).event.rsvp({ eventId: id })).toMatchObject({
          rsvped: false,
          waitlisted: true,
          waitlistPosition: 1,
        });
        expect(await callerFor(d!).event.rsvp({ eventId: id })).toMatchObject({
          waitlisted: true,
          waitlistPosition: 2,
        });
        // Asking again changes nothing and keeps the place.
        expect(await callerFor(c!).event.rsvp({ eventId: id })).toMatchObject({
          waitlisted: true,
          waitlistPosition: 1,
        });
        expect(await going(id)).toEqual([a!.id, b!.id].sort());
        expect(await waiting(id)).toEqual([c!.id, d!.id]);

        const stateC = await callerFor(c!).event.rsvpState({ eventIds: [id] });
        expect(stateC).toEqual({
          going: [],
          waitlisted: [{ eventId: id, position: 1 }],
          full: [],
        });
        const stateE = await callerFor(people[4]!).event.rsvpState({
          eventIds: [id],
        });
        expect(stateE.full).toEqual([id]);
        const stateA = await callerFor(a!).event.rsvpState({ eventIds: [id] });
        expect(stateA).toEqual({ going: [id], waitlisted: [], full: [] });

        const list = await callerFor(c!).event.upcoming();
        expect(list.find((row) => row.id === id)).toMatchObject({
          seatsLeft: 0,
          full: true,
          waitlistPosition: 1,
        });

        const detail = await callerFor(admin).event.getById({ id });
        expect(detail.waitlist.map((row) => row.userId)).toEqual([
          c!.id,
          d!.id,
        ]);
      },
      SLOW,
    );

    it(
      "promotes the first waiter when a seat is freed, and tells them even if event emails are off",
      async () => {
        stubEnv("GMAIL_USER", "chapter@example.com");
        stubEnv("GMAIL_APP_PASSWORD", "app-password");
        const id = await seatedEvent(2);
        const [a, b, c, d] = people;
        // c has event emails switched off: a promotion still has to reach them.
        await db
          .insert(notificationPreferences)
          .values({ userId: c!.id, eventEmails: false });
        for (const who of [a!, b!, c!, d!]) {
          await callerFor(who).event.rsvp({ eventId: id });
        }
        sent.length = 0;

        await callerFor(a!).event.cancelRsvp({ eventId: id });

        expect(await going(id)).toEqual([b!.id, c!.id].sort());
        expect(await waiting(id)).toEqual([d!.id]);
        const toC = sent.filter((mail) => mail.to === c!.email);
        expect(toC).toHaveLength(1);
        expect(toC[0]).toMatchObject({ method: "REQUEST" });
        expect(toC[0]!.subject).toContain("A seat opened");
        // Nobody else was mailed a promotion; a got their own cancellation.
        expect(sent.filter((mail) => mail.to === d!.email)).toHaveLength(0);
        expect(
          sent.filter((mail) => mail.to === a!.email).map((m) => m.method),
        ).toEqual(["CANCEL"]);

        // Cancelling again frees nothing and promotes nobody.
        sent.length = 0;
        await callerFor(a!).event.cancelRsvp({ eventId: id });
        expect(await going(id)).toEqual([b!.id, c!.id].sort());
        expect(sent).toHaveLength(0);
        await db
          .delete(notificationPreferences)
          .where(eq(notificationPreferences.userId, c!.id));
      },
      SLOW,
    );

    it(
      "lets a waiting member leave the line without freeing or taking a seat",
      async () => {
        const id = await seatedEvent(1);
        const [a, b, c] = people;
        await callerFor(a!).event.rsvp({ eventId: id });
        await callerFor(b!).event.rsvp({ eventId: id });
        await callerFor(c!).event.rsvp({ eventId: id });
        await callerFor(b!).event.cancelRsvp({ eventId: id });
        expect(await going(id)).toEqual([a!.id]);
        expect(await waiting(id)).toEqual([c!.id]);
      },
      SLOW,
    );

    it(
      "gives two simultaneous cancels two different waiters, none lost or doubled",
      async () => {
        const id = await seatedEvent(2);
        const [a, b, c, d, e] = people;
        for (const who of [a!, b!, c!, d!, e!]) {
          await callerFor(who).event.rsvp({ eventId: id });
        }
        await Promise.all([
          callerFor(a!).event.cancelRsvp({ eventId: id }),
          callerFor(b!).event.cancelRsvp({ eventId: id }),
        ]);
        expect(await going(id)).toEqual([c!.id, d!.id].sort());
        expect(await waiting(id)).toEqual([e!.id]);
      },
      SLOW,
    );

    it(
      "settles a cancel racing a new RSVP the same way whichever lands first",
      async () => {
        for (let round = 0; round < 5; round++) {
          const id = await seatedEvent(2, `race${round}`);
          const [a, b, c, d] = people;
          for (const who of [a!, b!, c!]) {
            await callerFor(who).event.rsvp({ eventId: id });
          }
          // c waits. a leaves while d arrives.
          await Promise.all([
            callerFor(a!).event.cancelRsvp({ eventId: id }),
            callerFor(d!).event.rsvp({ eventId: id }),
          ]);
          expect(await going(id)).toEqual([b!.id, c!.id].sort());
          expect(await waiting(id)).toEqual([d!.id]);
        }
      },
      SLOW,
    );

    it(
      "never oversells the last seats under a rush of RSVPs",
      async () => {
        const id = await seatedEvent(2, "rush");
        const results = await Promise.all(
          people.map((who) => callerFor(who).event.rsvp({ eventId: id })),
        );
        expect(results.filter((result) => result.rsvped)).toHaveLength(2);
        expect(results.filter((result) => result.waitlisted)).toHaveLength(4);
        expect(await going(id)).toHaveLength(2);
        expect(await waiting(id)).toHaveLength(4);
        // Positions are 1..4 with no repeats.
        expect(
          results
            .filter((result) => result.waitlisted)
            .map((result) => result.waitlistPosition)
            .sort(),
        ).toEqual([1, 2, 3, 4]);
      },
      SLOW,
    );

    it(
      "promotes from the waitlist when an officer raises the seats, and when the limit is lifted",
      async () => {
        const id = await seatedEvent(1, "grow");
        const [a, b, c, d] = people;
        for (const who of [a!, b!, c!, d!]) {
          await callerFor(who).event.rsvp({ eventId: id });
        }
        const [row] = await db.select().from(events).where(eq(events.id, id));
        const edit = (maxCheckIns: number | null) =>
          callerFor(admin).event.update({
            id,
            title: row!.title,
            startsAt: row!.startsAt,
            pointsValue: row!.pointsValue,
            maxCheckIns,
          });

        // Lowering evicts nobody.
        expect((await edit(1)).promoted).toBe(0);
        const raised = await edit(2);
        expect(raised.promoted).toBe(1);
        expect(await going(id)).toEqual([a!.id, b!.id].sort());
        expect(await waiting(id)).toEqual([c!.id, d!.id]);

        const lifted = await edit(null);
        expect(lifted.promoted).toBe(2);
        expect(await going(id)).toEqual([a!.id, b!.id, c!.id, d!.id].sort());
        expect(await waiting(id)).toEqual([]);

        const audit = await auditFor("event.update", id);
        expect(audit.map((entry) => entry.after)).toHaveLength(2);
        expect(audit.map((entry) => entry.after)).toContainEqual({ seats: 2 });
        expect(audit.map((entry) => entry.after)).toContainEqual({
          seats: "no limit",
        });
      },
      SLOW,
    );

    it(
      "refuses RSVPs for an archived or started event, waitlist or not",
      async () => {
        const id = await seatedEvent(1, "closed");
        const walker = await makeUser("walker");
        await callerFor(admin).event.setArchived({ id, archived: true });
        const archived = await errorOf(
          callerFor(walker).event.rsvp({ eventId: id }),
        );
        expect(archived.code).toBe("NOT_FOUND");

        const [past] = await db
          .insert(events)
          .values({
            title: `started ${suffix}`,
            startsAt: new Date(Date.now() - HOUR_MS),
            checkInCode: crypto.randomUUID().slice(0, 8).toUpperCase(),
            maxCheckIns: 1,
            createdById: admin.id,
          })
          .returning({ id: events.id });
        eventIds.push(past!.id);
        const started = await errorOf(
          callerFor(walker).event.rsvp({ eventId: past!.id }),
        );
        expect(started.code).toBe("BAD_REQUEST");
      },
      SLOW,
    );
  });

  // ------------------------------------------------- before the migration

  describe("a preview running ahead of migration 0018", () => {
    it(
      "keeps RSVPs, cancels and the officer pages working when the new tables are absent",
      async () => {
        const created = await createEvent({
          title: `ahead ${suffix}`,
          maxCheckIns: 1,
          repeat: { cadence: "weekly", count: 2 },
        });
        await trackSeries(created.id);
        const a = await makeUser("ahead-a");
        const b = await makeUser("ahead-b");
        // Seat a, so b would be queued on a migrated database.
        await callerFor(a).event.rsvp({ eventId: created.id });

        const hide = (table: string, to: string) =>
          db.execute(sql.raw(`alter table "${table}" rename to "${to}"`));
        await hide("buzz_event_waitlist", "hidden_waitlist");
        await hide("buzz_event_series_member", "hidden_series");
        try {
          // Full, and no waitlist to join: seated as before the feature.
          const seated = await callerFor(b).event.rsvp({
            eventId: created.id,
          });
          expect(seated).toMatchObject({ rsvped: true, waitlisted: false });
          await callerFor(b).event.cancelRsvp({ eventId: created.id });
          await callerFor(a).event.cancelRsvp({ eventId: created.id });

          const list = await callerFor(admin).event.listAll({ limit: 200 });
          expect(list.events.find((row) => row.id === created.id)?.series).toBe(
            null,
          );
          const detail = await callerFor(admin).event.getById({
            id: created.id,
          });
          expect(detail.waitlist).toEqual([]);
          expect(detail.series).toBeNull();
          const state = await callerFor(a).event.rsvpState({
            eventIds: [created.id],
          });
          expect(state.waitlisted).toEqual([]);
          await callerFor(a).event.upcoming();
        } finally {
          await hide("hidden_waitlist", "buzz_event_waitlist");
          await hide("hidden_series", "buzz_event_series_member");
        }
      },
      SLOW,
    );
  });

  // ---------------------------------------------------------- rotating QR

  describe("rotating check-in codes through the router", () => {
    async function openEvent(title: string) {
      const created = await createEvent({
        title: `${title} ${suffix}`,
        startsAt: new Date(Date.now() + HOUR_MS),
      });
      eventIds.push(created.id);
      const [row] = await db
        .select()
        .from(events)
        .where(eq(events.id, created.id));
      return row!;
    }

    it(
      "admits the code on screen now, the previous window's, and nothing older",
      async () => {
        const event = await openEvent("qr");
        const [a, b, c] = people;
        const t0 = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS + 1000;

        // Shown in window N.
        const shown = liveCode(event, t0);

        // Window N: fine.
        setSystemTime(new Date(t0 + 2000));
        await callerFor(a!).event.checkIn({ code: shown });

        // Window N+1: the previous window's code still works.
        setSystemTime(new Date(t0 + WINDOW_MS));
        await callerFor(b!).event.checkIn({ code: shown });

        // Window N+2: too old.
        setSystemTime(new Date(t0 + 2 * WINDOW_MS));
        const stale = await errorOf(
          callerFor(c!).event.checkIn({ code: shown }),
        );
        expect(stale.code).toBe("NOT_FOUND");
        expect(stale.message).toContain("expired");
        // peek hides the event behind a stale code too.
        expect(await callerFor(c!).event.peek({ code: shown })).toBeNull();
        // The code for now is fine.
        await callerFor(c!).event.checkIn({ code: liveCode(event) });
      },
      SLOW,
    );

    it(
      "refuses the old static code and another event's code",
      async () => {
        const event = await openEvent("static");
        const other = await openEvent("other");
        const caller = callerFor(people[3]!);

        const bare = await errorOf(
          caller.event.checkIn({ code: event.checkInCode }),
        );
        expect(bare.code).toBe("NOT_FOUND");
        expect(await caller.event.peek({ code: event.checkInCode })).toBeNull();

        // Right key, the MAC of a different event.
        const crossed =
          event.checkInCode + liveCode(other).slice(event.checkInCode.length);
        expect(
          (await errorOf(caller.event.checkIn({ code: crossed }))).code,
        ).toBe("NOT_FOUND");
        // A guess at the MAC.
        expect(
          (
            await errorOf(
              caller.event.checkIn({ code: event.checkInCode + "22222222" }),
            )
          ).code,
        ).toBe("NOT_FOUND");
        const peeked = await caller.event.peek({ code: liveCode(event) });
        expect(peeked?.title).toBe(event.title);
        // Typed with spaces and dashes, in lower case, the code still reads.
        const live = liveCode(event);
        expect(
          (
            await caller.event.peek({
              code: `${live.slice(0, 4)}-${live.slice(4, 8)} ${live.slice(8, 12)}-${live.slice(12)}`.toLowerCase(),
            })
          )?.title,
        ).toBe(event.title);
      },
      SLOW,
    );

    it(
      "serves the officer screen the same code the door accepts, and officers only",
      async () => {
        const event = await openEvent("present");
        const shown = await callerFor(admin).event.presentCode({
          id: event.id,
        });
        expect(shown.code).toBe(liveCode(event, shown.serverNow));
        expect(shown.windowEndsAt).toBeGreaterThan(shown.serverNow);
        expect(shown.windowEndsAt - shown.serverNow).toBeLessThanOrEqual(
          WINDOW_MS,
        );
        await callerFor(people[5]!).event.checkIn({ code: shown.code });

        const denied = await errorOf(
          callerFor(people[0]!).event.presentCode({ id: event.id }),
        );
        expect(denied.code).toBe("FORBIDDEN");
        const missing = await errorOf(
          callerFor(admin).event.presentCode({ id: "nope" }),
        );
        expect(missing.code).toBe("NOT_FOUND");
      },
      SLOW,
    );

    it(
      "revoking kills every code issued so far at once and writes an audit row",
      async () => {
        const event = await openEvent("revoke");
        const before = liveCode(event);
        await callerFor(admin).event.regenerateCode({ id: event.id });
        const bad = await errorOf(
          callerFor(people[0]!).event.checkIn({ code: before }),
        );
        expect(bad.code).toBe("NOT_FOUND");
        const [fresh] = await db
          .select()
          .from(events)
          .where(eq(events.id, event.id));
        await callerFor(people[0]!).event.checkIn({ code: liveCode(fresh!) });
        expect(await auditFor("event.revoke_codes", event.id)).toHaveLength(1);
      },
      SLOW,
    );

    it(
      "audits opening and closing check-in",
      async () => {
        const event = await openEvent("toggle");
        await callerFor(admin).event.setCheckInEnabled({
          id: event.id,
          enabled: false,
        });
        const rows = await auditFor("event.set_check_in", event.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.after).toEqual({ checkInEnabled: false });
      },
      SLOW,
    );
  });
});
