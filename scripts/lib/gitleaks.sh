# Shared gitleaks setup and scanning, sourced by the secret scan scripts.
#
# The caller defines repo_root and a block function that reports a failure and
# exits, and sets scan_log to a writable path and work_dir to a writable directory
# before scanning.

readonly gitleaks="${repo_root}/.tools/gitleaks"
# Custom rules first, because their findings name the exact secret type.
readonly configs=("${repo_root}/.gitleaks-custom.toml" "${repo_root}/.gitleaks.toml")
readonly gitleaks_flags=(--ignore-gitleaks-allow --redact --verbose --no-banner --no-color --log-level warn)

# Blocks unless the pinned binary, both configs and no ignore file are in place.
check_gitleaks_ready() {
  if [[ ! -x "${gitleaks}" ]]; then
    echo "Run: npm run gitleaks:install" >&2
    block "gitleaks is not installed"
  fi

  local pinned_version actual_version
  pinned_version="$(cat "${repo_root}/.gitleaks-version")" || block "cannot read .gitleaks-version"
  actual_version="$("${gitleaks}" version)" || block "gitleaks did not run"
  if [[ "${actual_version}" != "${pinned_version}" ]]; then
    echo "Run: npm run gitleaks:install" >&2
    block "gitleaks is ${actual_version} but ${pinned_version} is pinned"
  fi

  local config
  for config in "${configs[@]}"; do
    [[ -f "${config}" ]] || block "missing ${config#"${repo_root}/"}"
  done

  # A .gitleaksignore file silently excuses findings.
  if [[ -e "${repo_root}/.gitleaksignore" || -L "${repo_root}/.gitleaksignore" ]]; then
    block ".gitleaksignore exists at the repository root"
  fi
}

check_scan_result() {
  local status="$1"
  cat "${scan_log}" >&2
  ((status == 0)) || block "gitleaks reported a finding or failed"
  # gitleaks can log an error and still exit 0, for example when git rejects the
  # range, which would otherwise pass the scan.
  if grep -qE '(^| )(ERR|FTL)( |$)' "${scan_log}"; then
    block "gitleaks reported an error"
  fi
}

# Scans a text file with both configs.
scan_text() {
  local config status
  for config in "${configs[@]}"; do
    status=0
    "${gitleaks}" stdin --config "${config}" "${gitleaks_flags[@]}" \
      <"$1" >"${scan_log}" 2>&1 || status=$?
    check_scan_result "${status}"
  done
}

# Scans commit contents with both configs. Takes git log revision options.
scan_contents() {
  local config status
  for config in "${configs[@]}"; do
    status=0
    "${gitleaks}" git "${repo_root}" --config "${config}" "${gitleaks_flags[@]}" \
      --log-opts="-m --text --no-color --no-ext-diff --no-textconv $*" \
      >"${scan_log}" 2>&1 || status=$?
    check_scan_result "${status}"
  done
}

# Succeeds when a path must not be pushed.
is_denied_path() {
  local path="$1" lower base
  lower="$(printf '%s' "${path}" | tr '[:upper:]' '[:lower:]')"
  base="${lower##*/}"

  [[ "${path##*/}" == ".env.example" ]] && return 1
  # Only the root .npmrc is allowed. Its contents are still scanned for secrets.
  [[ "${path}" == ".npmrc" ]] && return 1
  # The backup role scripts are the only tracked psql scripts.
  [[ "${path}" == "backup/create-backup-role.psql" ]] && return 1
  [[ "${path}" == "backup/grant-backup-role.psql" ]] && return 1

  case "${base}" in
    *.sql)
      # Only a migration directly inside supabase/migrations/ is allowed.
      [[ "${lower}" == "supabase/migrations/${base}" ]] && return 1
      return 0
      ;;
    .env* | *.env | env.local | .gitleaksignore | *.sql.* | *.psql | *.pgsql | \
      *.csv | *.tsv | *.jsonl | *.ndjson | *.xls | *.xlsx | *.ods | *.pdf | \
      *.zip | *.tar | *.tar.* | *.tgz | *.gz | *.bz2 | *.xz | *.7z | *.rar | \
      *.sqlite* | *.db | *.dump | *.pgdump | *.bak | *.backup | \
      *.pem | *.key | *.crt | *.cer | *.der | *.p12 | *.pfx | \
      *.age | *.agekey | age-identity* | age-key* | age.txt | keys.txt | key.txt | \
      backup-identity* | identity.txt | id_rsa* | id_ed25519* | secrets.json | credentials.json | \
      service-account*.json | .npmrc | .netrc | .pgpass | pgpass.conf | .pg_service.conf | .git-credentials)
      return 0
      ;;
  esac
  return 1
}

check_paths() {
  local paths_file="${work_dir}/paths" path
  git log -m --format= --name-only --no-renames --diff-filter=AMRC -z "$@" >"${paths_file}" \
    || block "could not list changed paths"

  # A path can hold an email address or a real ID too. This comes first because the
  # denied path message below prints the path, and these findings are redacted.
  tr '\000' '\n' <"${paths_file}" >"${paths_file}.text" || block "could not read changed paths"
  scan_text "${paths_file}.text"

  while IFS= read -r -d '' path; do
    if is_denied_path "${path}"; then
      block "denied path in commits: ${path}"
    fi
  done <"${paths_file}"
}

# GitHub's per-user no-reply addresses and its own web commit identity.
is_noreply_email() {
  local pattern='^[^@]+@users\.noreply\.github\.com$'
  [[ "$1" =~ ${pattern} || "$1" == "noreply@github.com" ]]
}

# Checks author and committer identities and scans them with the commit messages.
# A caller may set committer_email_policy=warn to report a committer address that
# is not a no-reply one, without failing. Anything else blocks it.
check_commit_metadata() {
  local metadata_file="${work_dir}/metadata" committer_fields='%cn <%ce>' commit role email
  git log --format='%h author %ae%n%h committer %ce' "$@" >"${metadata_file}" \
    || block "could not read commit identities"
  while read -r commit role email; do
    is_noreply_email "${email}" && continue
    if [[ "${role}" == "committer" && "${committer_email_policy:-block}" == "warn" ]]; then
      # Only the commit is named, so that the log does not repeat the address.
      echo "::warning::commit ${commit} has a committer email that is not a no-reply address"
      continue
    fi
    block "commit ${commit} has a ${role} email that is not a no-reply address"
  done <"${metadata_file}"

  # The email rule would otherwise turn that warning into a failure.
  [[ "${committer_email_policy:-block}" == "warn" ]] && committer_fields='%cn'

  git log --format="%an <%ae>%n${committer_fields}%n%B" "$@" >"${metadata_file}" \
    || block "could not read commit messages"
  scan_text "${metadata_file}"
}

# Walks a chain of annotated tags, checking each tagger and tag message.
check_tag_objects() {
  local tag_file="${work_dir}/tag" object="$1" tagger
  while [[ "$(git cat-file -t "${object}")" == "tag" ]]; do
    git cat-file tag "${object}" >"${tag_file}" || block "could not read tag ${object}"
    tagger="$(sed -e '/^$/q' "${tag_file}" | sed -n 's/^tagger .*<\(.*\)> [0-9]* [-+0-9]*$/\1/p')"
    if ! is_noreply_email "${tagger}"; then
      block "tag ${object} has a tagger email that is not a no-reply address"
    fi
    scan_text "${tag_file}"
    object="$(sed -n 's/^object //p' "${tag_file}" | head -n 1)"
  done
}
