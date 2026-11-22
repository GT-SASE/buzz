import { describe, expect, it, mock } from "bun:test";

import {
  HREF_MAX,
  LABEL_MAX,
  MESSAGE_MAX,
} from "../sites/web/src/app/portal/(member)/admin/announcement/limits";

mock.module("../packages/auth/src/index.ts", () => ({
  auth: () => Promise.resolve(null),
  handlers: {},
  signIn: () => Promise.resolve(undefined),
  signOut: () => Promise.resolve(undefined),
}));

const { createCaller } = await import("../packages/api/src/root");
const {
  ANNOUNCEMENT_HREF_MAX,
  ANNOUNCEMENT_LABEL_MAX,
  ANNOUNCEMENT_MESSAGE_MAX,
  announcementHrefProblem,
} = await import("../packages/api/src/routers/announcement");
const { ANNOUNCEMENT_SLUG, isValidPageSlug } =
  await import("../packages/api/src/page-slug");

type Ctx = Parameters<typeof createCaller>[0];

function ctxFor(role: "MEMBER" | "ADMIN", db: unknown): Ctx {
  return {
    db,
    session: {
      user: { id: "user-1", role, email: "user@gatech.edu" },
      expires: "2099-01-01T00:00:00.000Z",
    },
    headers: new Headers(),
  } as unknown as Ctx;
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error("expected the procedure to reject, but it resolved");
}

const unreachableDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `db.${String(property)} was reached; the caller should have been refused first`,
      );
    },
  },
);

const input = {
  enabled: true,
  message: "Spring kickoff is Thursday.",
  linkLabel: "See the calendar",
  linkHref: "/events",
};

/** Records the upsert the router sends and answers with a saved row. */
function upsertDb() {
  const writes: { values?: Record<string, unknown>; set?: unknown } = {};
  const updatedAt = new Date("2026-11-20T12:00:00Z");
  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        writes.values = values;
        return {
          onConflictDoUpdate: (config: { set: unknown }) => {
            writes.set = config.set;
            return { returning: () => Promise.resolve([{ updatedAt }]) };
          },
        };
      },
    }),
  };
  return { db, writes, updatedAt };
}

describe("announcement router authz", () => {
  const member = createCaller(ctxFor("MEMBER", unreachableDb));

  it.each([
    ["get", () => member.announcement.get()],
    ["set", () => member.announcement.set(input)],
  ])("refuses a MEMBER on %s before reading", async (_name, call) => {
    expect((await rejection(call())).code).toBe("FORBIDDEN");
  });
});

describe("announcement.set", () => {
  it("stores the banner in the page row under the reserved slug", async () => {
    const { db, writes, updatedAt } = upsertDb();
    const result = await createCaller(ctxFor("ADMIN", db)).announcement.set({
      ...input,
      message: "  Spring kickoff is Thursday.  ",
    });

    expect(result).toEqual({ updatedAt });
    expect(writes.values).toMatchObject({
      slug: ANNOUNCEMENT_SLUG,
      title: "Spring kickoff is Thursday.",
      description: "See the calendar",
      body: "/events",
      published: true,
      createdById: "user-1",
    });
    // The update half of the upsert moves updatedAt, which is the version.
    expect(writes.set).toMatchObject({
      title: "Spring kickoff is Thursday.",
      published: true,
    });
    expect((writes.set as { updatedAt: unknown }).updatedAt).toBeInstanceOf(
      Date,
    );
  });

  it("saves a switched-off banner and one without a link", async () => {
    const { db, writes } = upsertDb();
    await createCaller(ctxFor("ADMIN", db)).announcement.set({
      enabled: false,
      message: "Back in August.",
      linkLabel: "",
      linkHref: "",
    });

    expect(writes.values).toMatchObject({
      published: false,
      description: "",
      body: "",
    });
  });

  it.each([
    ["an empty message", { message: "   " }],
    ["a message over the limit", { message: "x".repeat(MESSAGE_MAX + 1) }],
    ["a label without an address", { linkHref: "" }],
    ["an address without a label", { linkLabel: "" }],
    ["a label over the limit", { linkLabel: "x".repeat(LABEL_MAX + 1) }],
    ["a javascript: address", { linkHref: "javascript:alert(1)" }],
    ["a protocol-relative address", { linkHref: "//evil.example/x" }],
    ["a plain http address", { linkHref: "http://example.com" }],
    ["an address with a space", { linkHref: "/events now" }],
    ["a malformed https address", { linkHref: "https://" }],
  ])("refuses %s before writing", async (_name, patch) => {
    const error = await rejection(
      createCaller(ctxFor("ADMIN", unreachableDb)).announcement.set({
        ...input,
        ...patch,
      }),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });
});

describe("announcement.get", () => {
  it("reads the row back as the form's fields", async () => {
    const updatedAt = new Date("2026-11-20T12:00:00Z");
    const db = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              {
                title: "Spring kickoff is Thursday.",
                description: "See the calendar",
                body: "/events",
                published: true,
                updatedAt,
              },
            ]),
        }),
      }),
    };

    expect(await createCaller(ctxFor("ADMIN", db)).announcement.get()).toEqual({
      enabled: true,
      message: "Spring kickoff is Thursday.",
      linkLabel: "See the calendar",
      linkHref: "/events",
      updatedAt,
    });
  });

  it("answers an off, empty banner before one is ever saved", async () => {
    const db = {
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    };

    expect(await createCaller(ctxFor("ADMIN", db)).announcement.get()).toEqual({
      enabled: false,
      message: "",
      linkLabel: "",
      linkHref: "",
      updatedAt: null,
    });
  });
});

describe("announcementHrefProblem", () => {
  it.each(["", "/", "/events", "/events#past", "https://example.com/a?b=1"])(
    "accepts %j",
    (href) => {
      expect(announcementHrefProblem(href)).toBeNull();
    },
  );
});

describe("the reserved slug and the form", () => {
  it("is not a slug an officer can give a page", () => {
    expect(isValidPageSlug(ANNOUNCEMENT_SLUG)).toBe(false);
  });

  it("uses the limits the router enforces", () => {
    expect({ MESSAGE_MAX, LABEL_MAX, HREF_MAX }).toEqual({
      MESSAGE_MAX: ANNOUNCEMENT_MESSAGE_MAX,
      LABEL_MAX: ANNOUNCEMENT_LABEL_MAX,
      HREF_MAX: ANNOUNCEMENT_HREF_MAX,
    });
  });
});
