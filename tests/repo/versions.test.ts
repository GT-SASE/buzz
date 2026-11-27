import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

const readPkg = (dir: string) =>
  JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
    name: string;
    version: string;
    workspaces?: string[];
  };

/** Root plus every directory matched by the root workspaces globs (`dir/*`). */
function workspaceDirs(): string[] {
  const globs = readPkg(root).workspaces ?? [];
  const dirs = [root];
  for (const glob of globs) {
    const base = glob.replace(/\/\*$/, "");
    for (const e of readdirSync(path.join(root, base), {
      withFileTypes: true,
    })) {
      if (e.isDirectory()) dirs.push(path.join(root, base, e.name));
    }
  }
  return dirs.filter((d) => {
    try {
      readPkg(d);
      return true;
    } catch {
      return false;
    }
  });
}

describe("workspace versions", () => {
  it("every workspace shares the site's version", () => {
    const site = readPkg(path.join(root, "sites/web")).version;
    const dirs = workspaceDirs();
    expect(dirs.length).toBeGreaterThan(5);
    for (const dir of dirs) {
      const pkg = readPkg(dir);
      expect([pkg.name, pkg.version]).toEqual([pkg.name, site]);
    }
  });
});
