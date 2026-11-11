#!/usr/bin/env bash
#
# Pre-push checks, run by .githooks/pre-push. For every pushed ref, this checks
# changed paths, commit and tag metadata, and the commits' contents. Any finding
# or error blocks the push.
#
# Arguments: the remote name and URL, as git passes them to the hook.
# Stdin: one "<local ref> <local sha> <remote ref> <remote sha>" line per ref.

set -euo pipefail

block() {
  echo "pre-push: $*; this push is blocked." >&2
  exit 1
}

[[ $# -eq 2 ]] || block "expected a remote name and URL from git"
readonly remote="$1"

repo_root="$(git rev-parse --show-toplevel)" || block "not inside a git work tree"
readonly repo_root
# shellcheck source=scripts/lib/gitleaks.sh
source "${repo_root}/scripts/lib/gitleaks.sh" || block "cannot load scripts/lib/gitleaks.sh"

check_gitleaks_ready

# Git feeds this hook through a pipe. Anything else, such as /dev/null or a
# terminal, means the ref list did not come from git.
[[ -p /dev/stdin ]] || block "stdin is not a pipe from git"

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT
readonly refs_file="${work_dir}/refs"
readonly scan_log="${work_dir}/scan.log"

check_range() {
  echo "pre-push: scanning $*"
  git rev-list --count "$@" >/dev/null || block "invalid revision range: $*"
  check_paths "$@"
  check_commit_metadata "$@"
  scan_contents "$@"
}

# Scans commits the remote is not known to have. A push target given as a URL
# has no tracking refs, so the full history of the ref is scanned.
check_unknown_commits() {
  if git remote get-url "${remote}" >/dev/null 2>&1; then
    check_range "$1" --not "--remotes=${remote}"
  else
    check_range "$1"
  fi
}

cat >"${refs_file}" || block "could not read the ref list from git"

# Git sends no lines when no ref needs updating, so there are no commits to scan.
if [[ ! -s "${refs_file}" ]]; then
  echo "pre-push: git reported no refs to update"
  exit 0
fi

readonly sha_pattern='^[0-9a-f]{40}([0-9a-f]{24})?$'
readonly zero_pattern='^0+$'

while IFS= read -r line <&3 || [[ -n "${line}" ]]; do
  read -r local_ref local_sha remote_ref remote_sha extra <<<"${line}"

  if [[ -z "${local_ref}" || -z "${remote_ref}" || -n "${extra}" ]] \
    || [[ ! "${local_sha}" =~ ${sha_pattern} || ! "${remote_sha}" =~ ${sha_pattern} ]]; then
    block "unexpected ref line from git"
  fi

  # An all-zero local SHA is a deletion, which sends no commits.
  [[ "${local_sha}" =~ ${zero_pattern} ]] && continue

  if ! git rev-parse -q --verify "${local_sha}^{commit}" >/dev/null; then
    block "${remote_ref} does not point to a commit"
  fi

  check_tag_objects "${local_sha}"

  # Use the exact range when the remote tip is known locally. A new branch, or a
  # remote tip this clone has not fetched, falls back to all unknown commits.
  if [[ ! "${remote_sha}" =~ ${zero_pattern} ]] && git cat-file -e "${remote_sha}^{commit}" 2>/dev/null; then
    check_range "${remote_sha}..${local_sha}"
  else
    check_unknown_commits "${local_sha}"
  fi
done 3<"${refs_file}"
