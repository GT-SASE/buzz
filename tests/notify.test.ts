import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  vi,
} from "bun:test";
import { stubEnv, unstubAllEnvs } from "./helpers/env";
import { FAKE_WEBHOOK } from "./helpers/webhook";

type Message = {
  to: string;
  subject: string;
  text: string;
  icalEvent?: { method: string; content: string };
};

/** What the fake transport was handed, and how many sends overlapped. */
const sent: Message[] = [];
const rejected = new Set<string>();
let inFlight = 0;
let mostInFlight = 0;

mock.module("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: async (message: Message) => {
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        if (rejected.has(message.to))
          throw new Error("550 mailbox unavailable");
        sent.push(message);
      },
    }),
  },
}));

const {
  announcesElectionPhase,
  noNotice,
  notifyApplicationDecision,
  notifyElectionPhase,
  notifyEventChange,
  optedOutOf,
  postToChannel,
  SEND_BATCH,
} = await import("../packages/api/src/notify");

type Database = Parameters<typeof notifyEventChange>[0];

/** The one query `optedOutOf` makes: select().from().where() -> rows. */
function dbWith(result: { id: string }[] | Error) {
  const chain = {
    from: () => chain,
    where: () =>
      result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result),
  };
  return { select: () => chain } as unknown as Database;
}

const noOptOuts = dbWith([]);

const event = {
  id: "evt-1",
  title: "Fall GBM",
  startsAt: new Date("2026-10-20T22:00:00.000Z"),
  location: "Van Leer C456",
  description: null,
};

function members(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    email: `m${i}@example.com`,
  }));
}

const WEBHOOK = FAKE_WEBHOOK;
let posts: { url: string; body: Record<string, unknown> }[] = [];
const realFetch = globalThis.fetch;
let errors = vi.spyOn(console, "error");

