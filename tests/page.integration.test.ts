import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

import { GIF_B64, PNG_B64, bytesOf } from "./helpers/headshot-fixtures";

/**
 * The page builder on a real Postgres: drafts against what the public sees,
 * versions and restore, the redirect a slug change leaves behind, image
 * uploads, the audit trail, and the cache drops a mutation asks for.
 */
mock.module("server-only", () => ({}));
mock.module("next/cache", () => ({
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
  unstable_cache: <T>(fn: T) => fn,
}));

let signedIn: { user: { id: string; role: string; email: string } } | null =
  null;
mock.module("../packages/auth/src/index.ts", () => ({
  auth: () => Promise.resolve(signedIn),
  handlers: {},
  signIn: () => Promise.resolve(undefined),
  signOut: () => Promise.resolve(undefined),
}));

const { auditLog, db, pageImages, pageRedirects, pages, pageVersions, users } =
  await import("../packages/db/src/index");
const { createCaller } = await import("../packages/api/src/root");
const { pageRedirectTarget } =
  await import("../packages/api/src/page-redirect");
const { getPageRedirect, getPublishedPage } =
  await import("../sites/web/src/data/pages");
const upload = await import("../sites/web/src/app/api/admin/page-image/route");
const imageRoute =
  await import("../sites/web/src/app/(marketing)/page-image/[id]/route");
const sharp = (await import("../sites/web/node_modules/sharp")).default;
const { and, eq, inArray, like, sql } = await import("drizzle-orm");

const SLOW = 60_000;

