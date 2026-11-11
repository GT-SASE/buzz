#!/usr/bin/env bash
#
# Regression test for the pre-push hook. Builds a temporary repository from the
# tracked files, pushes to a temporary bare remote, and asserts that each case
# is blocked or allowed. Nothing leaves the temp directory. Fake values are
# assembled at runtime so that this file never looks like it holds a secret.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly repo_root

if [[ ! -x "${repo_root}/.tools/gitleaks" ]]; then
  echo "test-pre-push-hook: gitleaks not found. Run: npm run gitleaks:install" >&2
  exit 1
fi

# Isolate from the caller's git settings and any hook environment.
# shellcheck source=scripts/lib/git-test-env.sh
source "${repo_root}/scripts/lib/git-test-env.sh"

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT
readonly repo="${work_dir}/repo"
readonly bare="${work_dir}/remote.git"

readonly author_email="test-user@users.noreply.github.com"
readonly secret_rule='RuleID: +supabase-secret-key'
readonly blocked_message='this push is blocked'

failures=0
checks=0
case_number=0
last_value=""

random_hex() {
  local hex
  hex="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
  printf '%s' "${hex:0:$1}"
}

# Sets last_value to a fresh fake key.
new_value() {
  last_value="$(printf 'sb_%s_' secret)$(random_hex 40)"
}

pass() {
  checks=$((checks + 1))
  echo "PASS  $1"
}

fail() {
  checks=$((checks + 1))
  failures=$((failures + 1))
  echo "FAIL  $1" >&2
}

reset_case() {
  git switch -q --force main
  git clean -fdq
  git for-each-ref --format='%(refname:short)' refs/heads \
    | { grep -v '^main$' || true; } | while read -r branch; do git branch -qD "${branch}"; done
  git tag -l | while read -r tag; do git tag -d "${tag}" >/dev/null; done
  git config --unset-all color.ui || true
  git config --unset-all diff.strip.textconv || true
}

new_case() {
  reset_case
  case_number=$((case_number + 1))
  case_branch="case-${case_number}"
  git switch -q -c "${case_branch}"
}

# Writes a file and commits it, force-adding so ignore rules do not interfere.
commit_file() {
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >"$1"
  git add -f -- "$1"
  git commit -qm "chore: change ${1}"
}

# expect_blocked <label> <extended regex the output must match> <push args...>
expect_blocked() {
  local label="$1" pattern="$2" before after output rc=0
  shift 2
  before="$(git ls-remote "${bare}")"
  output="$(git push "$@" 2>&1)" || rc=$?
  after="$(git ls-remote "${bare}")"
  if ((rc == 0)); then
    fail "${label}: push was allowed"
  elif [[ "${before}" != "${after}" ]]; then
    fail "${label}: the remote changed"
  elif ! grep -q "${blocked_message}" <<<"${output}"; then
    fail "${label}: failed, but not because of the hook"
  elif ! grep -qE "${pattern}" <<<"${output}"; then
    fail "${label}: blocked for the wrong reason"
  elif [[ -n "${last_value}" ]] && grep -qF "${last_value}" <<<"${output}"; then
    fail "${label}: the value appeared in the output"
  else
    pass "blocked: ${label}"
  fi
}

# expect_allowed <label> <push args...>
expect_allowed() {
  local label="$1" output rc=0
  shift
  output="$(git push "$@" 2>&1)" || rc=$?
  if ((rc == 0)); then
    pass "allowed: ${label}"
  else
    fail "${label}: push was blocked"
    grep -E 'pre-push:|RuleID:' <<<"${output}" >&2 || true
  fi
}

# Runs the scan script directly, with stdin already set up by the caller.
run_script_rc() {
  local rc=0
  bash scripts/gitleaks-pre-push.sh "$@" >/dev/null 2>&1 || rc=$?
  echo "${rc}"
}

