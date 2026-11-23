import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

mock.module("../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { db, pages, users } = await import("../packages/db/src/index");
const { createCaller } = await import("../packages/api/src/root");
const { eq, like } = await import("drizzle-orm");

function callerFor(id: string, role: "MEMBER" | "ADMIN") {
  return createCaller({
    db,
    session: {
      user: { id, role, email: `${id}@vitest.local`, name: id },
      expires: new Date(Date.now() + 86_400_000).toISOString(),
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

describe.skipIf(!process.env.DATABASE_URL)("pages", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const officerId = `pg-officer-${suffix}`;
  const prefix = `vitest-${suffix}`;
  const officer = () => callerFor(officerId, "ADMIN");

  const fields = (slug: string) => ({
    slug,
    title: "Vitest page",
    description: "A page",
    body: "# Hello",
    published: false,
  });

  beforeAll(async () => {
    await db.insert(users).values({
      id: officerId,
      email: `${officerId}@vitest.local`,
      role: "ADMIN",
    });
  });

  afterAll(async () => {
    await db.delete(pages).where(like(pages.slug, `${prefix}%`));
    await db.delete(users).where(eq(users.id, officerId));
  });

  it("creates, reads, updates, lists, and deletes a page", async () => {
    const created = await officer().page.create(fields(`${prefix}-a`));
    expect(created.createdById).toBe(officerId);
    expect(created.published).toBe(false);

    const read = await officer().page.byId({ id: created.id });
    expect(read.body).toBe("# Hello");

    const { page, previousSlug } = await officer().page.update({
      id: created.id,
      ...fields(`${prefix}-b`),
      title: "Renamed",
      published: true,
    });
    expect(previousSlug).toBe(`${prefix}-a`);
    expect(page.slug).toBe(`${prefix}-b`);
    expect(page.published).toBe(true);
    expect(page.updatedAt.getTime()).toBeGreaterThanOrEqual(
      created.updatedAt.getTime(),
    );

    const listed = await officer().page.list();
    expect(listed.find((row) => row.id === created.id)?.title).toBe("Renamed");

    await officer().page.delete({ id: created.id });
    expect(await errorCode(officer().page.byId({ id: created.id }))).toBe(
      "NOT_FOUND",
    );
    expect(await errorCode(officer().page.delete({ id: created.id }))).toBe(
      "NOT_FOUND",
    );
  });

  it("answers a duplicate slug with CONFLICT on create and update", async () => {
    const first = await officer().page.create(fields(`${prefix}-dup1`));
    const second = await officer().page.create(fields(`${prefix}-dup2`));

    expect(await errorCode(officer().page.create(fields(first.slug)))).toBe(
      "CONFLICT",
    );
    expect(
      await errorCode(
        officer().page.update({ id: second.id, ...fields(first.slug) }),
      ),
    ).toBe("CONFLICT");
  });

  it("keeps members out", async () => {
    expect(await errorCode(callerFor(officerId, "MEMBER").page.list())).toBe(
      "FORBIDDEN",
    );
  });
});
