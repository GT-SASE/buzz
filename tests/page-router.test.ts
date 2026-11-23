import { describe, expect, it, mock } from "bun:test";

mock.module("../packages/auth/src/index.ts", () => ({
  auth: () => Promise.resolve(null),
  handlers: {},
  signIn: () => Promise.resolve(undefined),
  signOut: () => Promise.resolve(undefined),
}));

const { createCaller } = await import("../packages/api/src/root");

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
  slug: "spring-kickoff",
  title: "Spring kickoff",
  description: "",
  body: "Hello",
};

describe("page router authz", () => {
  const member = createCaller(ctxFor("MEMBER", unreachableDb));

  it.each([
    ["list", () => member.page.list()],
    ["byId", () => member.page.byId({ id: "p1" })],
    ["create", () => member.page.create(input)],
    ["saveDraft", () => member.page.saveDraft({ id: "p1", ...input })],
    ["publish", () => member.page.publish({ id: "p1" })],
    ["unpublish", () => member.page.unpublish({ id: "p1" })],
    ["restore", () => member.page.restore({ id: "p1", number: 1 })],
    ["versions", () => member.page.versions({ id: "p1" })],
    ["delete", () => member.page.delete({ id: "p1" })],
  ])("refuses a MEMBER on %s before reading", async (_name, call) => {
    expect((await rejection(call())).code).toBe("FORBIDDEN");
  });

  it("refuses a reserved slug before writing", async () => {
    const officer = createCaller(ctxFor("ADMIN", unreachableDb));
    const error = await rejection(
      officer.page.create({ ...input, slug: "about" }),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });
});