setup_repo() {
  git init -q --bare -b main "${bare}"
  git init -q -b main "${repo}"
  local path
  while IFS= read -r -d '' path; do
    [[ -f "${repo_root}/${path}" ]] || continue
    mkdir -p "${repo}/$(dirname "${path}")"
    cp -p "${repo_root}/${path}" "${repo}/${path}"
  done < <(git -C "${repo_root}" ls-files -z --cached --others --exclude-standard)

  cd "${repo}"
  mkdir -p .tools
  ln -s "${repo_root}/.tools/gitleaks" .tools/gitleaks
  git config user.name "Test User"
  git config user.email "${author_email}"
  git config commit.gpgsign false
  git config tag.gpgsign false
  git remote add origin "${bare}"
  install_hooks
  git add -A
  git commit -qm "chore: base"
}

install_hooks() {
  npm run -s hooks:install
}

setup_repo
[[ "$(git config core.hooksPath)" == ".githooks" ]] && pass "hooks:install sets core.hooksPath" \
  || fail "hooks:install did not set core.hooksPath"
# Upstream on main, as in a normal clone, so that @{push} resolves.
expect_allowed "clean first push of the whole project" -u origin main

echo "--- pushes that do not change the working tree"
new_case; new_value
commit_file token.txt "key = ${last_value}"
git rm -q token.txt; git commit -qm "chore: remove token"
expect_blocked "secret added then removed" "${secret_rule}" origin "${case_branch}"

new_case; last_value=""
commit_file clean.txt "clean"
expect_allowed "clean branch with an upstream" -u origin "${case_branch}"
new_value
commit_file token.txt "key = ${last_value}"
git rm -q token.txt; git commit -qm "chore: remove token"
expect_blocked "secret added then removed on a tracked branch" "${secret_rule}" origin "${case_branch}"

new_case; new_value
commit_file token.txt "key = ${last_value}"
git switch -q main
expect_blocked "git push origin <branch> from clean main" "${secret_rule}" origin "${case_branch}"

new_case; new_value
commit_file token.txt "key = ${last_value}"
git switch -q main
expect_blocked "git push --all" "${secret_rule}" --all origin

new_case; new_value
commit_file token.txt "key = ${last_value}"
git tag -a v-annotated -m "release"
git switch -q main; git branch -qD "${case_branch}"
expect_blocked "annotated tag" "${secret_rule}" origin v-annotated

new_case; new_value
commit_file token.txt "key = ${last_value}"
git tag v-light
git switch -q main; git branch -qD "${case_branch}"
expect_blocked "lightweight tag" "${secret_rule}" origin v-light

new_case; new_value
commit_file token.txt "key = ${last_value}"
expect_blocked "new branch pushed to a URL" "${secret_rule}" "${bare}" "${case_branch}"

new_case; last_value=""
commit_file clean.txt "clean"
expect_allowed "clean branch" origin "${case_branch}"
new_value
commit_file token.txt "key = ${last_value}"
expect_blocked "secret on top of a pushed branch" "${secret_rule}" origin "${case_branch}"

echo "--- content git log would normally hide"
new_case; new_value
commit_file a.txt "a"
git switch -q -c "${case_branch}-side" main
commit_file b.txt "b"
git switch -q "${case_branch}"
git merge -q --no-ff --no-commit "${case_branch}-side" >/dev/null 2>&1
printf 'key = %s\n' "${last_value}" >merged.txt
git add merged.txt; git commit -qm "chore: merge side"
expect_blocked "secret only in a merge commit" "${secret_rule}" origin "${case_branch}"

new_case; new_value
mkdir -p data; printf 'text\000\nkey = %s\n' "${last_value}" >data/notes.txt
git add data/notes.txt; git commit -qm "chore: add notes"
expect_blocked "text file with a NUL byte" "${secret_rule}" origin "${case_branch}"

new_case; new_value
commit_file .gitattributes "attr.txt -diff"
commit_file attr.txt "key = ${last_value}"
expect_blocked ".gitattributes with -diff" "${secret_rule}" origin "${case_branch}"

