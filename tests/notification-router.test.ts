import { beforeEach, describe, expect, it, mock } from "bun:test";
import { stubEnv, unstubAllEnvs } from "./helpers/env";
import { resetRateLimits, withMemoryLimiter } from "./helpers/rate-limit";

mock.module("../packages/auth/src/index.ts", () => ({
  auth: () => Promise.resolve(null),
  handlers: {},
  signIn: () => Promise.resolve(undefined),
  signOut: () => Promise.resolve(undefined),
}));

stubEnv("NODE_ENV", "production");
const { createCaller } = await import("../packages/api/src/root");
unstubAllEnvs();

type Ctx = Parameters<typeof createCaller>[0];

function ctxFor(db: unknown, session: unknown): Ctx {
  return {
    db: withMemoryLimiter(db),
    session,
    headers: new Headers(),
  } as unknown as Ctx;
}

const member = {
  user: { id: "member-1", role: "MEMBER", email: "member@gatech.edu" },
  expires: "2099-01-01T00:00:00.000Z",
};

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string };
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

beforeEach(() => resetRateLimits());

describe("notification router", () => {
  it("refuses a signed-out caller before reading or writing", async () => {
    const caller = createCaller(ctxFor(unreachableDb, null));
    expect((await rejection(caller.notification.mine())).code).toBe(
      "UNAUTHORIZED",
    );
    expect(
      (
        await rejection(
          caller.notification.save({
            eventEmails: false,
            electionEmails: true,
          }),
        )
      ).code,
    ).toBe("UNAUTHORIZED");
  });

  it("reports every switch on for a member who never saved a choice", async () => {
    const db = {
      query: {
        notificationPreferences: {
          findFirst: () => Promise.resolve(undefined),
        },
      },
    };
    expect(await createCaller(ctxFor(db, member)).notification.mine()).toEqual({
      eventEmails: true,
      electionEmails: true,
    });
  });

  it("reports every switch on while the table does not exist yet", async () => {
    const db = {
      query: {
        notificationPreferences: {
          findFirst: () =>
            Promise.reject(
              Object.assign(new Error("no table"), { code: "42P01" }),
            ),
        },
      },
    };
    expect(await createCaller(ctxFor(db, member)).notification.mine()).toEqual({
      eventEmails: true,
      electionEmails: true,
    });
  });

  it("lets any other read failure through", async () => {
    const db = {
      query: {
        notificationPreferences: {
          findFirst: () => Promise.reject(new Error("connection reset")),
        },
      },
    };
    const error = await rejection(
      createCaller(ctxFor(db, member)).notification.mine(),
    );
    expect(error.code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("saves the caller's own row, whatever else the body names", async () => {
    const written: Record<string, unknown>[] = [];
    const db = {
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          written.push(values);
          return { onConflictDoUpdate: () => Promise.resolve() };
        },
      }),
    };

    const saved = await createCaller(ctxFor(db, member)).notification.save({
      eventEmails: false,
      electionEmails: true,
      userId: "someone-else",
    } as { eventEmails: boolean; electionEmails: boolean });

    expect(saved).toEqual({ eventEmails: false, electionEmails: true });
    expect(written[0]).toMatchObject({
      userId: "member-1",
      eventEmails: false,
      electionEmails: true,
    });
  });

  it("rejects a body that is not two booleans", async () => {
    const caller = createCaller(ctxFor(unreachableDb, member));
    const error = await rejection(
      caller.notification.save({
        eventEmails: "no",
        electionEmails: true,
      } as unknown as { eventEmails: boolean; electionEmails: boolean }),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });
});
