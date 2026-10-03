import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Same harness as check-in.integration.test.ts: stub next-auth, import by path.
vi.mock("../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

/** Captures what would be emailed instead of talking to Gmail. */
const sent = vi.hoisted(
  () => [] as { to: string; method: string; content: string }[],
);
vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: async (message: {
        to: string;
        icalEvent: { method: string; content: string };
      }) => {
        sent.push({
          to: message.to,
          method: message.icalEvent.method,
          content: message.icalEvent.content,
        });
      },
    }),
  },
}));

const { db, eventRsvps, events, users } =
  await import("../packages/db/src/index");
const { createCaller } = await import("../packages/api/src/root");
const { inArray } =
  await import("../packages/db/node_modules/drizzle-orm/index.js");

const SLOW = 30_000;
const HOUR_MS = 60 * 60 * 1000;
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

function randomCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % 30]).join("");
}

type TestUser = { id: string; email: string; role: "MEMBER" | "ADMIN" };

function callerFor(user: TestUser | null) {
  return createCaller({
    db,
    session: user && {
      user: { id: user.id, role: user.role, email: user.email, name: "vitest" },
      expires: new Date(Date.now() + 24 * HOUR_MS).toISOString(),
    },
    headers: new Headers(),
  });
}

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
    return "NO_ERROR";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

describe.skipIf(!process.env.DATABASE_URL)("event RSVP", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const eventIds: string[] = [];
  let admin: TestUser;
  let member: TestUser;
  const id = { future: "", started: "", archived: "" };

  async function makeUser(tag: string, role: "MEMBER" | "ADMIN") {
    const [row] = await db
      .insert(users)
      .values({
        email: `vitest-rsvp-${tag}-${suffix}@example.invalid`,
        name: `vitest ${tag}`,
        role,
      })
      .returning();
    if (!row) throw new Error(`could not create the ${tag} test user`);
    userIds.push(row.id);
    return { id: row.id, email: row.email, role } satisfies TestUser;
  }

  beforeAll(async () => {
    admin = await makeUser("officer", "ADMIN");
    member = await makeUser("member", "MEMBER");
    const now = Date.now();
    const rows = await db
      .insert(events)
      .values([
        {
          title: "vitest rsvp future",
          startsAt: new Date(now + 48 * HOUR_MS),
          checkInCode: randomCode(),
          createdById: admin.id,
        },
        {
          title: "vitest rsvp started",
          startsAt: new Date(now - HOUR_MS),
          checkInCode: randomCode(),
          createdById: admin.id,
        },
        {
          title: "vitest rsvp archived",
          startsAt: new Date(now + 48 * HOUR_MS),
          checkInCode: randomCode(),
          archivedAt: new Date(now),
          createdById: admin.id,
        },
      ])
      .returning({ id: events.id, title: events.title });
    for (const row of rows) {
      eventIds.push(row.id);
      if (row.title.endsWith("future")) id.future = row.id;
      if (row.title.endsWith("started")) id.started = row.id;
      if (row.title.endsWith("archived")) id.archived = row.id;
    }
  }, SLOW);

  afterAll(async () => {
    if (eventIds.length > 0) {
      await db.delete(eventRsvps).where(inArray(eventRsvps.eventId, eventIds));
      await db.delete(events).where(inArray(events.id, eventIds));
    }
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  }, SLOW);

  it("records an RSVP once, shows it to the member and the officer, and cancels it", async () => {
    const caller = callerFor(member);
    await caller.event.rsvp({ eventId: id.future });
    await caller.event.rsvp({ eventId: id.future });

    const upcoming = await caller.event.upcoming();
    expect(
      upcoming.find((row) => row.id === id.future)?.rsvpedAt,
    ).toBeInstanceOf(Date);
    const home = await caller.event.home();
    expect(
      home.upcoming.find((row) => row.id === id.future)?.rsvpedAt,
    ).toBeInstanceOf(Date);

    const detail = await callerFor(admin).event.getById({ id: id.future });
    expect(detail.rsvps.map((row) => row.userId)).toEqual([member.id]);

    await caller.event.cancelRsvp({ eventId: id.future });
    const after = await caller.event.upcoming();
    expect(after.find((row) => row.id === id.future)?.rsvpedAt).toBeNull();
  });

  describe("calendar emails", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("sends an invite on RSVP and a cancellation for the same entry on cancel, once each", async () => {
      vi.stubEnv("GMAIL_USER", "chapter@example.com");
      vi.stubEnv("GMAIL_APP_PASSWORD", "app-password");
      sent.length = 0;
      const caller = callerFor(member);

      expect((await caller.event.rsvp({ eventId: id.future })).invited).toBe(
        true,
      );
      await caller.event.rsvp({ eventId: id.future });
      expect(
        (await caller.event.cancelRsvp({ eventId: id.future })).uninvited,
      ).toBe(true);
      await caller.event.cancelRsvp({ eventId: id.future });

      expect(sent.map((mail) => mail.method)).toEqual(["REQUEST", "CANCEL"]);
      expect(sent.every((mail) => mail.to === member.email)).toBe(true);
      const uid = (content: string) => /UID:(.*)/.exec(content)?.[1];
      expect(uid(sent[1]!.content)).toBe(uid(sent[0]!.content));
      expect(sent[0]!.content).toContain("SUMMARY:vitest rsvp future");
    });

    it("still saves the RSVP when Gmail is not configured", async () => {
      vi.stubEnv("GMAIL_USER", "");
      vi.stubEnv("GMAIL_APP_PASSWORD", "");
      sent.length = 0;
      const caller = callerFor(member);
      const result = await caller.event.rsvp({ eventId: id.future });
      expect(result).toMatchObject({ rsvped: true, invited: false });
      expect(sent).toHaveLength(0);
      await caller.event.cancelRsvp({ eventId: id.future });
    });
  });

  it("refuses events that have started or are archived, and signed-out callers", async () => {
    const caller = callerFor(member);
    const upcoming = await caller.event.upcoming();
    expect(upcoming.find((row) => row.id === id.future)?.rsvpOpen).toBe(true);
    expect(upcoming.find((row) => row.id === id.started)?.rsvpOpen).toBe(false);
    expect(await errorCode(caller.event.rsvp({ eventId: id.started }))).toBe(
      "BAD_REQUEST",
    );
    expect(await errorCode(caller.event.rsvp({ eventId: id.archived }))).toBe(
      "NOT_FOUND",
    );
    expect(
      await errorCode(callerFor(null).event.rsvp({ eventId: id.future })),
    ).toBe("UNAUTHORIZED");
  });

  it("never returns another member's RSVP list to a member", async () => {
    expect(
      await errorCode(callerFor(member).event.getById({ id: id.future })),
    ).toBe("FORBIDDEN");
  });
});
