import { beforeEach, describe, expect, it, mock } from "bun:test";

const calls: unknown[][] = [];
let cacheOptions: { tags?: string[]; revalidate?: number } | undefined;

mock.module("server-only", () => ({}));
mock.module("next/cache", () => ({
  unstable_cache: (
    fn: unknown,
    _key: unknown,
    options: { tags?: string[]; revalidate?: number },
  ) => {
    cacheOptions = options;
    return fn;
  },
  revalidateTag: (...args: unknown[]) => calls.push(["tag", ...args]),
  revalidatePath: (...args: unknown[]) => calls.push(["path", ...args]),
}));

let officer = true;
mock.module("../sites/web/src/app/portal/_lib/session.ts", () => ({
  requireOfficer: async (from: string) => {
    calls.push(["officer", from]);
    if (!officer) throw new Error("NEXT_REDIRECT");
    return { user: { role: "ADMIN" } };
  },
}));

const { ANNOUNCEMENT_TAG } = await import("../sites/web/src/data/announcement");
const { revalidateAnnouncement } =
  await import("../sites/web/src/app/portal/(member)/admin/announcement/revalidate-announcement");

beforeEach(() => {
  calls.length = 0;
  officer = true;
});

describe("revalidateAnnouncement", () => {
  it("drops the cached banner and every prerendered public page", async () => {
    await revalidateAnnouncement();

    expect(calls).toEqual([
      ["officer", "/portal/admin/announcement"],
      ["tag", ANNOUNCEMENT_TAG, "max"],
      ["path", "/", "layout"],
    ]);
  });

  it("revalidates nothing for a caller who is not an officer", async () => {
    officer = false;

    await expect(revalidateAnnouncement()).rejects.toThrow("NEXT_REDIRECT");
    expect(calls.filter(([kind]) => kind !== "officer")).toEqual([]);
  });

  it("caches the loader under the tag it revalidates, for at most an hour", () => {
    expect(cacheOptions?.tags).toEqual([ANNOUNCEMENT_TAG]);
    expect(cacheOptions?.revalidate).toBeLessThanOrEqual(3600);
  });
});