new_case; new_value
commit_file .gitattributes "conv.txt diff=strip"
git config diff.strip.textconv true
commit_file conv.txt "key = ${last_value}"
expect_blocked "textconv that hides content" "${secret_rule}" origin "${case_branch}"

new_case; new_value
git config color.ui always
commit_file token.txt "key = ${last_value}"
expect_blocked "color.ui=always" "${secret_rule}" origin "${case_branch}"

echo "--- files and values the default allowlist excuses"
new_case; new_value
commit_file package-lock.json "{\"key\": \"${last_value}\"}"
expect_blocked "secret in package-lock.json" "${secret_rule}" origin "${case_branch}"

new_case; new_value
commit_file firmware.bin "key = ${last_value}"
expect_blocked "secret in a .bin file" "${secret_rule}" origin "${case_branch}"

for word in false true null; do
  new_case; last_value="$(printf 'sb_%s_' secret)$(random_hex 20)${word}"
  commit_file token.txt "key = ${last_value}"
  expect_blocked "value containing ${word}" "${secret_rule}" origin "${case_branch}"
done

echo "--- real IDs and addresses"
last_value=""
new_case
commit_file ids.txt "guild = 1$(printf '%017d' 42)"
expect_blocked "number shaped like a Discord ID" 'RuleID: +discord-snowflake' origin "${case_branch}"

new_case; last_value="$(printf 'Winter%sClub' 2026)"
commit_file notes.txt "db.host.test:5432:postgres:app:${last_value}"
expect_blocked "line in the format of a password file" 'RuleID: +pgpass-line' origin "${case_branch}"

new_case; last_value="$(printf 'Winter%sClub' 2026)"
commit_file notes.txt "BACKUP_PGPASSWORD=${last_value}"
expect_blocked "low entropy backup password" 'RuleID: +named-secret-env-assignment' origin "${case_branch}"
last_value=""

new_case
commit_file people.txt "contact: $(printf 'a.person%smail' '@').org"
expect_blocked "real-looking email address" 'RuleID: +email-address' origin "${case_branch}"

new_case
commit_file allowed.txt "$(printf '%s\n' \
  "${author_email}" \
  "$(printf 'noreply%sgithub' '@').com" \
  "$(printf 'someone%sexample' '@').com" \
  "$(printf 'someone%sany' '@').invalid" \
  "$(printf 'someone%sany' '@').test")"
expect_allowed "no-reply and reserved addresses" origin "${case_branch}"

echo "--- path deny-list"
for path in .env .env.local .env-prod .ENV sub/.env prod.env env.local \
  dump.sql db/backup.sql data.sql.gz supabase/migrations/nested/x.sql \
  members.csv x.tsv x.jsonl x.xlsx x.pdf x.zip x.tar x.tgz x.tar.gz x.gz x.7z x.rar \
  x.sqlite x.sqlite3 x.db server.pem tls.key x.p12 age-identity.txt key.txt keys.txt \
  id_rsa credentials.json secrets.json service-account-x.json sub/.npmrc sub/dir/.NPMRC .netrc \
  "dir with space/.env" "dümp.sql" .gitleaksignore sub/.gitleaksignore \
  .pgpass sub/.pgpass pgpass.conf .pg_service.conf .git-credentials \
  x.psql x.pgsql backup/dump.psql x.xls x.ods x.ndjson backup-identity.txt; do
  new_case
  commit_file "${path}" "harmless"
  expect_blocked "path ${path}" 'denied path|gitleaksignore' origin "${case_branch}"
done

new_case
commit_file .gitleaksignore "harmless"
git rm -q .gitleaksignore; git commit -qm "chore: remove ignore file"
expect_blocked ".gitleaksignore only in pushed commits" 'denied path' origin "${case_branch}"

new_case
commit_file x.csv "harmless"
git rm -q x.csv; git commit -qm "chore: remove x.csv"
expect_blocked "denied path added then removed" 'denied path' origin "${case_branch}"

