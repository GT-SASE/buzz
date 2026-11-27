import { beforeEach, describe, expect, it, mock } from "bun:test";

const tags: unknown[][] = [];
const paths: unknown[][] = [];
let officer = true;

mock.module("server-only", () => ({}));
mock.module("next/cache", () => ({
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  revalidateTag: (...args: unknown[]) => tags.push(args),
  revalidatePath: (...args: unknown[]) => paths.push(args),
}));
mock.module("../../sites/web/src/app/portal/_lib/session", () => ({
  requireOfficer: async () => {
    if (!officer) throw new Error("NEXT_REDIRECT");
  },
}));

const { revalidatePublicCalendar } =
  await import("../../sites/web/src/app/portal/(member)/admin/revalidate-calendar");
const { CHAPTER_EVENTS_TAG } =
  await import("../../sites/web/src/data/chapter-events");

beforeEach(() => {
  tags.length = 0;
  paths.length = 0;
  officer = true;
});

describe("revalidatePublicCalendar", () => {
  it("expires the calendar tag every public event page and the feed are built from", async () => {
    await revalidatePublicCalendar();
    expect(tags).toEqual([[CHAPTER_EVENTS_TAG, "max"]]);
  });

  it("refreshes the pages people check right after saving, the feed and the sitemap", async () => {
    await revalidatePublicCalendar();
    const refreshed = paths.map(([path]) => path);
    for (const path of ["/", "/events", "/events.ics", "/sitemap.xml"])
      expect(refreshed).toContain(path);
  });

  it("does nothing for someone who is not an officer", async () => {
    officer = false;
    await expect(revalidatePublicCalendar()).rejects.toThrow("NEXT_REDIRECT");
    expect(tags).toEqual([]);
    expect(paths).toEqual([]);
  });
});
