import { beforeEach, describe, expect, it, mock } from "bun:test";

const calls: unknown[][] = [];

mock.module("server-only", () => ({}));
mock.module("next/cache", () => ({
  unstable_cache: (fn: unknown) => fn,
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

const { PAGES_TAG } = await import("../sites/web/src/data/pages");
const { revalidatePages } =
  await import("../sites/web/src/app/portal/(member)/admin/pages/revalidate-pages");

beforeEach(() => {
  calls.length = 0;
  officer = true;
});

describe("revalidatePages", () => {
  it("drops the tag, the sitemap and each distinct page address once", async () => {
    await revalidatePages(["old", "new", "old"]);

    expect(calls).toEqual([
      ["officer", "/portal/admin/pages"],
      ["tag", PAGES_TAG, "max"],
      ["path", "/sitemap.xml"],
      ["path", "/old"],
      ["path", "/new"],
    ]);
  });

  it("skips a slug that could not be a page address", async () => {
    await revalidatePages(["Not A Slug", "fine"]);

    expect(calls.filter(([kind]) => kind === "path")).toEqual([
      ["path", "/sitemap.xml"],
      ["path", "/fine"],
    ]);
  });

  it("revalidates nothing for a caller who is not an officer", async () => {
    officer = false;

    await expect(revalidatePages(["x"])).rejects.toThrow("NEXT_REDIRECT");
    expect(calls.filter(([kind]) => kind !== "officer")).toEqual([]);
  });
});
