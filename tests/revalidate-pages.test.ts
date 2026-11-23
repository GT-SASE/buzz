import { beforeEach, describe, expect, it, mock } from "bun:test";

const calls: unknown[][] = [];

mock.module("server-only", () => ({}));
mock.module("next/cache", () => ({
  unstable_cache: (fn: unknown) => fn,
  revalidateTag: (...args: unknown[]) => calls.push(["tag", ...args]),
  revalidatePath: (...args: unknown[]) => calls.push(["path", ...args]),
}));

const { PAGES_TAG } = await import("../sites/web/src/data/pages");
const { revalidatePages } =
  await import("../sites/web/src/lib/revalidate-pages");

beforeEach(() => {
  calls.length = 0;
});

describe("revalidatePages", () => {
  it("expires the tag at once, so a rebuilt page never reads the stale row", () => {
    revalidatePages(["old", "new", "old"]);

    expect(calls).toEqual([
      ["tag", PAGES_TAG, { expire: 0 }],
      ["path", "/sitemap.xml"],
      ["path", "/old"],
      ["path", "/new"],
    ]);
  });

  it("skips a slug that could not be a page address", () => {
    revalidatePages(["Not A Slug", "fine"]);

    expect(calls.filter(([kind]) => kind === "path")).toEqual([
      ["path", "/sitemap.xml"],
      ["path", "/fine"],
    ]);
  });
});
