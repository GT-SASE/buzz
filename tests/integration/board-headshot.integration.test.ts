import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import {
  bytesOf,
  GIF_B64,
  JPEG_B64,
  PNG_B64,
  WEBP_B64,
} from "../helpers/headshot-fixtures";

/**
 * Board headshots on a real Postgres: who may upload, what is stored (always
 * a small square WebP, never the uploaded file), the public route's caching
 * and its refusal for anyone not on the board, and the officer takedown.
 */
mock.module("server-only", () => ({}));
mock.module("next/cache", () => ({
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
  unstable_cache: <T>(fn: T) => fn,
}));

let signedIn: { user: { id: string; role: string; email: string } } | null =
  null;
mock.module("../../packages/auth/src/index.ts", () => ({
  auth: () => Promise.resolve(signedIn),
  handlers: {},
  signIn: () => Promise.resolve(undefined),
  signOut: () => Promise.resolve(undefined),
}));

const {
  auditLog,
  boardPhotos,
  db,
  electionBallots,
  electionCandidates,
  electionPositions,
  elections,
  users,
} = await import("../../packages/db/src/index");
const { createCaller } = await import("../../packages/api/src/root");
const { boardFromResults } = await import("../../packages/api/src/board");
const { sniffHeadshotType } = await import("../../packages/api/src/headshot");
const { processHeadshot } = await import("../../sites/web/src/lib/headshot");
const upload =
  await import("../../sites/web/src/app/api/portal/headshot/route");
const photo =
  await import("../../sites/web/src/app/(marketing)/board/photo/[id]/route");
const { and, eq, inArray } =
  await import("../../packages/db/node_modules/drizzle-orm/index.js");

const SLOW = 60_000;

