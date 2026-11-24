import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

// The loader is written for Next: `server-only` throws outside a server build
// and `unstable_cache` needs Next's cache. Neither belongs in what is under
// test here, which is the query and what it lets through.
mock.module("server-only", () => ({}));
mock.module("next/cache", () => ({
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));

const { db, events, users } = await import("../packages/db/src/index");
const { eq, inArray } = await import("drizzle-orm");
const { getChapterCalendar, getChapterEvent } =
  await import("../sites/web/src/data/chapter-events");

const DAY_MS = 24 * 60 * 60 * 1000;
const SLOW = 30_000;

describe.skipIf(!process.env.DATABASE_URL)("public event by id", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let officerId = "";
  const ids = {
    live: crypto.randomUUID(),
    edited: crypto.randomUUID(),
    archived: crypto.randomUUID(),
    reminder: crypto.randomUUID(),
    beyondTheList: crypto.randomUUID(),
  };
  const codes = {
    live: `LV${suffix.slice(0, 6)}`.toUpperCase(),
    archived: `AR${suffix.slice(0, 6)}`.toUpperCase(),
  };
  const editedAt = new Date("2026-10-01T15:00:00.000Z");

  beforeAll(async () => {
    const [officer] = await db
      .insert(users)
      .values({
        email: `vitest-event-page-${suffix}@example.invalid`,
        name: "vitest event page",
        role: "ADMIN",
      })
      .returning();
    if (!officer) throw new Error("could not create the test officer");
    officerId = officer.id;

    const start = Date.now() + 400 * DAY_MS;
    const filler = Array.from({ length: 85 }, (_, index) => ({
      id: index === 84 ? ids.beyondTheList : crypto.randomUUID(),
      title: `vitest event page filler ${index}`,
      startsAt: new Date(start + index * DAY_MS),
      checkInCode: `F${suffix.slice(0, 3)}${String(index).padStart(3, "0")}`
        .toUpperCase()
        .slice(0, 8),
      createdById: officerId,
    }));

    await db.insert(events).values([
      {
        id: ids.live,
        title: "vitest event page live",
        description: "Bring a laptop; we build, then eat.",
        location: "Klaus 1116",
        startsAt: new Date(Date.now() + 3 * DAY_MS),
        checkInCode: codes.live,
        createdById: officerId,
      },
      {
        id: ids.edited,
        title: "vitest event page edited",
        startsAt: new Date(Date.now() - 40 * DAY_MS),
        checkInCode: `ED${suffix.slice(0, 6)}`.toUpperCase(),
        createdById: officerId,
        updatedAt: editedAt,
      },
      {
        id: ids.archived,
        title: "vitest event page archived",
        startsAt: new Date(Date.now() + 5 * DAY_MS),
        checkInCode: codes.archived,
        createdById: officerId,
        archivedAt: new Date(),
      },
      {
        id: ids.reminder,
        title: "vitest event page reminder",
        startsAt: new Date(Date.now() + 6 * DAY_MS),
        pointsValue: 0,
        checkInEnabled: false,
        checkInCode: `RM${suffix.slice(0, 6)}`.toUpperCase(),
        createdById: officerId,
      },
      ...filler,
    ]);
  }, SLOW);

  afterAll(async () => {
    if (!officerId) return;
    await db.delete(events).where(eq(events.createdById, officerId));
    await db.delete(users).where(inArray(users.id, [officerId]));
  }, SLOW);

  it("returns a live event with its place and copy", async () => {
    const event = await getChapterEvent(ids.live);
    expect(event).toMatchObject({
      id: ids.live,
      title: "vitest event page live",
      location: "Klaus 1116",
      description: "Bring a laptop; we build, then eat.",
      reminder: false,
    });
  });

  it("returns a past event: the archive links to it", async () => {
    expect((await getChapterEvent(ids.edited))?.title).toBe(
      "vitest event page edited",
    );
  });

  it("flags a campus reminder", async () => {
    expect((await getChapterEvent(ids.reminder))?.reminder).toBe(true);
  });

  it("answers null for an archived event", async () => {
    expect(await getChapterEvent(ids.archived)).toBeNull();
  });

  it("answers null for an id nobody has", async () => {
    expect(await getChapterEvent(crypto.randomUUID())).toBeNull();
  });

  it("answers null, without a query, for text that cannot be an id", async () => {
    for (const id of ["", "a b", "../etc", "x".repeat(300), "a%00b", "a/b"])
      expect(await getChapterEvent(id)).toBeNull();
  });

  it("finds an event too far out to be on the calendar list", async () => {
    const { upcoming } = await getChapterCalendar();
    expect(upcoming.some((event) => event.id === ids.beyondTheList)).toBe(
      false,
    );
    expect((await getChapterEvent(ids.beyondTheList))?.title).toBe(
      "vitest event page filler 84",
    );
  });

  it("dates a never-edited event by its creation and an edited one by its edit", async () => {
    const live = await getChapterEvent(ids.live);
    expect(live!.modifiedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    const edited = await getChapterEvent(ids.edited);
    expect(edited!.modifiedAt).toEqual(editedAt);
  });

  it("keeps check-in codes and archived events out of everything it returns", async () => {
    const calendar = await getChapterCalendar();
    const everything = JSON.stringify([
      calendar,
      await getChapterEvent(ids.live),
    ]);
    expect(everything).not.toContain(codes.live);
    expect(everything).not.toContain(codes.archived);
    expect(everything).not.toContain("checkInCode");
    expect(everything).not.toContain(ids.archived);
  });
});
