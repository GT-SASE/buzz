/**
 * Checks commit messages and a pull request title against Conventional Commits.
 *
 * Every branch commit has to meet the rules, because a trailer or a bad message
 * should never reach main.
 *
 * Usage:
 *   node scripts/check-commit-messages.ts --range <base>..<head>
 *   node scripts/check-commit-messages.ts --title="<pull request title>"
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const TYPES = "build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test";
const HEADER = new RegExp(
  `^(?:${TYPES})(?:\\([a-z0-9][a-z0-9._/-]*\\))?!?: \\S(?:.*\\S)?$`,
);
const MAX_HEADER_LENGTH = 100;

// Matches anywhere in the message, not only in the final trailer block, because
// a misplaced trailer is still an authorship claim worth stopping.
const CO_AUTHOR_LINE = /^[ \t]*co-authored-by[ \t]*:/im;

export function checkHeader(header: string): string[] {
  const problems: string[] = [];
  if (!HEADER.test(header)) {
    problems.push(
      `"${header}" does not match "type(optional-scope): subject", with type one of ${TYPES.replaceAll("|", ", ")}`,
    );
  }
  if (header.length > MAX_HEADER_LENGTH) {
    problems.push(
      `header is ${String(header.length)} characters, the limit is ${String(MAX_HEADER_LENGTH)}`,
    );
  }
  return problems;
}

export function checkCommitMessage(message: string): string[] {
  const [header = "", secondLine = ""] = message.split("\n");
  const problems = checkHeader(header);
  if (secondLine !== "") {
    problems.push("the header must be followed by a blank line");
  }
  if (CO_AUTHOR_LINE.test(message)) {
    problems.push("Co-authored-by trailers are not allowed");
  }
  return problems;
}

interface Commit {
  sha: string;
  message: string;
}

function readCommits(range: string): Commit[] {
  const output = execFileSync(
    "git",
    ["log", "-z", "--format=%H%n%B", "--end-of-options", range],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return output
    .split("\0")
    .filter((record) => record !== "")
    .map((record) => {
      const [sha = "", ...message] = record.split("\n");
      return { sha, message: message.join("\n") };
    });
}

function main(): number {
  const { values } = parseArgs({
    options: {
      range: { type: "string" },
      title: { type: "string" },
    },
  });

  if (values.range === undefined && values.title === undefined) {
    console.error("Pass --range <base>..<head>, --title=<title>, or both.");
    return 1;
  }

  let failed = false;

  const report = (label: string, problems: string[]): void => {
    if (problems.length === 0) {
      console.log(`ok    ${label}`);
      return;
    }
    failed = true;
    for (const problem of problems) {
      console.error(`FAIL  ${label}: ${problem}`);
    }
  };

  if (values.title !== undefined) {
    report("pull request title", checkHeader(values.title));
  }

  if (values.range !== undefined) {
    const commits = readCommits(values.range);
    // An empty range means the check looked at nothing, which must not pass.
    if (commits.length === 0) {
      console.error(`FAIL  no commits found in ${values.range}`);
      failed = true;
    }
    for (const commit of commits) {
      report(
        `commit ${commit.sha.slice(0, 12)}`,
        checkCommitMessage(commit.message),
      );
    }
  }

  return failed ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
