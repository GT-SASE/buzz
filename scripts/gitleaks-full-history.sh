#!/usr/bin/env bash
#
# Scans every commit on every ref and every annotated tag: changed paths, author
# and tagger identities, messages and contents. Fails on any finding, on a tag that
# does not point to a commit, on a wrong gitleaks version, on a .gitleaksignore
# file, on a shallow clone (which would hide most of the history), and on any scan
# error.

set -euo pipefail

block() {
  echo "gitleaks-full-history: $*" >&2
  exit 1
}

repo_root="$(git rev-parse --show-toplevel)" || block "not inside a git work tree"
readonly repo_root
# shellcheck source=scripts/lib/gitleaks.sh
source "${repo_root}/scripts/lib/gitleaks.sh" || block "cannot load scripts/lib/gitleaks.sh"

# gitleaks also looks for an ignore file in the current directory.
cd "${repo_root}"

check_gitleaks_ready

[[ "$(git rev-parse --is-shallow-repository)" == "false" ]] \
  || block "this is a shallow clone, so the history cannot be scanned in full"

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT
readonly scan_log="${work_dir}/scan.log"

# A failure here on main could only be cleared by rewriting it, so a committer
# address that is not a no-reply one is a warning. The pre-push hook always
# enforces it.
# shellcheck disable=SC2034 # read by check_commit_metadata in the library
readonly committer_email_policy="warn"

echo "Scanning $(git rev-list --count --all) commits"

check_paths --all
check_commit_metadata --all

git for-each-ref --format='%(objectname)' refs/tags >"${work_dir}/tags" || block "could not list tags"
while IFS= read -r tag_object; do
  # git log and the content scan only follow commits, so nothing else would look
  # inside a tag of a blob or tree. Only the object is named, as a tag name is not
  # scanned.
  if ! git rev-parse -q --verify "${tag_object}^{commit}" >/dev/null; then
    block "tag ${tag_object} does not point to a commit"
  fi
  check_tag_objects "${tag_object}"
done <"${work_dir}/tags"

scan_contents --all --full-history

echo "No secrets found."
