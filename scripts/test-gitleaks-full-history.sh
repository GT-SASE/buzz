#!/usr/bin/env bash
#
# Regression test for scripts/gitleaks-full-history.sh. Each case builds a small
# temporary repository and asserts that the scan passes or fails as expected.
# Fake values are assembled at runtime so that this file never looks like it
# holds a secret.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly repo_root

if [[ ! -x "${repo_root}/.tools/gitleaks" ]]; then
  echo "test-gitleaks-full-history: gitleaks not found. Run: npm run gitleaks:install" >&2
  exit 1
fi

# Isolate from the caller's git settings and any hook environment.
# shellcheck source=scripts/lib/git-test-env.sh
source "${repo_root}/scripts/lib/git-test-env.sh"

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT

failures=0
checks=0
case_number=0
pinned="$(cat "${repo_root}/.gitleaks-version")"
readonly pinned

random_hex() {
  local hex
  hex="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
  printf '%s' "${hex:0:$1}"
}

# Only the custom config matches this one.
custom_value() {
  printf 'sb_%s_%s' secret "$(random_hex 40)"
}

# Only the default config matches this one.
default_value() {
  printf 'gh%s_%s' p "$(random_hex 36)"
}

new_repo() {
  case_number=$((case_number + 1))
  local repo="${work_dir}/case-${case_number}"
  mkdir -p "${repo}/scripts/lib" "${repo}/.tools"
  cp "${repo_root}/.gitleaks.toml" "${repo_root}/.gitleaks-custom.toml" \
    "${repo_root}/.gitleaks-version" "${repo}/"
  cp "${repo_root}/scripts/gitleaks-full-history.sh" "${repo}/scripts/"
  cp "${repo_root}/scripts/lib/gitleaks.sh" "${repo}/scripts/lib/"
  ln -s "${repo_root}/.tools/gitleaks" "${repo}/.tools/gitleaks"
  printf '.tools/\n' >"${repo}/.gitignore"
  cd "${repo}"
  git init -q -b main
  git config user.name "Test User"
  git config user.email "test-user@users.noreply.github.com"
  git config commit.gpgsign false
  git add -A
  git commit -qm "chore: base"
}

commit_file() {
  printf '%s\n' "$2" >"$1"
  git add -f -- "$1"
  git commit -qm "chore: change ${1}"
}

# Replaces the binary with a stub that reports the pinned version, then runs $1
# for each scan.
stub_gitleaks() {
  rm .tools/gitleaks
  printf '#!/bin/sh\nif [ "$1" = version ]; then echo %s; exit 0; fi\n%s\n' "${pinned}" "$1" >.tools/gitleaks
  chmod 755 .tools/gitleaks
}

expect_pass() {
  local output rc=0
  checks=$((checks + 1))
  output="$(bash scripts/gitleaks-full-history.sh 2>&1)" || rc=$?
  if ((rc == 0)) && grep -q 'No secrets found' <<<"${output}"; then
    echo "PASS  passes: $1"
  else
    failures=$((failures + 1))
    echo "FAIL  $1: expected a pass, got exit ${rc}" >&2
  fi
}

# expect_fail <label> <extended regex the output must match> [value not to print]
expect_fail() {
  local output rc=0
  checks=$((checks + 1))
  output="$(bash scripts/gitleaks-full-history.sh 2>&1)" || rc=$?
  if ((rc == 0)); then
    failures=$((failures + 1))
    echo "FAIL  $1: the scan passed" >&2
  elif ! grep -qE "$2" <<<"${output}"; then
    failures=$((failures + 1))
    echo "FAIL  $1: failed for the wrong reason" >&2
  elif [[ -n "${3:-}" ]] && grep -qF "$3" <<<"${output}"; then
    failures=$((failures + 1))
    echo "FAIL  $1: the value appeared in the output" >&2
  else
    echo "PASS  fails: $1"
  fi
}

new_repo
expect_pass "clean history"

echo "--- commit contents"
new_repo; value="$(custom_value)"
git switch -q -c side
commit_file token.txt "key = ${value}"
git rm -q token.txt; git commit -qm "chore: remove token"
git switch -q main
expect_fail "custom rule, removed again, on a branch that is not checked out" 'RuleID: +supabase-secret-key' "${value}"

new_repo; value="$(default_value)"
commit_file token.txt "key = ${value}"
expect_fail "default rule" 'RuleID: +github-pat' "${value}"

new_repo; value="$(custom_value)"
commit_file package-lock.json "{\"key\": \"${value}\"}"
expect_fail "custom rule in a file the default allowlist excuses" 'RuleID: +supabase-secret-key' "${value}"