describe("headshot images", () => {
  it("recognises JPEG, PNG and WebP by their bytes and nothing else", () => {
    expect(sniffHeadshotType(bytesOf(JPEG_B64))).toBe("image/jpeg");
    expect(sniffHeadshotType(bytesOf(PNG_B64))).toBe("image/png");
    expect(sniffHeadshotType(bytesOf(WEBP_B64))).toBe("image/webp");
    expect(sniffHeadshotType(bytesOf(GIF_B64))).toBeNull();
    expect(sniffHeadshotType(new TextEncoder().encode("%PDF-1.7"))).toBeNull();
    expect(sniffHeadshotType(new Uint8Array(0))).toBeNull();
  });

  it("re-encodes each accepted type to the same 400 px square WebP size", async () => {
    for (const source of [JPEG_B64, PNG_B64, WEBP_B64]) {
      const result = await processHeadshot(bytesOf(source));
      if ("error" in result) throw new Error(result.error);
      expect(sniffHeadshotType(result.webp)).toBe("image/webp");
      expect(result.webp.byteLength).toBeLessThan(200 * 1024);
      expect(result.etag).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("refuses an empty, wrong-type, oversized or unreadable file", async () => {
    expect(await processHeadshot(new Uint8Array(0))).toEqual({
      error: "The file is empty.",
    });
    expect(await processHeadshot(bytesOf(GIF_B64))).toEqual({
      error: "Upload a JPEG, PNG or WebP image.",
    });
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect(await processHeadshot(big)).toEqual({
      error: "Photos must be 5 MB or smaller.",
    });
    const broken = new Uint8Array(64);
    broken.set([0xff, 0xd8, 0xff]);
    expect(await processHeadshot(broken)).toEqual({
      error: "That image could not be read.",
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("board headshots", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const electionIds: string[] = [];
  let officer: { id: string; email: string; role: "ADMIN" };
  let winner: { id: string; email: string; role: "MEMBER" };
  let bystander: { id: string; email: string; role: "MEMBER" };

  async function makeUser(label: string, role: "MEMBER" | "ADMIN") {
    const id = `hs-${label}-${suffix}`;
    const email = `${id}@vitest.local`;
    await db.insert(users).values({ id, email, role, name: `Hs ${label}` });
    userIds.push(id);
    return { id, email, role };
  }

  const callerFor = (user: { id: string; email: string; role: string }) =>
    createCaller({
      db,
      session: {
        user: { ...user, name: user.id },
        expires: new Date(Date.now() + 86_400_000).toISOString(),
      },
      headers: new Headers(),
    } as never);

  function asUser(user: { id: string; email: string; role: string } | null) {
    signedIn = user ? { user } : null;
  }

  function post(file: Uint8Array | null, name = "me.png", type = "image/png") {
    const form = new FormData();
    if (file) form.set("file", new File([file as BlobPart], name, { type }));
    return upload.POST(
      new Request("http://localhost:3000/api/portal/headshot", {
        method: "POST",
        body: form,
      }) as never,
    );
  }

  const stored = async (userId: string) =>
    (
      await db.select().from(boardPhotos).where(eq(boardPhotos.userId, userId))
    )[0];

  beforeAll(async () => {
    officer = (await makeUser("officer", "ADMIN")) as typeof officer;
    winner = (await makeUser("winner", "MEMBER")) as typeof winner;
    bystander = (await makeUser("bystander", "MEMBER")) as typeof bystander;

    // A published election the winner won, a year ahead so it is the latest.
    const [election] = await db
      .insert(elections)
      .values({
        year: "2999-3000",
        title: `hs board ${suffix}`,
        phase: "published",
      })
      .returning({ id: elections.id });
    electionIds.push(election!.id);
    const [position] = await db
      .insert(electionPositions)
      .values({ electionId: election!.id, title: "Chair" })
      .returning({ id: electionPositions.id });
    const [candidate] = await db
      .insert(electionCandidates)
      .values({
        positionId: position!.id,
        userId: winner.id,
        statement: "me",
        status: "approved",
      })
      .returning({ id: electionCandidates.id });
    await db
      .insert(electionBallots)
      .values({ positionId: position!.id, candidateId: candidate!.id });
  }, SLOW);

  afterAll(async () => {
    asUser(null);
    if (electionIds.length > 0) {
      await db.delete(elections).where(inArray(elections.id, electionIds));
    }
    await db.delete(auditLog).where(inArray(auditLog.targetId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }, SLOW);

  it(
    "lets only a member on the current board upload, and stores a small WebP, not the file",
    async () => {
      asUser(null);
      expect((await post(bytesOf(PNG_B64))).status).toBe(401);

      asUser(bystander);
      expect((await post(bytesOf(PNG_B64))).status).toBe(403);
      expect(await stored(bystander.id)).toBeUndefined();

      asUser(winner);
      expect((await post(null)).status).toBe(400);
      // The declared type and name do not matter; the bytes do.
      expect((await post(bytesOf(GIF_B64), "me.png", "image/png")).status).toBe(
        400,
      );
      expect((await post(new TextEncoder().encode("%PDF-1.7"))).status).toBe(
        400,
      );
      expect(await stored(winner.id)).toBeUndefined();

      const response = await post(bytesOf(JPEG_B64), "me.jpg", "image/jpeg");
      expect(response.status).toBe(200);
      const row = (await stored(winner.id))!;
      expect(row.contentType).toBe("image/webp");
      expect(row.byteSize).toBeLessThanOrEqual(200 * 1024);
      const bytes = Buffer.from(row.bytes, "base64");
      expect(sniffHeadshotType(bytes)).toBe("image/webp");
      expect(bytes.byteLength).toBe(row.byteSize);
      expect(((await response.json()) as { version: string }).version).toBe(
        row.etag,
      );

      // Replacing keeps one row.
      expect((await post(bytesOf(PNG_B64))).status).toBe(200);
      expect(
        await db
          .select()
          .from(boardPhotos)
          .where(eq(boardPhotos.userId, winner.id)),
      ).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "shows the seat holder their seat and photo in settings, and nobody else",
    async () => {
      const mine = await callerFor(winner).headshot.mine();
      expect(mine.roles).toEqual(["Chair"]);
      expect(mine.photo).toMatch(
        new RegExp(`^/board/photo/${winner.id}\\?v=[0-9a-f]{32}$`),
      );
      expect(await callerFor(bystander).headshot.mine()).toEqual({
        roles: [],
        photo: null,
      });
    },
    SLOW,
  );

  it(
    "puts the photo version on the board seat, and never an account avatar",
    async () => {
      await db
        .update(users)
        .set({ image: "https://lh3.example.test/avatar.png" })
        .where(eq(users.id, winner.id));
      const seats = (await boardFromResults(db))!;
      const seat = seats.find((s) => s.userId === winner.id)!;
      expect(seat.photoVersion).toBe((await stored(winner.id))!.etag);
      expect(JSON.stringify(seats)).not.toContain("avatar");
    },
    SLOW,
  );

  it(
    "serves the photo publicly with a year of caching and an ETag, and 304s a repeat",
    async () => {
      const row = (await stored(winner.id))!;
      const url = `http://localhost:3000/board/photo/${winner.id}?v=${row.etag}`;
      const ask = (headers: Record<string, string> = {}) =>
        photo.GET(new Request(url, { headers }), {
          params: Promise.resolve({ id: winner.id }),
        });

      const first = await ask();
      expect(first.status).toBe(200);
      expect(first.headers.get("content-type")).toBe("image/webp");
      expect(first.headers.get("etag")).toBe(`"${row.etag}"`);
      expect(first.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(first.headers.get("x-content-type-options")).toBe("nosniff");
      const body = Buffer.from(await first.arrayBuffer());
      expect(body.equals(Buffer.from(row.bytes, "base64"))).toBe(true);

      const again = await ask({ "if-none-match": `"${row.etag}"` });
      expect(again.status).toBe(304);
      expect(again.headers.get("etag")).toBe(`"${row.etag}"`);
      expect((await again.arrayBuffer()).byteLength).toBe(0);
    },
    SLOW,
  );

  it(
    "404s the photo of anyone who is not on the current board",
    async () => {
      // The bystander uploads nothing, but even a row for them would not serve.
      await db.insert(boardPhotos).values({
        userId: bystander.id,
        contentType: "image/webp",
        byteSize: 10,
        bytes: Buffer.from("not-served").toString("base64"),
        etag: "e".repeat(32),
      });
      const response = await photo.GET(
        new Request(`http://localhost:3000/board/photo/${bystander.id}`),
        { params: Promise.resolve({ id: bystander.id }) },
      );
      expect(response.status).toBe(404);
      const missing = await photo.GET(
        new Request("http://localhost:3000/board/photo/nobody"),
        { params: Promise.resolve({ id: "nobody" }) },
      );
      expect(missing.status).toBe(404);
    },
    SLOW,
  );

  it(
    "lets the owner delete their photo",
    async () => {
      asUser(bystander);
      expect(
        (
          await upload.DELETE(
            new Request("http://localhost:3000/api/portal/headshot", {
              method: "DELETE",
            }) as never,
          )
        ).status,
      ).toBe(403);
      asUser(winner);
      expect(
        (
          await upload.DELETE(
            new Request("http://localhost:3000/api/portal/headshot", {
              method: "DELETE",
            }) as never,
          )
        ).status,
      ).toBe(200);
      expect(await stored(winner.id)).toBeUndefined();
      expect(
        (await boardFromResults(db))!.find((s) => s.userId === winner.id)!
          .photoVersion,
      ).toBeUndefined();
    },
    SLOW,
  );

  it(
    "lets an officer, and only an officer, take a photo down, and logs it",
    async () => {
      asUser(winner);
      expect((await post(bytesOf(WEBP_B64))).status).toBe(200);

      await expect(
        callerFor(winner).headshot.remove({ userId: winner.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(callerFor(bystander).headshot.seats()).rejects.toMatchObject(
        { code: "FORBIDDEN" },
      );

      const seats = await callerFor(officer).headshot.seats();
      expect(seats).toContainEqual({
        userId: winner.id,
        name: `Hs winner`,
        role: "Chair",
        hasPhoto: true,
      });

      await callerFor(officer).headshot.remove({ userId: winner.id });
      expect(await stored(winner.id)).toBeUndefined();
      const [audit] = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.targetId, winner.id),
            eq(auditLog.action, "board.remove_photo"),
          ),
        );
      expect(audit).toMatchObject({
        actorId: officer.id,
        targetType: "member",
        targetLabel: winner.email,
      });
      await expect(
        callerFor(officer).headshot.remove({ userId: winner.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    },
    SLOW,
  );
});