function stubFetch(respond: () => Response | Promise<Response>) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    posts.push({
      url,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
    });
    return respond();
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  sent.length = 0;
  rejected.clear();
  posts = [];
  inFlight = 0;
  mostInFlight = 0;
  stubEnv("GMAIL_USER", "chapter@example.com");
  stubEnv("GMAIL_APP_PASSWORD", "app-password");
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("notifyApplicationDecision", () => {
  const applicant = { email: "ada@example.com", name: "Ada Lovelace" };

  it("emails an acceptance to the applicant by first name", async () => {
    const notice = await notifyApplicationDecision(
      applicant,
      "accepted",
      "fall-2026",
    );

    expect(notice).toEqual({ ...noNotice, sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("ada@example.com");
    expect(sent[0]!.subject).toContain("accepted");
    expect(sent[0]!.text).toStartWith("Hi Ada,");
    expect(sent[0]!.text).toContain("Fall 2026");
  });

  it("emails a decline without the word accepted", async () => {
    await notifyApplicationDecision(applicant, "declined", "spring-2027");

    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).not.toContain("accepted");
    expect(sent[0]!.text).toContain("Spring 2027");
    expect(sent[0]!.text).toContain("not able to offer you a place");
  });

  it("falls back to a plain greeting without a name", async () => {
    await notifyApplicationDecision(
      { email: "x@example.com", name: null },
      "accepted",
      "fall-2026",
    );
    expect(sent[0]!.text).toStartWith("Hi there,");
  });

  it.each(["submitted", "interviewing", "withdrawn"])(
    "says nothing for %s, which is not a decision",
    async (status) => {
      expect(
        await notifyApplicationDecision(applicant, status, "fall-2026"),
      ).toEqual(noNotice);
      expect(sent).toHaveLength(0);
    },
  );

  it("counts a failed send, logs it, and does not throw", async () => {
    rejected.add("ada@example.com");
    const notice = await notifyApplicationDecision(
      applicant,
      "accepted",
      "fall-2026",
    );

    expect(notice).toEqual({ ...noNotice, failed: 1 });
    expect(errors).toHaveBeenCalled();
  });

  it("counts an unconfigured mailer as not sent", async () => {
    stubEnv("GMAIL_USER", "");
    const notice = await notifyApplicationDecision(
      applicant,
      "declined",
      "fall-2026",
    );

    expect(notice).toEqual({ ...noNotice, failed: 1 });
    expect(sent).toHaveLength(0);
  });
});

describe("notifyEventChange", () => {
  it("re-sends the calendar entry as an update to each RSVP", async () => {
    const notice = await notifyEventChange(
      noOptOuts,
      event,
      "moved",
      async () => members(2),
    );

    expect(notice).toEqual({ ...noNotice, sent: 2 });
    expect(sent.map((mail) => mail.icalEvent?.method)).toEqual([
      "REQUEST",
      "REQUEST",
    ]);
    expect(sent[0]!.subject).toBe("Updated: Fall GBM");
  });

  it("takes the entry off the calendar on a cancellation", async () => {
    await notifyEventChange(noOptOuts, event, "cancelled", async () =>
      members(1),
    );

    expect(sent[0]!.icalEvent?.method).toBe("CANCEL");
    expect(sent[0]!.subject).toBe("Cancelled: Fall GBM");
    // The event is cancelled, not the member's RSVP.
    expect(sent[0]!.text).toBe(
      "Fall GBM is cancelled. It is off your calendar.",
    );
  });

  it("puts the entry back on a restore", async () => {
    await notifyEventChange(noOptOuts, event, "restored", async () =>
      members(1),
    );
    expect(sent[0]!.icalEvent?.method).toBe("REQUEST");
    // Not "updated": nothing about the time or place changed.
    expect(sent[0]!.subject).toBe("Back on: Fall GBM");
    expect(sent[0]!.text).toContain("is back on");
    expect(sent[0]!.text).not.toContain("time or place");
  });

  it("skips members who switched event emails off, and says how many", async () => {
    const notice = await notifyEventChange(
      dbWith([{ id: "m1" }]),
      event,
      "moved",
      async () => members(3),
    );

    expect(notice).toEqual({ ...noNotice, sent: 2, skipped: 1 });
    expect(sent.map((mail) => mail.to).sort()).toEqual([
      "m0@example.com",
      "m2@example.com",
    ]);
  });

  it("sends in batches rather than all at once", async () => {
    const notice = await notifyEventChange(
      noOptOuts,
      event,
      "moved",
      async () => members(SEND_BATCH * 3 + 1),
    );

    expect(notice.sent).toBe(SEND_BATCH * 3 + 1);
    expect(mostInFlight).toBe(SEND_BATCH);
  });

  it("counts a bounced address and keeps sending to the rest", async () => {
    rejected.add("m1@example.com");
    const notice = await notifyEventChange(
      noOptOuts,
      event,
      "moved",
      async () => members(3),
    );

    expect(notice).toEqual({ ...noNotice, sent: 2, failed: 1 });
  });

  it("reports a failed lookup as one failure instead of throwing", async () => {
    const notice = await notifyEventChange(
      noOptOuts,
      event,
      "moved",
      async () => {
        throw new Error("connection reset");
      },
    );

    expect(notice).toEqual({ ...noNotice, failed: 1 });
    expect(sent).toHaveLength(0);
  });

  it("reports a failed opt-out lookup as one failure too", async () => {
    const notice = await notifyEventChange(
      dbWith(new Error("connection reset")),
      event,
      "moved",
      async () => members(2),
    );

    expect(notice).toEqual({ ...noNotice, failed: 1 });
    expect(sent).toHaveLength(0);
  });

  it("treats a deployment without the preferences table as nobody opted out", async () => {
    const missing = Object.assign(new Error("relation does not exist"), {
      code: "42P01",
    });
    const notice = await notifyEventChange(
      dbWith(missing),
      event,
      "moved",
      async () => members(2),
    );

    expect(notice).toEqual({ ...noNotice, sent: 2 });
  });

  describe("the Discord channel", () => {
    it("posts nothing, and never calls fetch, without a webhook", async () => {
      stubFetch(() => new Response(null, { status: 204 }));
      const notice = await notifyEventChange(
        noOptOuts,
        event,
        "moved",
        async () => [],
      );

      expect(notice.channel).toBe("off");
      expect(posts).toHaveLength(0);
    });

    it("posts the change even when nobody RSVPed", async () => {
      stubEnv("NOTIFY_DISCORD_WEBHOOK_URL", WEBHOOK);
      stubFetch(() => new Response(null, { status: 204 }));
      const notice = await notifyEventChange(
        noOptOuts,
        event,
        "moved",
        async () => [],
      );

      expect(notice.channel).toBe("posted");
      expect(posts).toHaveLength(1);
      expect(posts[0]!.url).toBe(WEBHOOK);
      expect(posts[0]!.body.content).toContain("Fall GBM");
      expect(posts[0]!.body.content).toContain("Van Leer C456");
      expect(posts[0]!.body.content).toContain("EDT");
    });

    it("cannot be used to ping anyone", async () => {
      stubEnv("NOTIFY_DISCORD_WEBHOOK_URL", WEBHOOK);
      stubFetch(() => new Response(null, { status: 204 }));
      await notifyEventChange(
        noOptOuts,
        { ...event, title: "@everyone free boba" },
        "cancelled",
        async () => [],
      );

      expect(posts[0]!.body.allowed_mentions).toEqual({ parse: [] });
    });

    it("reports a refused post and never logs the webhook URL", async () => {
      stubEnv("NOTIFY_DISCORD_WEBHOOK_URL", WEBHOOK);
      stubFetch(() => new Response("nope", { status: 404 }));
      const notice = await notifyEventChange(
        noOptOuts,
        event,
        "moved",
        async () => members(1),
      );

      expect(notice).toEqual({ ...noNotice, sent: 1, channel: "failed" });
      const logged = JSON.stringify(errors.mock.calls);
      expect(logged).toContain("404");
      expect(logged).not.toContain("secret-token");
    });

    it("reports a network failure without throwing or logging the URL", async () => {
      stubEnv("NOTIFY_DISCORD_WEBHOOK_URL", WEBHOOK);
      globalThis.fetch = (async () => {
        throw new Error(`connect ECONNREFUSED ${WEBHOOK}`);
      }) as unknown as typeof fetch;

      expect(await postToChannel("hello")).toBe("failed");
      expect(JSON.stringify(errors.mock.calls)).not.toContain("secret-token");
    });

    it("refuses to post to a URL that is not a Discord webhook", async () => {
      stubEnv("NOTIFY_DISCORD_WEBHOOK_URL", "https://example.com/hook");
      stubFetch(() => new Response(null, { status: 204 }));

      expect(await postToChannel("hello")).toBe("failed");
      expect(posts).toHaveLength(0);
    });

    it("stays within the Discord message length limit", async () => {
      stubEnv("NOTIFY_DISCORD_WEBHOOK_URL", WEBHOOK);
      stubFetch(() => new Response(null, { status: 204 }));

      await postToChannel("x".repeat(5000));
      expect((posts[0]!.body.content as string).length).toBe(2000);
    });
  });
});

describe("notifyElectionPhase", () => {
  const election = { title: "Board 2026" };

  it.each([
    ["nominating", "Nominations are open: Board 2026"],
    ["voting", "Voting is open: Board 2026"],
    ["published", "Results are in: Board 2026"],
  ] as const)("announces %s", async (phase, subject) => {
    const notice = await notifyElectionPhase(
      noOptOuts,
      election,
      phase,
      async () => members(2),
    );

    expect(notice).toEqual({ ...noNotice, sent: 2 });
    expect(sent.map((mail) => mail.subject)).toEqual([subject, subject]);
    expect(sent[0]!.text).toContain("/portal/elections");
  });

  it("does not announce the polls closing", async () => {
    stubEnv("NOTIFY_DISCORD_WEBHOOK_URL", WEBHOOK);
    stubFetch(() => new Response(null, { status: 204 }));
    const loadRecipients = vi.fn(async () => members(2));

    const notice = await notifyElectionPhase(
      noOptOuts,
      election,
      "closed",
      loadRecipients,
    );

    expect(notice).toEqual(noNotice);
    expect(announcesElectionPhase("closed")).toBe(false);
    expect(loadRecipients).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  it("skips members who switched election emails off", async () => {
    const notice = await notifyElectionPhase(
      dbWith([{ id: "m0" }, { id: "m1" }]),
      election,
      "voting",
      async () => members(3),
    );

    expect(notice).toEqual({ ...noNotice, sent: 1, skipped: 2 });
    expect(sent.map((mail) => mail.to)).toEqual(["m2@example.com"]);
  });

  it("posts to the channel as well as emailing", async () => {
    stubEnv("NOTIFY_DISCORD_WEBHOOK_URL", WEBHOOK);
    stubFetch(() => new Response(null, { status: 204 }));
    const notice = await notifyElectionPhase(
      noOptOuts,
      election,
      "voting",
      async () => members(1),
    );

    expect(notice).toEqual({ ...noNotice, sent: 1, channel: "posted" });
    expect(posts[0]!.body.content).toContain("Voting is open: Board 2026");
  });
});

describe("optedOutOf", () => {
  it("returns the ids that turned the category off", async () => {
    expect(
      await optedOutOf(dbWith([{ id: "a" }, { id: "b" }]), "event"),
    ).toEqual(new Set(["a", "b"]));
  });

  it("lets any other database error through", async () => {
    await expect(
      optedOutOf(dbWith(new Error("connection reset")), "election"),
    ).rejects.toThrow("connection reset");
  });
});