new_case
commit_file .env.example "DISCORD_APP_ID="
commit_file supabase/migrations/001_init.sql "select 1;"
commit_file src/index.ts "export {};"
commit_file tsconfig.json "{}"
commit_file package-lock.json "{}"
expect_allowed ".env.example, a migration and normal source" origin "${case_branch}"

new_case
commit_file backup/create-backup-role.psql "select 1;"
commit_file backup/grant-backup-role.psql "select 1;"
expect_allowed "the two backup role scripts" origin "${case_branch}"

# git add -A must not pick these up in the first place.
for path in .pgpass sub/.pgpass pgpass.conf .pg_service.conf .git-credentials .netrc \
  x.psql x.pgsql backup/dump.psql x.xls x.xlsx x.ods x.ndjson x.pdf \
  x.gz x.tar.gz x.bz2 x.xz x.7z x.rar backup-identity.txt; do
  if git check-ignore -q --no-index -- "${path}"; then
    pass "ignored: ${path}"
  else
    fail "${path}: not in .gitignore"
  fi
done
for path in backup/create-backup-role.psql backup/grant-backup-role.psql; do
  if git check-ignore -q --no-index -- "${path}"; then
    fail "${path}: ignored"
  else
    pass "not ignored: ${path}"
  fi
done

echo "--- root .npmrc"
new_case
commit_file .npmrc "$(printf 'ignore-scripts=true\nfund=false')"
expect_allowed "root .npmrc without a secret" origin "${case_branch}"

new_case; last_value="$(printf 'npm_%s' "$(random_hex 36)")"
commit_file .npmrc "//registry.npmjs.org/:_authToken=${last_value}"
expect_blocked "npm token in the root .npmrc" 'RuleID: +npm-access-token' origin "${case_branch}"

new_case; new_value
commit_file .npmrc "key = ${last_value}"
expect_blocked "project secret in the root .npmrc" "${secret_rule}" origin "${case_branch}"

echo "--- paths that hold private values"
new_case
person_path="notes-$(printf 'a.person%smail' '@').org.txt"
# The message leaves the address out, so that only the path scan can find it.
printf 'harmless\n' >"${person_path}"
git add -- "${person_path}"
git commit -qm "chore: add notes"
expect_blocked "email address in a path" 'RuleID: +email-address' origin "${case_branch}"

new_case
last_value="$(printf 'a.person%smail' '@').org"
printf 'harmless\n' >"${last_value}.csv"
git add -f -- "${last_value}.csv"
git commit -qm "chore: add notes"
expect_blocked "email address in a denied path is not printed" 'RuleID: +email-address' origin "${case_branch}"

echo "--- commit and tag metadata"
new_case; new_value
printf 'x\n' >m.txt; git add m.txt; git commit -qm "chore: note ${last_value}"
expect_blocked "secret in a commit message" "${secret_rule}" origin "${case_branch}"

new_case; new_value
printf 'x\n' >m.txt; git add m.txt
GIT_AUTHOR_NAME="${last_value}" git commit -qm "chore: add m"
expect_blocked "secret in an author name" "${secret_rule}" origin "${case_branch}"

new_case; new_value
git tag -a v-message -m "release ${last_value}"
expect_blocked "secret in a tag message" "${secret_rule}" origin v-message

last_value=""
person_email="$(printf 'a.person%smail' '@').org"
new_case
printf 'x\n' >m.txt; git add m.txt
GIT_AUTHOR_EMAIL="${person_email}" git commit -qm "chore: add m"
expect_blocked "non no-reply author email" 'author email' origin "${case_branch}"

new_case
printf 'x\n' >m.txt; git add m.txt
GIT_COMMITTER_EMAIL="${person_email}" git commit -qm "chore: add m"
expect_blocked "non no-reply committer email" 'committer email' origin "${case_branch}"

new_case
GIT_COMMITTER_EMAIL="${person_email}" git tag -a v-tagger -m "release"
expect_blocked "non no-reply tagger email" 'tagger email' origin v-tagger

new_case
git tag -a v-clean -m "release"
expect_allowed "clean annotated tag" origin v-clean

