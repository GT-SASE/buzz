import { afterAll, describe, expect, it, mock } from "bun:test";

// Same stubs as tests/auth-session.test.ts: next-auth needs `next/server`.
mock.module("../packages/auth/node_modules/next-auth/index.js", () => ({}));
mock.module(
  "../packages/auth/node_modules/next-auth/providers/google.js",
  () => ({
    default: () => ({}),
  }),
);

const { authConfig } = await import("../packages/auth/src/config");
const { db, users } = await import("../packages/db/src/index");
const { eq } = await import("../packages/db/node_modules/drizzle-orm/index.js");

const adapter = authConfig.adapter as Required<typeof authConfig.adapter>;

/**
 * `@auth/drizzle-adapter` is built against drizzle 0.x. This runs every method
 * the sign-in flow uses through our real tables, so a drizzle bump that breaks
 * the adapter fails here instead of at the first login.
 */
describe.skipIf(!process.env.DATABASE_URL)("auth adapter", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const email = `adapter-${suffix}@vitest.local`;
  const created: string[] = [];

  afterAll(async () => {
    for (const id of created) await db.delete(users).where(eq(users.id, id));
  });

  it("creates, links, signs in, and signs out a user", async () => {
    const user = await adapter.createUser({
      email,
      emailVerified: null,
      name: "Adapter Test",
    } as never);
    created.push(user.id);
    expect(user.email).toBe(email);
    expect(user.role).toBe("MEMBER");

    expect((await adapter.getUser(user.id))?.email).toBe(email);
    expect((await adapter.getUserByEmail(email))?.id).toBe(user.id);

    const account = {
      userId: user.id,
      type: "oauth" as const,
      provider: "google",
      providerAccountId: `google-${suffix}`,
    };
    await adapter.linkAccount(account);
    expect((await adapter.getUserByAccount(account))?.id).toBe(user.id);

    const expires = new Date(Date.now() + 86_400_000);
    const sessionToken = `session-${suffix}`;
    await adapter.createSession({ sessionToken, userId: user.id, expires });

    const found = await adapter.getSessionAndUser(sessionToken);
    expect(found?.user.id).toBe(user.id);
    expect(found?.user.role).toBe("MEMBER");
    expect(found?.session.expires).toBeInstanceOf(Date);
    expect(found?.session.expires.getTime()).toBe(expires.getTime());

    const later = new Date(expires.getTime() + 3_600_000);
    const renewed = await adapter.updateSession({
      sessionToken,
      expires: later,
    });
    expect(renewed?.expires.getTime()).toBe(later.getTime());

    await adapter.deleteSession(sessionToken);
    expect(await adapter.getSessionAndUser(sessionToken)).toBeNull();

    const renamed = await adapter.updateUser({ id: user.id, name: "Renamed" });
    expect(renamed.name).toBe("Renamed");

    await adapter.unlinkAccount(account);
    expect(await adapter.getUserByAccount(account)).toBeNull();
  });

  it("hands a verification token out once", async () => {
    const identifier = `token-${suffix}@vitest.local`;
    const token = `token-${suffix}`;
    const expires = new Date(Date.now() + 600_000);
    await adapter.createVerificationToken({ identifier, token, expires });

    const used = await adapter.useVerificationToken({ identifier, token });
    expect(used?.expires).toBeInstanceOf(Date);
    expect(used?.expires.getTime()).toBe(expires.getTime());
    expect(
      await adapter.useVerificationToken({ identifier, token }),
    ).toBeNull();
  });
});
