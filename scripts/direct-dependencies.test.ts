import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageFile {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

const packageFile = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageFile;

// Every runtime dependency sees all the secrets, and a lookalike name is a known
// attack, so adding one should be a visible decision in review.
const RUNTIME = [
  "@supabase/postgrest-js",
  "@vercel/functions",
  "discord-api-types",
];

const DEVELOPMENT = [
  "@electric-sql/pglite",
  "@eslint/js",
  "@types/node",
  "@types/pg",
  "eslint",
  "pg",
  "prettier",
  "typescript",
  "typescript-eslint",
  "vitest",
];

const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

const REGISTRY = "https://registry.npmjs.org";
// A lockfile key, which may nest. Each name starts with a letter or digit, so that
// "..", which a URL would resolve away, cannot stand in for one.
const PACKAGE_NAME = String.raw`(?:@[a-z0-9][\w.~-]*\/)?[a-zA-Z0-9][\w.~-]*`;
const LOCK_KEY = new RegExp(
  `^node_modules/(?:${PACKAGE_NAME}/node_modules/)*(${PACKAGE_NAME})$`,
);
const LOCK_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  name?: string;
}

interface LockFile {
  lockfileVersion?: number;
  dependencies?: unknown;
  packages?: Record<string, LockEntry>;
}

function entryProblem(key: string, entry: LockEntry): string | null {
  const name = LOCK_KEY.exec(key)?.[1];
  if (name === undefined) {
    return "is not a package under node_modules";
  }
  if (entry.link !== undefined) {
    return "is a link";
  }
  if (entry.name !== undefined) {
    return "is an alias";
  }
  if (entry.version === undefined || !LOCK_VERSION.test(entry.version)) {
    return "has no exact version";
  }
  const file = `${name.slice(name.lastIndexOf("/") + 1)}-${entry.version}.tgz`;
  if (entry.resolved !== `${REGISTRY}/${name}/-/${file}`) {
    return "does not resolve to its own file on the registry";
  }
  if (entry.integrity === undefined || !SHA512.test(entry.integrity)) {
    return "has no sha512 integrity";
  }
  return null;
}

/**
 * Why a lockfile would install something other than the published package it names.
 * Vercel bundles what the lockfile resolves to, and that code sees every runtime
 * secret, so one edited entry must not pass unnoticed. npm refuses a tarball that does
 * not match its integrity, so holding the URL to the name and version is enough. An
 * entry this does not recognise, such as a bundled dependency, fails until someone
 * looks at it.
 */
function lockfileProblems(lock: LockFile): string[] {
  const problems: string[] = [];
  if (lock.lockfileVersion !== 3) {
    problems.push("lockfileVersion must be 3");
  }
  // Version 3 has only `packages`. Another section would go unchecked.
  if (lock.dependencies !== undefined) {
    problems.push("the old dependencies section is not expected");
  }
  const entries = Object.entries(lock.packages ?? {}).filter(
    ([key]) => key !== "",
  );
  if (entries.length === 0) {
    problems.push("no packages are listed");
  }
  for (const [key, entry] of entries) {
    const problem = entryProblem(key, entry);
    if (problem !== null) {
      problems.push(`${key} ${problem}`);
    }
  }
  return problems;
}

describe("direct dependencies", () => {
  it("has only the allowed runtime packages", () => {
    expect(Object.keys(packageFile.dependencies).sort()).toEqual(RUNTIME);
  });

  it("has only the allowed development packages", () => {
    expect(Object.keys(packageFile.devDependencies).sort()).toEqual(
      DEVELOPMENT,
    );
  });

  it("pins every package to an exact version", () => {
    const versions = Object.values({
      ...packageFile.dependencies,
      ...packageFile.devDependencies,
    });

    expect(versions.filter((version) => !EXACT_VERSION.test(version))).toEqual(
      [],
    );
  });
});

describe("lockfile entries", () => {
  const integrity = `sha512-${"A".repeat(86)}==`;
  const key = "node_modules/@scope/pkg";
  const good: LockEntry = {
    version: "1.2.3",
    resolved: `${REGISTRY}/@scope/pkg/-/pkg-1.2.3.tgz`,
    integrity,
  };

  function problemsWith(entryKey: string, entry: LockEntry) {
    return lockfileProblems({
      lockfileVersion: 3,
      packages: { "": {}, [entryKey]: entry },
    });
  }

  it("passes the repository's own lockfile", () => {
    const lock = JSON.parse(
      readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
    ) as LockFile;

    expect(lockfileProblems(lock)).toEqual([]);
  });

  it.each<[string, string, LockEntry]>([
    ["a scoped package", key, good],
    [
      "a nested package",
      "node_modules/a/node_modules/plain",
      { ...good, resolved: `${REGISTRY}/plain/-/plain-1.2.3.tgz` },
    ],
    [
      "a prerelease",
      "node_modules/plain",
      {
        ...good,
        version: "1.2.3-rc.1",
        resolved: `${REGISTRY}/plain/-/plain-1.2.3-rc.1.tgz`,
      },
    ],
  ])("allows %s", (_label, entryKey, entry) => {
    expect(problemsWith(entryKey, entry)).toEqual([]);
  });

  it.each<[string, LockEntry]>([
    ["another host", { ...good, resolved: "http://127.0.0.1/pkg-1.2.3.tgz" }],
    [
      "a registry lookalike",
      {
        ...good,
        resolved: `${REGISTRY}.example/@scope/pkg/-/pkg-1.2.3.tgz`,
      },
    ],
    [
      "another package's file",
      { ...good, resolved: `${REGISTRY}/evil/-/evil-1.2.3.tgz` },
    ],
    [
      "another version's file",
      { ...good, resolved: `${REGISTRY}/@scope/pkg/-/pkg-1.2.4.tgz` },
    ],
    ["a git source", { ...good, resolved: "git+https://example.test/pkg.git" }],
    ["no resolved URL", { version: "1.2.3", integrity }],
    ["no integrity", { version: "1.2.3", resolved: good.resolved ?? "" }],
    ["a weaker hash", { ...good, integrity: `sha1-${"A".repeat(27)}=` }],
    ["a link", { ...good, link: true }],
    ["an alias", { ...good, name: "evil" }],
    [
      "a version that walks the URL",
      {
        ...good,
        version: "1.2.3/../../evil",
        resolved: `${REGISTRY}/@scope/pkg/-/pkg-1.2.3/../../evil.tgz`,
      },
    ],
  ])("refuses %s", (_label, entry) => {
    expect(problemsWith(key, entry)).toHaveLength(1);
  });

  it.each([
    ["a workspace or link target", "packages/local"],
    ["a name that walks the URL", "node_modules/../evil"],
  ])("refuses %s", (_label, badKey) => {
    expect(problemsWith(badKey, good)).toHaveLength(1);
  });

  it("refuses a lockfile the check would not cover", () => {
    expect(lockfileProblems({ lockfileVersion: 2 })).toHaveLength(2);
    expect(
      lockfileProblems({
        lockfileVersion: 3,
        dependencies: {},
        packages: { [key]: good },
      }),
    ).toHaveLength(1);
  });
});
