import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../packages/auth/src/index.ts", () => ({
  auth: () => Promise.resolve(null),
  handlers: {},
  signIn: () => Promise.resolve(undefined),
  signOut: () => Promise.resolve(undefined),
}));

const sendMail = vi.fn(() => Promise.resolve());

vi.mock("../packages/api/src/mail.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../packages/api/src/mail")>(
      "../packages/api/src/mail.ts",
    );
  return {
    ...actual,
    mailConfig: () => ({
      apiKey: "re_test",
      from: "SASE GT <onboarding@resend.dev>",
    }),
    sendMail: (...args: unknown[]) => sendMail(...args),
  };
});

vi.stubEnv("NODE_ENV", "production");
const { createCaller } = await import("../packages/api/src/root");
const { resetRateLimits } = await import("../packages/api/src/rate-limit");
const { MAIL_TEST_TO } = await import("../packages/api/src/mail");
vi.unstubAllEnvs();

type Ctx = Parameters<typeof createCaller>[0];

function memberCtx(db: unknown): Ctx {
  return {
    db,
    session: {
      user: { id: "member-1", role: "MEMBER", email: "member@gatech.edu" },
      expires: "2099-01-01T00:00:00.000Z",
    },
    headers: new Headers(),
  } as unknown as Ctx;
}

function adminCtx(db: unknown): Ctx {
  return {
    db,
    session: {
      user: { id: "officer-1", role: "ADMIN", email: "officer@gatech.edu" },
      expires: "2099-01-01T00:00:00.000Z",
    },
    headers: new Headers(),
  } as unknown as Ctx;
}

async function rejection(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string }> {
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

beforeEach(() => {
  resetRateLimits();
  sendMail.mockClear();
});

describe("mail.sendTest", () => {
  it("refuses a MEMBER session before sending", async () => {
    const error = await rejection(
      createCaller(memberCtx(unreachableDb)).mail.sendTest(),
    );
    expect(error.code).toBe("FORBIDDEN");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("sends only to the pinned test inbox", async () => {
    const result = await createCaller(adminCtx({})).mail.sendTest();
    expect(result.to).toBe(MAIL_TEST_TO);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0]?.[0]).toMatchObject({ to: MAIL_TEST_TO });
  });
});
