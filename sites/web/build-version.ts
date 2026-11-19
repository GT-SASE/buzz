import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

type Git = (...args: string[]) => string;

export type Build = { version: string; commit: string };

const dir = import.meta.dirname;

const runGit: Git = (...args) =>
  execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();

/**
 * Build version `MAJOR.MINOR.PATCH`. MAJOR and MINOR are set by hand in this
 * package's package.json. PATCH counts merges into main since that version
 * line last changed, so every deploy adds one; at 100 it rolls into MINOR to
 * stay two digits. Vercel clones with depth 1, which has no history to count,
 * so a shallow clone is deepened from the public repo first.
 */
export function appBuild(
  version: string = (
    JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
      version: string;
    }
  ).version,
  git: Git = runGit,
): Build {
  const [major, minor] = version.split(".").map(Number);
  let commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "";
  try {
    commit = git("rev-parse", "--short", "HEAD");
  } catch {
    return { version, commit };
  }
  try {
    if (git("rev-parse", "--is-shallow-repository") === "true") {
      git(
        "fetch",
        "--quiet",
        "--unshallow",
        "https://github.com/GT-SASE/buzz.git",
        "HEAD",
      );
    }
    const base = git(
      "log",
      "-1",
      "--format=%H",
      "-G^\\s*.version.:",
      "--",
      "package.json",
    );
    const range = base ? ["HEAD", `^${base}`] : ["HEAD"];
    const merges = Number(
      git("rev-list", "--first-parent", "--count", ...range),
    );
    return {
      version: `${major}.${minor! + Math.floor(merges / 100)}.${merges % 100}`,
      commit,
    };
  } catch (e) {
    const err = e as { stderr?: Buffer; message: string };
    // Loud on purpose: on Vercel's shallow clone a failed deepen lands here,
    // and the build still passes, so the version would freeze unseen.
    const detail = err.stderr?.toString().trim() ?? "";
    console.warn(
      `[version] could not count merges, reporting ${version}: ${detail.length > 0 ? detail : err.message}`,
    );
    return { version, commit };
  }
}