new_repo; value="$(custom_value)"
git switch -q -c side
commit_file a.txt "a"
git switch -q main
commit_file b.txt "b"
git merge -q --no-ff --no-commit side >/dev/null 2>&1
printf 'key = %s\n' "${value}" >merged.txt
git add merged.txt; git commit -qm "chore: merge side"
expect_fail "secret only in a merge commit" 'RuleID: +supabase-secret-key' "${value}"

new_repo; value="$(custom_value)"
printf 'text\000\nkey = %s\n' "${value}" >notes.txt
git add notes.txt; git commit -qm "chore: add notes"
expect_fail "text file with a NUL byte" 'RuleID: +supabase-secret-key' "${value}"

new_repo; value="$(custom_value)"
commit_file allow.txt "key = ${value} # gitleaks:allow"
expect_fail "inline gitleaks:allow comment" 'RuleID: +supabase-secret-key' "${value}"

echo "--- commit messages"
new_repo; value="$(custom_value)"
git commit -q --allow-empty -m "chore: note ${value}"
expect_fail "custom rule in a commit message" 'RuleID: +supabase-secret-key' "${value}"

new_repo; value="$(default_value)"
git commit -q --allow-empty -m "chore: note" -m "key = ${value}"
expect_fail "default rule in a commit message" 'RuleID: +github-pat' "${value}"

new_repo; value="$(custom_value)"
git switch -q -c side
git commit -q --allow-empty -m "chore: note ${value}"
git switch -q main
expect_fail "commit message on a branch that is not checked out" 'RuleID: +supabase-secret-key' "${value}"

echo "--- denied paths"
for path in members.csv tasks.csv.gz dump.sql sub/.env .pgpass backup/dump.psql; do
  new_repo
  mkdir -p "$(dirname "${path}")"
  commit_file "${path}" "harmless"
  expect_fail "denied path ${path}" 'denied path'
done

new_repo
commit_file tasks.csv.gz "harmless"
git rm -q tasks.csv.gz; git commit -qm "chore: remove the dump"
expect_fail "denied path added then removed" 'denied path'

new_repo
git switch -q -c side
commit_file members.csv "harmless"
git switch -q main
expect_fail "denied path on a branch that is not checked out" 'denied path'

new_repo
git switch -q -c side
commit_file members.csv "harmless"
git tag only-tagged
git switch -q main
git branch -qD side
expect_fail "denied path reachable only from a tag" 'denied path'

new_repo
mkdir -p supabase/migrations
commit_file supabase/migrations/001_init.sql "select 1;"
commit_file .env.example "DISCORD_APP_ID="
expect_pass "a migration and the env template"

new_repo; person_email="$(printf 'a.person%smail' '@').org"
# The message leaves the address out, so that only the path scan can find it.
printf 'harmless\n' >"notes-${person_email}.txt"
git add -- "notes-${person_email}.txt"
git commit -qm "chore: add notes"
expect_fail "email address in a path" 'RuleID: +email-address' "${person_email}"

new_repo
printf 'harmless\n' >"${person_email}.csv"
git add -f -- "${person_email}.csv"
git commit -qm "chore: add notes"
expect_fail "email address in a denied path is not printed" 'RuleID: +email-address' "${person_email}"

echo "--- identities"
person_email="$(printf 'a.person%smail' '@').org"

new_repo
GIT_AUTHOR_EMAIL="${person_email}" git commit -q --allow-empty -m "chore: note"
expect_fail "author email that is not a no-reply address" 'author email' "${person_email}"

new_repo
git switch -q -c side
GIT_AUTHOR_EMAIL="${person_email}" git commit -q --allow-empty -m "chore: note"
git switch -q main
expect_fail "author email on a branch that is not checked out" 'author email' "${person_email}"

new_repo; value="$(custom_value)"
GIT_AUTHOR_NAME="${value}" git commit -q --allow-empty -m "chore: note"
expect_fail "secret in an author name" 'RuleID: +supabase-secret-key' "${value}"

new_repo; value="$(custom_value)"
GIT_COMMITTER_NAME="${value}" git commit -q --allow-empty -m "chore: note"
expect_fail "secret in a committer name" 'RuleID: +supabase-secret-key' "${value}"

new_repo
GIT_COMMITTER_EMAIL="$(printf 'noreply%sgithub' '@').com" git commit -q --allow-empty -m "chore: note"
expect_pass "GitHub's web commit identity"

# Warned about rather than failed: see committer_email_policy in the scan script.
new_repo
GIT_COMMITTER_EMAIL="${person_email}" git commit -q --allow-empty -m "chore: note"
checks=$((checks + 1))
rc=0
output="$(bash scripts/gitleaks-full-history.sh 2>&1)" || rc=$?
if ((rc != 0)); then
  failures=$((failures + 1))
  echo "FAIL  committer email: expected a warning, got exit ${rc}" >&2
