#!/usr/bin/env bash
#
# Proves a backup restores. Decrypts it into an empty local scratch database and compares
# row counts with its manifest, then counts and per-table checksums with what the scratch
# database holds afterwards. It never connects to anything but the local scratch database.
#
# Usage:
#   verify-restore.sh --archive <file> --manifest <file> --identity <file> --scratch-url <url>
#
# The URL must name a local host and a database with scratch, restore or drill in its
# name, for example postgres://restore_drill@localhost:5432/backup_scratch. Give any
# password through PGPASSWORD or a .pgpass file, never in the URL.
#
# Run this as an ordinary OS account, with a database role that owns the scratch database
# and has no superuser or role-creating power. Restored dumps run under that role, so
# that is the limit on what a tampered dump could do. See docs/BACKUPS.md.
#
# Decrypted data reaches only pipes and the scratch database. Drop that database after use.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_dir

die() {
  echo "verify-restore: refused: $*" >&2
  exit 2
}

fail() {
  echo "verify-restore: FAILED: $*" >&2
  exit 1
}

usage() {
  sed -n '7,8p' "${BASH_SOURCE[0]}" | sed 's/^# *//' >&2
  exit 2
}

archive=""
manifest=""
identity=""
scratch_url=""

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --archive | --manifest | --identity | --scratch-url)
        (($# >= 2)) || die "$1 needs a value"
        case "$1" in
          --archive) archive="$2" ;;
          --manifest) manifest="$2" ;;
          --identity) identity="$2" ;;
          --scratch-url) scratch_url="$2" ;;
        esac
        shift 2
        ;;
      -h | --help) usage ;;
      # The argument is not repeated, in case a secret was pasted in the wrong place.
      *) die "unknown argument" ;;
    esac
  done
  [[ -n "${archive}" ]] || die "--archive is required"
  [[ -n "${manifest}" ]] || die "--manifest is required"
  [[ -n "${identity}" ]] || die "--identity is required"
  [[ -n "${scratch_url}" ]] || die "--scratch-url is required"
}

# Allows only a plain URL for a local host. Query parameters can replace the host, so
# anything but sslmode is refused, and percent-encoding could hide a host or a name, so
# that is refused too. Refusals never repeat the URL, which may hold a password.
check_scratch_url() {
  local lower
  lower="$(printf '%s' "${scratch_url}" | tr '[:upper:]' '[:lower:]')"

  case "${lower}" in
    *supabase* | *pooler* | *prod* | *amazonaws* | *rds.* | *neon.tech* | *render.com* | *railway*)
      die "the scratch URL looks like production"
      ;;
  esac

  local pattern='^postgres(ql)?://([^/?#]*)/([^/?#]+)(\?([^#]*))?$'
  [[ "${lower}" =~ ${pattern} ]] || die "the scratch URL must look like postgres://user@localhost:5432/name"
  local authority="${BASH_REMATCH[2]}" name="${BASH_REMATCH[3]}" query="${BASH_REMATCH[5]}"

  [[ "${lower}" != *%* ]] || die "the scratch URL must not use percent-encoding"
  if [[ -n "${query}" && ! "${query}" =~ ^sslmode=[a-z-]+$ ]]; then
    die "the scratch URL may hold only an sslmode parameter"
  fi

  local host_port="${authority}" user=""
  if [[ "${authority}" == *@* ]]; then
    user="${authority%%@*}"
    host_port="${authority#*@}"
    [[ "${user}" != *:* ]] || die "the scratch URL must not hold a password, use PGPASSWORD or .pgpass"
    [[ "${host_port}" != *@* ]] || die "the scratch URL has more than one @"
  fi

  case "${user}" in
    postgres | backup_ro | service_role | supabase_admin | authenticator | anon | authenticated | root)
      die "connect as an unprivileged role made for this drill, not ${user}"
      ;;
  esac

  local host_pattern='^(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?$'
  [[ "${host_port}" =~ ${host_pattern} ]] || die "the scratch database must be on localhost"

  case "${name}" in
    postgres | template0 | template1) die "that is not a scratch database" ;;
  esac
  [[ "${name}" =~ ^[a-z0-9_]*(scratch|restore|drill)[a-z0-9_]*$ ]] \
    || die "the scratch database's name must include scratch, restore or drill"
}

