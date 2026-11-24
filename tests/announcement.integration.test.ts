import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

mock.module("../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));
// The loaders are Next server modules: `server-only` throws outside the
// framework and `unstable_cache` needs its incremental cache. A passthrough
// runs the real queries.
mock.module("server-only", () => ({}));
mock.module("next/cache", () => ({
  unstable_cache: (fn: unknown) => fn,
  revalidateTag: () => undefined,
  revalidatePath: () => undefined,
}));

const { db, pages, users } = await import("../packages/db/src/index");
const { createCaller } = await import("../packages/api/src/root");
const { ANNOUNCEMENT_SLUG } = await import("../packages/api/src/page-slug");
const { getAnnouncement } = await import("../sites/web/src/data/announcement");
const { getPublishedPage, getPublishedPageList } =
  await import("../sites/web/src/data/pages");
const { eq, like } = await import("drizzle-orm");

function officer(id: string) {
  return createCaller({
    db,
    session: {
      user: { id, role: "ADMIN", email: `${id}@vitest.local`, name: id },
      expires: new Date(Date.now() + 86_400_000).toISOString(),
    },
    headers: new Headers(),
  });
}

describe.skipIf(!process.env.DATABASE_URL)("site banner", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const officerId = `banner-officer-${suffix}`;
  const prefix = `vitest-banner-${suffix}`;

  beforeAll(async () => {
    await db.insert(users).values({
      id: officerId,
      email: `${officerId}@vitest.local`,
      role: "ADMIN",
    });
  });

  afterAll(async () => {
    await db.delete(pages).where(eq(pages.slug, ANNOUNCEMENT_SLUG));
    await db.delete(pages).where(like(pages.slug, `${prefix}%`));
    await db.delete(users).where(eq(users.id, officerId));
  });

  it("is off until an officer saves one", async () => {
    await db.delete(pages).where(eq(pages.slug, ANNOUNCEMENT_SLUG));

    expect(await getAnnouncement()).toBeNull();
    expect(await officer(officerId).announcement.get()).toMatchObject({
      enabled: false,
      message: "",
      updatedAt: null,
    });
  });

  it("shows on the public site once saved, and the next save is a new version", async () => {
    const first = await officer(officerId).announcement.set({
      enabled: true,
      message: "Spring kickoff is Thursday.",
      linkLabel: "See the calendar",
      linkHref: "/events",
    });

    const live = await getAnnouncement();
    expect(live).toEqual({
      message: "Spring kickoff is Thursday.",
      link: { label: "See the calendar", href: "/events" },
      version: String(first.updatedAt.getTime()),
    });

    await Bun.sleep(5);
    const second = await officer(officerId).announcement.set({
      enabled: true,
      message: "Kickoff moved to Friday.",
      linkLabel: "",
      linkHref: "",
    });

    expect(second.updatedAt.getTime()).toBeGreaterThan(
      first.updatedAt.getTime(),
    );
    expect(await getAnnouncement()).toEqual({
      message: "Kickoff moved to Friday.",
      link: null,
      version: String(second.updatedAt.getTime()),
    });
  });

  it("keeps one row however many times it is saved", async () => {
    const rows = await db
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.slug, ANNOUNCEMENT_SLUG));

    expect(rows).toHaveLength(1);
  });

  it("comes down when an officer switches it off, keeping the text for later", async () => {
    await officer(officerId).announcement.set({
      enabled: false,
      message: "Kickoff moved to Friday.",
      linkLabel: "",
      linkHref: "",
    });

    expect(await getAnnouncement()).toBeNull();
    expect(await officer(officerId).announcement.get()).toMatchObject({
      enabled: false,
      message: "Kickoff moved to Friday.",
    });
  });

  it("is not a page: absent from the page list, the sitemap and /{slug}", async () => {
    await officer(officerId).announcement.set({
      enabled: true,
      message: "Visible banner.",
      linkLabel: "",
      linkHref: "",
    });
    const real = await officer(officerId).page.create({
      slug: `${prefix}-real`,
      title: "A real page",
      description: "",
      body: "Hello",
    });
    await officer(officerId).page.publish({ id: real.id });

    const listed = await officer(officerId).page.list();
    expect(listed.map((page) => page.slug)).toContain(`${prefix}-real`);
    expect(listed.map((page) => page.slug)).not.toContain(ANNOUNCEMENT_SLUG);

    const sitemapSlugs = (await getPublishedPageList()).map(
      (page) => page.slug,
    );
    expect(sitemapSlugs).toContain(`${prefix}-real`);
    expect(sitemapSlugs).not.toContain(ANNOUNCEMENT_SLUG);

    expect(await getPublishedPage(ANNOUNCEMENT_SLUG)).toBeNull();
  });

  it("cannot be created as an ordinary page", async () => {
    await expect(
      officer(officerId).page.create({
        slug: ANNOUNCEMENT_SLUG,
        title: "Sneaky",
        description: "",
        body: "",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
