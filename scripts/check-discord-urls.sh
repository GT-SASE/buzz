#!/usr/bin/env bash
# Fails if a tracked file outside the Discord client and tests names a Discord
# host. ESLint covers the same ground for code, in more depth, but does not read
# shell scripts, workflows or other files.
#
# The excluded shell scripts hold canaries for the secret rules, built to look
# like real Discord URLs.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

status=0
git grep -nIiE 'discord(app)?\.com|discord\.gg' -- . \
  ':(exclude)src/discord/client.ts' \
  ':(exclude,glob)**/*.test.ts' \
  ':(exclude,glob)**/*.test.tsx' \
  ':(exclude,glob)**/*.test.mts' \
  ':(exclude,glob)**/*.test.cts' \
  ':(exclude,glob)**/*.test.js' \
  ':(exclude,glob)**/*.test.jsx' \
  ':(exclude,glob)**/*.test.mjs' \
  ':(exclude,glob)**/*.test.cjs' \
  ':(exclude,glob)scripts/test-*.sh' || status=$?

case "${status}" in
  0)
    echo "check-discord-urls: only src/discord/client.ts should name a Discord host" >&2
    exit 1
    ;;
  1) ;; # git grep found nothing.
  *)
    echo "check-discord-urls: git grep failed" >&2
    exit "${status}"
    ;;
esac