check_files() {
  [[ "$(id -u)" != "0" ]] || die "do not run this as root"
  [[ -f "${archive}" && -r "${archive}" ]] || die "cannot read the archive"
  [[ -f "${manifest}" && -r "${manifest}" ]] || die "cannot read the manifest"
  # The identity is never quoted, in case the key itself was passed instead of a path.
  [[ -f "${identity}" && -r "${identity}" ]] || die "cannot read the identity file"
  if [[ -n "$(find "${identity}" -prune \( -perm -040 -o -perm -004 \) -print)" ]]; then
    die "other accounts can read the identity file, run chmod 600 on it"
  fi
  grep -q '^archive_sha256 [0-9a-f]\{64\}$' "${manifest}" || die "the manifest has no archive checksum"
  grep -q '^table ' "${manifest}" || die "the manifest lists no tables"
}

# Tools come after the refusals, so a bad call is refused on any machine.
check_tools() {
  local tool
  for tool in age pg_dump pg_restore psql; do
    command -v "${tool}" >/dev/null 2>&1 || die "${tool} is not installed"
  done

  # CVE-2025-8714 and CVE-2025-8715.
  local version
  version="$(pg_restore --version)" || die "pg_restore did not run"
  [[ "${version}" =~ ([0-9]+)\.([0-9]+) ]] || die "cannot read the pg_restore version"
  local major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}" needed
  case "${major}" in
    17) needed=6 ;;
    16) needed=10 ;;
    15) needed=14 ;;
    14) needed=19 ;;
    13) needed=22 ;;
    *)
      ((major > 17)) || die "pg_restore ${major}.${minor} is too old"
      needed=0
      ;;
  esac
  ((minor >= needed)) || die "pg_restore ${major}.${minor} is missing the 2025 restore fixes"
}

