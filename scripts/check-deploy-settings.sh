#!/usr/bin/env bash
# Fails if a setting that decides what a Vercel deployment installs or publishes has
# changed. The deploy check runs this before it builds anything.
#
# Vercel's function build ignores installCommand, so .npmrc is what keeps package
# install scripts away from the project's environment variables. npm uses the last
# value in the file, and reads other settings there too, such as the registry, so the
# whole file has to match. Its own answer is then checked as well, since it is what the
# install will do.
#
# A package.json in a subdirectory makes the install run from there, with its own
# scripts and dependencies, and another lockfile takes over from package-lock.json or
# picks another package manager. Either would step around these checks and the checks
# on the lockfile in scripts/direct-dependencies.test.ts.
#
# Vercel does run a buildCommand from vercel.json, which could turn install scripts back
# on or run anything else with the project's variables. The project builds without one,
# so vercel.json may not set any command.
#
# Previews hold no secrets, but only main and staging are meant to deploy at all.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

status=0

fail() {
  echo "check-deploy-settings: $1" >&2
  status=1
}

if [ ! -f .npmrc ] || [ "$(cat .npmrc)" != "ignore-scripts=true" ]; then
  fail ".npmrc must hold only the line ignore-scripts=true"
fi

if [ "$(npm config get ignore-scripts)" != "true" ]; then
  fail "npm config get ignore-scripts must print true"
fi

# With -z, git does not quote a path that holds a non-ASCII character.
stray="$(git ls-files -z | tr '\0' '\n' | grep -E '(^|/)(package\.json|package-lock\.json|\.npmrc|\.yarnrc|\.yarnrc\.yml|bunfig\.toml|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?|deno\.lock)$' | grep -vxE 'package\.json|package-lock\.json|\.npmrc' || true)"
if [ -n "${stray}" ]; then
  fail "only the root may hold install settings, but these are tracked:"
  echo "${stray}" >&2
fi

if ! node --input-type=module --eval '
  import { readFileSync } from "node:fs";
  const { git } = JSON.parse(readFileSync("vercel.json", "utf8"));
  const found = JSON.stringify(git?.deploymentEnabled);
  const expected = JSON.stringify({ "**": false, main: true, staging: true });
  if (found !== expected) {
    process.exit(1);
  }
'; then
  fail "vercel.json must deploy main and staging and nothing else"
fi

if ! node --input-type=module --eval '
  import { readFileSync } from "node:fs";
  const settings = JSON.parse(readFileSync("vercel.json", "utf8"));
  if (Object.keys(settings).some((name) => /command$/i.test(name))) {
    process.exit(1);
  }
'; then
  fail "vercel.json must not set a command, such as buildCommand"
fi

exit "${status}"