echo "--- refs and ignore files"
new_case
printf 'ignored\n' >.gitleaksignore
expect_blocked ".gitleaksignore in the working tree" 'gitleaksignore' origin "${case_branch}"
rm .gitleaksignore

new_case
blob="$(printf 'data\n' | git hash-object -w --stdin)"
expect_blocked "ref to a blob" 'does not point to a commit' origin "${blob}:refs/tags/a-blob"
tree="$(git rev-parse 'HEAD^{tree}')"
expect_blocked "ref to a tree" 'does not point to a commit' origin "${tree}:refs/tags/a-tree"
git tag -a v-blob -m "release" "${blob}"
expect_blocked "annotated tag of a blob" 'does not point to a commit' origin v-blob

new_case
commit_file clean.txt "clean"
expect_allowed "branch to delete later" origin "${case_branch}"
expect_allowed "up to date push" origin "${case_branch}"
expect_allowed "branch deletion" origin --delete "${case_branch}"

echo "--- hook input"
reset_case
head_sha="$(git rev-parse HEAD)"
rc="$(run_script_rc origin "${bare}" </dev/null)"
[[ "${rc}" == 1 ]] && pass "blocked: stdin is /dev/null" || fail "stdin /dev/null gave ${rc}"
rc="$(printf '' | run_script_rc)"
[[ "${rc}" == 1 ]] && pass "blocked: no arguments" || fail "no arguments gave ${rc}"
rc="$(printf 'garbage\n' | run_script_rc origin "${bare}")"
[[ "${rc}" == 1 ]] && pass "blocked: malformed ref line" || fail "malformed line gave ${rc}"
rc="$(printf 'refs/heads/x %s' "${head_sha}" | run_script_rc origin "${bare}")"
[[ "${rc}" == 1 ]] && pass "blocked: truncated ref line" || fail "truncated line gave ${rc}"
rc="$(printf '' | run_script_rc origin "${bare}")"
[[ "${rc}" == 0 ]] && pass "allowed: empty ref list from a pipe" || fail "empty pipe gave ${rc}"

echo "--- broken tooling"
new_case
commit_file clean.txt "clean"
real_gitleaks="$(readlink .tools/gitleaks)"
pinned="$(cat .gitleaks-version)"

rm .tools/gitleaks
expect_blocked "gitleaks missing" 'not installed' origin "${case_branch}"

printf '#!/bin/sh\necho 0.0.0\n' >.tools/gitleaks; chmod 755 .tools/gitleaks
expect_blocked "wrong gitleaks version" 'is pinned' origin "${case_branch}"

printf '#!/bin/sh\nif [ "$1" = version ]; then echo %s; exit 0; fi\nexit 2\n' "${pinned}" >.tools/gitleaks
expect_blocked "gitleaks failing" 'finding or failed' origin "${case_branch}"

printf '#!/bin/sh\nif [ "$1" = version ]; then echo %s; exit 0; fi\necho "1:00AM ERR scan failed"\nexit 0\n' "${pinned}" >.tools/gitleaks
expect_blocked "gitleaks logging an error but exiting 0" 'reported an error' origin "${case_branch}"

rm .tools/gitleaks; ln -s "${real_gitleaks}" .tools/gitleaks

mv .gitleaks-custom.toml "${work_dir}/custom.toml"
expect_blocked "custom config missing" 'missing' origin "${case_branch}"
mv "${work_dir}/custom.toml" .gitleaks-custom.toml

mv scripts/gitleaks-pre-push.sh "${work_dir}/hook.sh"
rc=0; git push origin "${case_branch}" >/dev/null 2>&1 || rc=$?
((rc != 0)) && pass "blocked: scan script missing" || fail "push succeeded with no scan script"
mv "${work_dir}/hook.sh" scripts/gitleaks-pre-push.sh

expect_allowed "clean branch after tooling is restored" origin "${case_branch}"

if ((failures > 0)); then
  echo "${failures} of ${checks} hook checks failed." >&2
  exit 1
fi
echo "All ${checks} hook checks passed."
