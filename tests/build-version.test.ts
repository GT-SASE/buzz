import { afterEach, describe, expect, it, vi } from "vitest";

import { appBuild } from "../sites/web/build-version";

function fakeGit(merges: string, shallow = "false") {
  const calls: string[][] = [];
  const git = (...args: string[]) => {
    calls.push(args);
    if (args[0] === "rev-parse" && args[1] === "--short") return "abc1234";
    if (args[0] === "rev-parse") return shallow;
    if (args[0] === "log") return "basesha";
    if (args[0] === "rev-list") return merges;
    return "";
  };
  return { git, calls };
}

afterEach(() => vi.restoreAllMocks());

describe("appBuild", () => {
  it("appends the merge count as the patch", () => {
    expect(appBuild("2.5.0", fakeGit("7").git)).toEqual({
      version: "2.5.7",
      commit: "abc1234",
    });
  });

  it("rolls into minor at 100 patches", () => {
    expect(appBuild("2.5.0", fakeGit("100").git).version).toBe("2.6.0");
    expect(appBuild("2.5.0", fakeGit("250").git).version).toBe("2.7.50");
  });

  it("deepens a shallow clone before counting", () => {
    const { git, calls } = fakeGit("3", "true");
    appBuild("2.5.0", git);
    expect(calls.some((c) => c.includes("--unshallow"))).toBe(true);
  });

  it("warns and reports the package version when counting fails", () => {
    const warn = vi.spyOn(console, "warn").mockReturnValue();
    const git = (...args: string[]) => {
      if (args[1] === "--short") return "abc1234";
      throw new Error("fetch failed");
    };
    expect(appBuild("2.5.0", git)).toEqual({
      version: "2.5.0",
      commit: "abc1234",
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("reports the package version when git is absent", () => {
    const git = () => {
      throw new Error("no git");
    };
    expect(appBuild("2.5.0", git).version).toBe("2.5.0");
  });
});