# A role can reach a remote server through a tunnel on localhost, so the server is checked
# as well: it must look like an empty scratch database, not a hosted platform's, and the
# role must have no power beyond it. Fixed text only, so no row text can reach the output.
check_scratch_server() {
  local result
  result="$(
    psql -X -q -A -t -F ' ' -v ON_ERROR_STOP=1 --no-password -d "${scratch_url}" <<'SQL'
SELECT
  (r.rolsuper OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS elevated,
  (SELECT count(*) FROM pg_catalog.pg_namespace n
   WHERE n.nspname IN ('auth', 'storage', 'realtime', 'vault', 'supabase_functions', 'graphql', 'pgbouncer'))
   + (SELECT count(*) FROM pg_catalog.pg_roles x
      WHERE x.rolname IN ('supabase_admin', 'authenticator', 'service_role', 'backup_ro')) AS platform,
  (SELECT count(*) FROM pg_catalog.pg_class c
   JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')) AS objects
FROM pg_catalog.pg_roles r
WHERE r.rolname = current_user;
SQL
  )" || die "could not connect to the scratch database"

  local elevated platform objects
  read -r elevated platform objects <<<"${result}"
  [[ "${elevated}" == "f" ]] || die "the database role is too powerful, use an unprivileged one"
  [[ "${platform}" == "0" ]] || die "this server looks like a hosted project, not a scratch database"
  [[ "${objects}" == "0" ]] || die "the scratch database is not empty, drop and recreate it"
}

sha256_tool() {
  if command -v sha256sum >/dev/null 2>&1; then
    echo "sha256sum"
  else
    echo "shasum -a 256"
  fi
}

decrypt() {
  age --decrypt -i "${identity}" "${archive}"
}

# pg_restore can stop reading before the end of its input. Reading the rest keeps the
# command feeding it from failing on a closed pipe, which pipefail would report.
restore_tool() {
  local status=0
  pg_restore "$@" || status=$?
  cat >/dev/null
  return "${status}"
}

# Prints "<table> <rows> <digest>" per table, sorted, from dump bytes on stdin.
summarise() {
  local digest_dir
  digest_dir="$(mktemp -d "${work_dir}/digest.XXXXXX")"
  restore_tool --data-only -f - \
    | LC_ALL=C awk -v digest_cmd="$(sha256_tool)" -v digest_dir="${digest_dir}" \
      -f "${script_dir}/copy-summary.awk" \
    | LC_ALL=C sort
}

check_archive_checksum() {
  local expected actual
  expected="$(sed -n 's/^archive_sha256 //p' "${manifest}")"
  actual="$($(sha256_tool) "${archive}" | cut -d' ' -f1)"
  [[ "${expected}" == "${actual}" ]] || fail "the archive does not match the manifest's checksum"
  echo "verify-restore: archive checksum matches the manifest"
}

check_manifest_counts() {
  sed -n 's/^table //p' "${manifest}" | LC_ALL=C sort >"${work_dir}/manifest-counts"
  cut -d' ' -f1,2 "${work_dir}/from-archive" >"${work_dir}/archive-counts"
  if ! cmp -s "${work_dir}/manifest-counts" "${work_dir}/archive-counts"; then
    fail "row counts in the archive differ from the manifest"
  fi
  echo "verify-restore: archive row counts match the manifest"
}

restore() {
  # Three kinds of entry are skipped. Policies name a role this server does not have. An
  # explicit --schema=public makes pg_dump emit CREATE SCHEMA public, which fails with
  # 42P06 because every new database already has that schema. Default privileges can name
  # the platform's own roles. --no-privileges below skips those too, so here this only keeps
  # the filter the same as the recovery steps in docs/BACKUPS.md, where it matters.
  decrypt | restore_tool --list >"${work_dir}/full-list"
  grep -Ev '^[0-9]+; [0-9]+ [0-9]+ (POLICY |SCHEMA - public |DEFAULT ACL )' "${work_dir}/full-list" >"${work_dir}/restore-list"
  decrypt | restore_tool --no-owner --no-privileges --no-comments --single-transaction \
    --use-list="${work_dir}/restore-list" --no-password -d "${scratch_url}"
  echo "verify-restore: restored into the scratch database"
}

# The tables' text is read back through the same tools the backup used, so the two forms
# are comparable. A checksum depends on row order. A freshly loaded table keeps its load
# order, so a mismatch here is a real one to investigate.
check_restored() {
  pg_dump --format=custom --data-only --no-password \
    --schema=public --schema=history -d "${scratch_url}" \
    | summarise >"${work_dir}/from-scratch"

  if ! cmp -s "${work_dir}/from-archive" "${work_dir}/from-scratch"; then
    # Names and counts only. A digest of a small value could help someone guess it.
    cut -d' ' -f1,2 "${work_dir}/from-archive" >"${work_dir}/a"
    cut -d' ' -f1,2 "${work_dir}/from-scratch" >"${work_dir}/b"
    diff "${work_dir}/a" "${work_dir}/b" >&2 || true
    fail "the scratch database's rows differ from the archive"
  fi
  echo "verify-restore: per-table counts and checksums match the archive"
}

main() {
  parse_args "$@"
  check_scratch_url
  check_files
  check_tools

  # The URL is the only target. These variables could otherwise redirect a connection.
  unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGSERVICE PGSERVICEFILE PGOPTIONS DATABASE_URL
  export PGTZ=UTC PGCONNECT_TIMEOUT=10

  umask 077
  work_dir="$(mktemp -d)"
  trap 'rm -rf "${work_dir}"' EXIT

  check_scratch_server
  check_archive_checksum
  decrypt | summarise >"${work_dir}/from-archive"
  [[ -s "${work_dir}/from-archive" ]] || fail "the archive holds no tables"
  check_manifest_counts
  restore
  check_restored

  echo "verify-restore: OK. Drop the scratch database now, it holds decrypted data."
}

main "$@"