elif ! grep -q "::warning::commit $(git rev-parse --short HEAD) has a committer email" <<<"${output}"; then
  failures=$((failures + 1))
  echo "FAIL  committer email: no warning" >&2
elif grep -qF "${person_email}" <<<"${output}"; then
  failures=$((failures + 1))
  echo "FAIL  committer email: the address appeared in the output" >&2
else
  echo "PASS  warns: committer email that is not a no-reply address"
fi

echo "--- tags"
new_repo; value="$(custom_value)"
git tag -a v-message -m "release ${value}"
expect_fail "custom rule in a tag message" 'RuleID: +supabase-secret-key' "${value}"

new_repo; value="$(default_value)"
git tag -a v-message -m "release" -m "key = ${value}"
expect_fail "default rule in a tag message" 'RuleID: +github-pat' "${value}"

new_repo
git tag -a v-message -m "contact ${person_email}" 2>/dev/null
expect_fail "email address in a tag message" 'RuleID: +email-address' "${person_email}"

new_repo
GIT_COMMITTER_EMAIL="${person_email}" git tag -a v-tagger -m "release"
expect_fail "tagger email that is not a no-reply address" 'tagger email' "${person_email}"

new_repo; value="$(custom_value)"
git tag -a v-inner -m "release ${value}"
git tag -a v-outer -m "release" v-inner
git tag -d v-inner >/dev/null
expect_fail "secret in a tag reached through another tag" 'RuleID: +supabase-secret-key' "${value}"

new_repo
blob="$(printf 'guild = 1%017d\ncontact %s\n' 42 "${person_email}" | git hash-object -w --stdin)"
git tag a-blob "${blob}"
expect_fail "tag of a blob holding an ID and an address" 'does not point to a commit' "${person_email}"

new_repo
blob="$(printf 'harmless\n' | git hash-object -w --stdin)"
tree="$(printf '100644 blob %s\tmembers.csv\n' "${blob}" | git mktree)"
git tag a-tree "${tree}"
expect_fail "tag of a tree" 'does not point to a commit'

new_repo
blob="$(printf 'harmless\n' | git hash-object -w --stdin)"
git tag -a v-blob -m "release" "${blob}"
expect_fail "annotated tag of a blob" 'does not point to a commit'

new_repo
tree="$(git rev-parse 'HEAD^{tree}')"
git tag -a v-tree -m "release" "${tree}"
expect_fail "annotated tag of a tree" 'does not point to a commit'

new_repo
blob="$(printf 'harmless\n' | git hash-object -w --stdin)"
git tag -a v-inner -m "release" "${blob}"
git tag -a v-outer -m "release" v-inner
git tag -d v-inner >/dev/null
expect_fail "tag of a blob reached through another tag" 'does not point to a commit'

new_repo
git tag v-light
git tag -a v-clean -m "release"
git tag -a v-outer -m "release" v-clean
expect_pass "clean lightweight, annotated and nested tags"

echo "--- setup"
new_repo
printf 'ignored\n' >.gitleaksignore
expect_fail ".gitleaksignore in the working tree" 'gitleaksignore exists'

new_repo
ln -s /dev/null .gitleaksignore
expect_fail ".gitleaksignore as a symlink" 'gitleaksignore exists'

new_repo
git clone -q --depth 1 "file://${PWD}" "${PWD}-shallow"
mkdir "${PWD}-shallow/.tools"
ln -s "${repo_root}/.tools/gitleaks" "${PWD}-shallow/.tools/gitleaks"
cd "${PWD}-shallow"
expect_fail "shallow clone" 'shallow clone'

new_repo
rm .gitleaks-custom.toml
expect_fail "custom config missing" 'missing \.gitleaks-custom\.toml'

new_repo
rm .gitleaks.toml
expect_fail "default config missing" 'missing \.gitleaks\.toml'

echo "--- broken tooling"
new_repo
rm .tools/gitleaks
expect_fail "gitleaks missing" 'not installed'

new_repo
printf '0.0.0\n' >.gitleaks-version
expect_fail "binary differs from .gitleaks-version" 'is pinned'

new_repo
stub_gitleaks 'exit 2'
expect_fail "content scan failing" 'finding or failed'

new_repo
stub_gitleaks '[ "$1" = stdin ] && exit 2; exit 0'
expect_fail "message scan failing" 'finding or failed'

new_repo
stub_gitleaks '[ "$1" = git ] && echo "1:00AM ERR scan failed"; exit 0'
expect_fail "content scan logging an error but exiting 0" 'reported an error'

new_repo
stub_gitleaks '[ "$1" = stdin ] && echo "1:00AM FTL scan failed"; exit 0'
expect_fail "message scan logging an error but exiting 0" 'reported an error'

if ((failures > 0)); then
  echo "${failures} of ${checks} history scan checks failed." >&2
  exit 1
fi
echo "All ${checks} history scan checks passed."