describe.skipIf(!process.env.DATABASE_URL)("page builder", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const officerId = `pg-officer-${suffix}`;
  const memberId = `pg-member-${suffix}`;
  const prefix = `pb-${suffix}`;

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
  const officer = () => callerFor(officerId, "ADMIN");

  async function errorCode(promise: Promise<unknown>) {
    try {
      await promise;
      return "NO_ERROR";
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    }
  }

  const fields = (slug: string, body = "# Hello") => ({
    slug,
    title: "Builder page",
    description: "A page",
    body,
  });

  const audit = async (action: string, targetId: string) =>
    db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, action as never),
          eq(auditLog.targetId, targetId),
        ),
      );

  async function liveBody(slug: string) {
    return (await getPublishedPage(slug))?.body ?? null;
  }

  /** A page created and published at `slug`. */
  async function livePage(slug: string, body = "# Hello") {
    const page = await officer().page.create(fields(slug, body));
    await officer().page.publish({ id: page.id });
    return page;
  }

  beforeAll(async () => {
    await db.insert(users).values([
      { id: officerId, email: `${officerId}@vitest.local`, role: "ADMIN" },
      { id: memberId, email: `${memberId}@vitest.local`, role: "MEMBER" },
    ]);
  }, SLOW);

  afterAll(async () => {
    signedIn = null;
    const mine = await db
      .select({ id: pages.id })
      .from(pages)
      .where(like(pages.slug, `${prefix}%`));
    await db.delete(pages).where(like(pages.slug, `${prefix}%`));
    void mine;
    const ids = [officerId, memberId, `${officerId}-fast`];
    await db.delete(pageImages).where(inArray(pageImages.createdById, ids));
    await db.delete(auditLog).where(inArray(auditLog.actorId, ids));
    await db.delete(users).where(inArray(users.id, ids));
  }, SLOW);

  it("keeps a draft off the public site until it is published", async () => {
    const slug = `${prefix}-draft`;
    const page = await officer().page.create(fields(slug, "first"));
    expect(page.published).toBe(false);
    expect(await liveBody(slug)).toBeNull();

    await officer().page.saveDraft({ id: page.id, ...fields(slug, "second") });
    expect(await liveBody(slug)).toBeNull();

    await officer().page.publish({ id: page.id });
    expect(await liveBody(slug)).toBe("second");

    // Editing a live page changes only the draft.
    await officer().page.saveDraft({ id: page.id, ...fields(slug, "third") });
    expect(await liveBody(slug)).toBe("second");
    const read = await officer().page.byId({ id: page.id });
    expect(read.hasDraft).toBe(true);
    expect(read.draft.body).toBe("third");
    expect(read.published).toBe(true);

    await officer().page.publish({ id: page.id });
    expect(await liveBody(slug)).toBe("third");
    // Nothing left to publish.
    expect(await errorCode(officer().page.publish({ id: page.id }))).toBe(
      "CONFLICT",
    );

    // Taking it down hides it again; the text stays.
    await officer().page.unpublish({ id: page.id });
    expect(await liveBody(slug)).toBeNull();
    expect((await officer().page.byId({ id: page.id })).draft.body).toBe(
      "third",
    );
    await officer().page.publish({ id: page.id });
    expect(await liveBody(slug)).toBe("third");
  });

  it("restore opens a new version and leaves the live page alone", async () => {
    const slug = `${prefix}-restore`;
    const page = await livePage(slug, "v1 text");
    await officer().page.saveDraft({ id: page.id, ...fields(slug, "v2 text") });
    await officer().page.publish({ id: page.id });
    await officer().page.saveDraft({
      id: page.id,
      ...fields(slug, "v3 draft"),
    });

    const { number } = await officer().page.restore({ id: page.id, number: 1 });
    expect(number).toBe(4);
    expect(await liveBody(slug)).toBe("v2 text");

    const versions = await officer().page.versions({ id: page.id });
    expect(versions.map((v) => [v.number, v.state])).toEqual([
      [4, "draft"],
      [3, "replaced"],
      [2, "live"],
      [1, "published"],
    ]);
    expect(versions[0]!.restoredFrom).toBe(1);
    expect((await officer().page.byId({ id: page.id })).draft.body).toBe(
      "v1 text",
    );

    await officer().page.publish({ id: page.id });
    expect(await liveBody(slug)).toBe("v1 text");
    expect(
      await errorCode(officer().page.restore({ id: page.id, number: 99 })),
    ).toBe("NOT_FOUND");
  });

  it("redirects an old slug to the new one and collapses chains", async () => {
    const a = `${prefix}-a`;
    const b = `${prefix}-b`;
    const c = `${prefix}-c`;
    const page = await livePage(a);
    expect(await pageRedirectTarget(db, a)).toBeNull();

    await officer().page.saveDraft({ id: page.id, ...fields(b) });
    // Not live yet: the old address still serves the page.
    expect(await liveBody(a)).toBe("# Hello");
    await officer().page.publish({ id: page.id });
    expect(await liveBody(a)).toBeNull();
    expect(await getPageRedirect(a)).toBe(b);

    await officer().page.saveDraft({ id: page.id, ...fields(c) });
    await officer().page.publish({ id: page.id });
    // Both old addresses go straight to the newest one.
    expect(await getPageRedirect(a)).toBe(c);
    expect(await getPageRedirect(b)).toBe(c);
    expect(await getPageRedirect(c)).toBeNull();

    // Moving back onto an old address drops the redirect that was there.
    await officer().page.saveDraft({ id: page.id, ...fields(a) });
    const published = await officer().page.publish({ id: page.id });
    expect(await getPageRedirect(a)).toBeNull();
    expect(await liveBody(a)).toBe("# Hello");
    expect(await getPageRedirect(b)).toBe(a);
    expect(await getPageRedirect(c)).toBe(a);

    // The mutation names every address the cache must drop.
    expect(new Set(published.revalidate)).toEqual(new Set([a, b, c]));

    // A draft again, a page redirects nowhere.
    await officer().page.unpublish({ id: page.id });
    expect(await pageRedirectTarget(db, b)).toBeNull();
  });

  it("never lets a redirect shadow a live page or a reserved slug", async () => {
    const old = `${prefix}-old`;
    const page = await livePage(old);
    await officer().page.saveDraft({ id: page.id, ...fields(`${prefix}-new`) });
    await officer().page.publish({ id: page.id });
    expect(await pageRedirectTarget(db, old)).toBe(`${prefix}-new`);

    // Another page takes the vacated address: it is live, the redirect goes.
    const other = await livePage(old, "other page");
    expect(await liveBody(old)).toBe("other page");
    expect(await pageRedirectTarget(db, old)).toBeNull();
    const rows = await db
      .select()
      .from(pageRedirects)
      .where(eq(pageRedirects.fromSlug, old));
    expect(rows).toHaveLength(0);

    // A stale row aimed at a live slug, or at a reserved one, is ignored.
    await db
      .insert(pageRedirects)
      .values({ fromSlug: old, pageId: page.id })
      .onConflictDoNothing();
    expect(await pageRedirectTarget(db, old)).toBeNull();
    await db.delete(pageRedirects).where(eq(pageRedirects.fromSlug, old));
    await db
      .insert(pageRedirects)
      .values({ fromSlug: "about", pageId: page.id });
    expect(await pageRedirectTarget(db, "about")).toBeNull();
    await db.delete(pageRedirects).where(eq(pageRedirects.fromSlug, "about"));

    // A slug that became reserved after it was saved cannot be published.
    const sneaky = await officer().page.create(fields(`${prefix}-sneaky`));
    await db
      .update(pageVersions)
      .set({ slug: "about" })
      .where(eq(pageVersions.pageId, sneaky.id));
    expect(await errorCode(officer().page.publish({ id: sneaky.id }))).toBe(
      "BAD_REQUEST",
    );
    expect(
      await errorCode(
        officer().page.saveDraft({ id: sneaky.id, ...fields("about") }),
      ),
    ).toBe("BAD_REQUEST");
    expect(
      await errorCode(
        officer().page.saveDraft({ id: sneaky.id, ...fields(other.slug) }),
      ),
    ).toBe("CONFLICT");
  });

  it("answers a duplicate slug with CONFLICT", async () => {
    const first = await officer().page.create(fields(`${prefix}-dup1`));
    const second = await officer().page.create(fields(`${prefix}-dup2`));
    expect(await errorCode(officer().page.create(fields(first.slug)))).toBe(
      "CONFLICT",
    );
    expect(
      await errorCode(
        officer().page.saveDraft({ id: second.id, ...fields(first.slug) }),
      ),
    ).toBe("CONFLICT");
  });

  it("writes an audit row for each officer action, and none for a draft save", async () => {
    const slug = `${prefix}-audit`;
    const page = await officer().page.create(fields(slug));
    await officer().page.saveDraft({ id: page.id, ...fields(slug, "edit") });
    await officer().page.publish({ id: page.id });
    await officer().page.saveDraft({ id: page.id, ...fields(slug, "edit 2") });
    await officer().page.restore({ id: page.id, number: 1 });
    await officer().page.unpublish({ id: page.id });

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, page.id));
    expect(rows.map((row) => row.action).sort()).toEqual([
      "page.create",
      "page.publish",
      "page.restore",
      "page.unpublish",
    ]);
    const publish = rows.find((row) => row.action === "page.publish")!;
    expect(publish.actorId).toBe(officerId);
    expect(publish.targetType).toBe("page");
    expect(publish.after).toEqual({ slug, version: 1 });

    await officer().page.delete({ id: page.id });
    const [deleted] = await audit("page.delete", page.id);
    expect(deleted?.before).toEqual({ slug, published: false });
  });

  it("names the addresses to drop from the cache after publish, unpublish and delete", async () => {
    const slug = `${prefix}-cache`;
    const page = await officer().page.create(fields(slug, "# Hello"));
    expect(
      (await officer().page.publish({ id: page.id })).revalidate,
    ).toContain(slug);
    expect(
      (await officer().page.unpublish({ id: page.id })).revalidate,
    ).toContain(slug);
    expect((await officer().page.delete({ id: page.id })).revalidate).toContain(
      slug,
    );
  });

  it("keeps members out", async () => {
    const page = await officer().page.create(fields(`${prefix}-guard`));
    const member = callerFor(memberId, "MEMBER");
    expect(await errorCode(member.page.list())).toBe("FORBIDDEN");
    expect(await errorCode(member.page.publish({ id: page.id }))).toBe(
      "FORBIDDEN",
    );
    expect(
      await errorCode(member.page.restore({ id: page.id, number: 1 })),
    ).toBe("FORBIDDEN");
  });

  it("lists a draft's working title and flags unpublished changes", async () => {
    const slug = `${prefix}-list`;
    const page = await livePage(slug);
    await officer().page.saveDraft({
      id: page.id,
      ...fields(slug),
      title: "Working title",
    });
    const row = (await officer().page.list()).find((r) => r.id === page.id)!;
    expect(row.hasDraft).toBe(true);
    expect(row.title).toBe("Working title");
    expect(row.published).toBe(true);
  });

  it("keeps the site banner out of the editor", async () => {
    const [banner] = await db
      .select()
      .from(pages)
      .where(eq(pages.slug, "site-banner"));
    if (banner) {
      expect(await errorCode(officer().page.byId({ id: banner.id }))).toBe(
        "NOT_FOUND",
      );
    }
    expect(
      (await officer().page.list()).some((row) => row.slug === "site-banner"),
    ).toBe(false);
  });

  it("still reads and lists pages on a database without the new tables", async () => {
    const slug = `${prefix}-old-db`;
    const page = await livePage(slug, "still here");
    // Hide the tables the way a database that has not migrated yet lacks them.
    await db.execute(
      sql`alter table buzz_page_version rename to buzz_page_version_hold`,
    );
    await db.execute(
      sql`alter table buzz_page_redirect rename to buzz_page_redirect_hold`,
    );
    try {
      expect(await liveBody(slug)).toBe("still here");
      expect(await getPageRedirect(`${prefix}-missing`)).toBeNull();
      expect(await getPageRedirect(slug)).toBeNull();
      await expect(
        pageRedirectTarget(db, `${prefix}-missing`),
      ).rejects.toThrow();

      const listed = await officer().page.list();
      expect(listed.find((row) => row.id === page.id)?.hasDraft).toBe(false);
      const read = await officer().page.byId({ id: page.id });
      expect(read.draft.body).toBe("still here");
      expect(read.latestVersion).toBe(0);
      // Writes say so plainly instead of failing with a 500.
      expect(
        await errorCode(
          officer().page.saveDraft({ id: page.id, ...fields(slug) }),
        ),
      ).toBe("PRECONDITION_FAILED");
      expect(await errorCode(officer().page.versions({ id: page.id }))).toBe(
        "PRECONDITION_FAILED",
      );
    } finally {
      await db.execute(
        sql`alter table buzz_page_version_hold rename to buzz_page_version`,
      );
      await db.execute(
        sql`alter table buzz_page_redirect_hold rename to buzz_page_redirect`,
      );
    }
    expect((await officer().page.versions({ id: page.id })).length).toBe(1);
  });

  describe("image upload", () => {
    function post(
      file: Uint8Array | null,
      name = "pic.png",
      type = "image/png",
    ) {
      const form = new FormData();
      if (file) form.set("file", new File([file as BlobPart], name, { type }));
      return upload.POST(
        new Request("http://localhost:3000/api/admin/page-image", {
          method: "POST",
          body: form,
        }) as never,
      );
    }
    const asOfficer = () =>
      (signedIn = {
        user: {
          id: officerId,
          role: "ADMIN",
          email: `${officerId}@vitest.local`,
        },
      });
    const png = (width: number, height: number) =>
      sharp({
        create: { width, height, channels: 3, background: "#336699" },
      })
        .png()
        .toBuffer();

    it("is for officers only", async () => {
      signedIn = null;
      expect((await post(bytesOf(PNG_B64))).status).toBe(401);
      signedIn = {
        user: {
          id: memberId,
          role: "MEMBER",
          email: `${memberId}@vitest.local`,
        },
      };
      expect((await post(bytesOf(PNG_B64))).status).toBe(403);
      const rows = await db
        .select()
        .from(pageImages)
        .where(eq(pageImages.createdById, memberId));
      expect(rows).toHaveLength(0);
    });

    it(
      "refuses an empty, wrong-type, oversized, too tall or unreadable file",
      async () => {
        asOfficer();
        expect((await post(null)).status).toBe(400);
        expect((await post(new Uint8Array(0))).status).toBe(400);
        // The declared type does not matter; the bytes do.
        expect(
          (await post(bytesOf(GIF_B64), "a.png", "image/png")).status,
        ).toBe(400);
        const big = new Uint8Array(5 * 1024 * 1024 + 1);
        big.set([0xff, 0xd8, 0xff]);
        const tooBig = await post(big);
        expect(tooBig.status).toBe(400);
        expect(((await tooBig.json()) as { error: string }).error).toMatch(
          /5 MB/,
        );
        const broken = new Uint8Array(64);
        broken.set([0xff, 0xd8, 0xff]);
        expect((await post(broken)).status).toBe(400);
        const tall = await post(await png(20, 10_100));
        expect(tall.status).toBe(400);
        expect(((await tall.json()) as { error: string }).error).toMatch(
          /tall/,
        );
      },
      SLOW,
    );

    it(
      "scales a wide image to 1600 px, never enlarges, stores a WebP and audits it",
      async () => {
        asOfficer();
        const wide = await post(await png(3200, 1200), "Wide Shot.png");
        expect(wide.status).toBe(200);
        const body = (await wide.json()) as {
          id: string;
          url: string;
          width: number;
          height: number;
        };
        expect([body.width, body.height]).toEqual([1600, 600]);
        expect(body.url).toBe(`/page-image/${body.id}`);

        const [row] = await db
          .select()
          .from(pageImages)
          .where(eq(pageImages.id, body.id));
        expect(row?.contentType).toBe("image/webp");
        expect(row!.byteSize).toBeLessThanOrEqual(1024 * 1024);
        expect(row?.createdById).toBe(officerId);
        const bytes = Buffer.from(row!.bytes, "base64");
        expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");

        const small = await post(await png(300, 200));
        const smallBody = (await small.json()) as {
          width: number;
          height: number;
        };
        expect([smallBody.width, smallBody.height]).toEqual([300, 200]);

        const [logged] = await audit("page.upload_image", body.id);
        expect(logged?.actorId).toBe(officerId);
        expect(logged?.after).toEqual({
          width: 1600,
          height: 600,
          bytes: row!.byteSize,
        });
      },
      SLOW,
    );

    it(
      "serves the image with an immutable cache and an ETag, 304 on a match, 404 for an unknown id",
      async () => {
        asOfficer();
        const created = (await (await post(await png(64, 64))).json()) as {
          id: string;
        };
        const get = (id: string, headers: Record<string, string> = {}) =>
          imageRoute.GET(
            new Request(`http://localhost:3000/page-image/${id}`, { headers }),
            { params: Promise.resolve({ id }) },
          );

        const ok = await get(created.id);
        expect(ok.status).toBe(200);
        expect(ok.headers.get("content-type")).toBe("image/webp");
        expect(ok.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable",
        );
        expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
        const etag = ok.headers.get("etag")!;
        expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
        expect(
          Buffer.from(await ok.arrayBuffer())
            .subarray(0, 4)
            .toString(),
        ).toBe("RIFF");

        const same = await get(created.id, { "if-none-match": etag });
        expect(same.status).toBe(304);
        expect((await get("no-such-image")).status).toBe(404);
      },
      SLOW,
    );

    it(
      "limits how fast one officer can upload",
      async () => {
        const fastId = `${officerId}-fast`;
        await db.insert(users).values({
          id: fastId,
          email: `${fastId}@vitest.local`,
          role: "ADMIN",
        });
        signedIn = {
          user: { id: fastId, role: "ADMIN", email: `${fastId}@vitest.local` },
        };
        const tiny = bytesOf(PNG_B64);
        const statuses: number[] = [];
        for (let i = 0; i < 14; i++) statuses.push((await post(tiny)).status);
        expect(statuses.at(-1)).toBe(429);
        expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(
          12,
        );
      },
      SLOW,
    );
  });
});
