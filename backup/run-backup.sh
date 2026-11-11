#!/usr/bin/env bash
#
# Streams pg_dump through age, with no plaintext written to disk, and refuses to leave
# a backup behind unless its row counts hold up. Runs in the private backups repo. See
# docs/BACKUPS.md.
#
# Connection settings come from libpq's PG* environment variables, so no credential
# appears in an argument or a URL. Nothing here prints those values. Do not add set -x.
#
# Required: PGHOST PGUSER PGPASSWORD PGDATABASE PGSSLMODE=verify-full PGSSLROOTCERT
#           AGE_RECIPIENT_1 AGE_RECIPIENT_2
# Optional: AGE_RECIPIENT_3, for the overlap during a handoff
#           BACKUP_DIR (backups)
#           MAX_DROP_PERCENT (20), the largest allowed fall in a table's rows
#           MIN_ROWS_FOR_PERCENT (5), below which only a fall to zero counts as a drop
#           ACCEPT_DROP_REASON, honoured only on a manual run

set -euo pipefail

readonly MAX_ARCHIVE_BYTES=$((95 * 1024 * 1024))
# Rows here may be deleted after a day, so a fall says nothing about data loss.
readonly DROP_EXEMPT_TABLES=" public.interaction_claims "

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_dir
readonly backup_dir="${BACKUP_DIR:-backups}"
readonly max_drop_percent="${MAX_DROP_PERCENT:-20}"
readonly min_rows_for_percent="${MIN_ROWS_FOR_PERCENT:-5}"

die() {
  echo "run-backup: $*" >&2
  exit 1
}

check_settings() {
  local name
  for name in PGHOST PGUSER PGPASSWORD PGDATABASE PGSSLROOTCERT AGE_RECIPIENT_1 AGE_RECIPIENT_2; do
    [[ -n "${!name:-}" ]] || die "${name} is not set"
  done
  [[ "${PGSSLMODE:-}" == "verify-full" ]] || die "PGSSLMODE must be verify-full"
  [[ -r "${PGSSLROOTCERT}" ]] || die "PGSSLROOTCERT is not readable"
  [[ "${max_drop_percent}" =~ ^[0-9]+$ ]] || die "MAX_DROP_PERCENT must be a whole number"
  [[ "${min_rows_for_percent}" =~ ^[0-9]+$ ]] || die "MIN_ROWS_FOR_PERCENT must be a whole number"

  check_recipient "${AGE_RECIPIENT_1}"
  check_recipient "${AGE_RECIPIENT_2}"
  [[ "${AGE_RECIPIENT_1}" != "${AGE_RECIPIENT_2}" ]] \
    || die "the age recipients must be different keys"
  if [[ -n "${AGE_RECIPIENT_3:-}" ]]; then
    check_recipient "${AGE_RECIPIENT_3}"
    [[ "${AGE_RECIPIENT_3}" != "${AGE_RECIPIENT_1}" && "${AGE_RECIPIENT_3}" != "${AGE_RECIPIENT_2}" ]] \
      || die "the age recipients must be different keys"
  fi

  if [[ -n "${ACCEPT_DROP_REASON:-}" ]]; then
    [[ "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" ]] \
      || die "ACCEPT_DROP_REASON is honoured only on a manual run"
    [[ "${ACCEPT_DROP_REASON}" =~ ^[A-Za-z0-9\ ._:-]{1,120}$ ]] \
      || die "ACCEPT_DROP_REASON must be 1-120 plain characters"
  fi
}

# A value that is not a public key must never reach a log or an argument, so the error
# does not quote it.
check_recipient() {
  [[ "$1" =~ ^age1[0-9a-z]{40,}$ ]] || die "an age recipient is not a public key"
}

# CVE-2025-8714 and CVE-2025-8715 are fixed in 17.6.
check_client_version() {
  local version
  version="$(pg_dump --version)" || die "pg_dump did not run"
  [[ "${version}" =~ ([0-9]+)\.([0-9]+) ]] || die "cannot read the pg_dump version"
  local major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}"
  if ((major < 17 || (major == 17 && minor < 6))); then
    die "pg_dump ${major}.${minor} is too old, 17.6 or later is required"
  fi
}

run_sql() {
  psql -X -q -A -t -F ' ' -v ON_ERROR_STOP=1
}

# Fails unless this connection is the backup role, cannot change app data, and can see
# every row of every table. Without that last part a dump could succeed and be missing
# rows, so under row level security a table counts as visible only with BYPASSRLS, or if
# a permissive policy of exactly USING (true) covers this role or PUBLIC and no
# restrictive policy applies. A live count would not catch this: it is filtered the same way.
check_role() {
  local result
  result="$(
    run_sql <<'SQL'
WITH tables AS (
  SELECT c.oid, c.relrowsecurity
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'history') AND c.relkind IN ('r', 'p')
), me AS (
  SELECT oid, rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
  FROM pg_catalog.pg_roles WHERE rolname = current_user
)
SELECT
  me.rolname,
  (me.rolsuper OR me.rolcreaterole OR me.rolcreatedb OR me.rolreplication) AS elevated,
  (SELECT count(*) FROM pg_catalog.pg_auth_members m WHERE m.member = me.oid) AS memberships,
  (SELECT count(*) FROM tables t
   WHERE pg_catalog.has_table_privilege(me.oid, t.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')) AS writable,
  (SELECT count(*) FROM tables t
   WHERE NOT pg_catalog.has_table_privilege(me.oid, t.oid, 'SELECT')) AS unreadable,
  (SELECT count(*) FROM tables t
   WHERE t.relrowsecurity AND NOT me.rolbypassrls AND (
     NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy p
       WHERE p.polrelid = t.oid AND p.polpermissive AND p.polcmd IN ('r', '*')
         AND (me.oid = ANY (p.polroles) OR 0::oid = ANY (p.polroles))
         AND pg_catalog.pg_get_expr(p.polqual, p.polrelid) = 'true')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy p
       WHERE p.polrelid = t.oid AND NOT p.polpermissive AND p.polcmd IN ('r', '*')
         AND (me.oid = ANY (p.polroles) OR 0::oid = ANY (p.polroles))))) AS hidden,
  (SELECT count(*) FROM tables) AS tables
FROM me;
SQL
  )" || die "could not connect, or the role check failed"

  local role elevated memberships writable unreadable hidden tables
  read -r role elevated memberships writable unreadable hidden tables <<<"${result}"
  [[ "${role}" == "backup_ro" ]] || die "connected as the wrong role, expected backup_ro"
  [[ "${elevated}" == "f" ]] || die "backup_ro holds an elevated attribute"
  [[ "${memberships}" == "0" ]] || die "backup_ro is a member of another role"
  [[ "${writable}" == "0" ]] || die "backup_ro can change ${writable} tables"
  [[ "${unreadable}" == "0" ]] || die "backup_ro cannot read ${unreadable} tables, add them to a migration"
  [[ "${hidden}" == "0" ]] || die "row level security hides ${hidden} tables from backup_ro"
  [[ "${tables}" =~ ^[1-9][0-9]*$ ]] || die "found no tables to back up"
}

# The migrations this database has applied, one version per line, for the manifest. Without
# them a recovery from this backup cannot tell which migrations it still has to run.
applied_migrations() {
  local result
  result="$(
    run_sql <<'SQL'
SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;
SQL
  )" || die "could not read the applied migrations, see docs/BACKUPS.md"
  [[ -n "${result}" ]] || die "the database records no applied migrations"
  [[ "${result}" =~ ^[0-9]+($'\n'[0-9]+)*$ ]] || die "unexpected output from the applied migrations"
  printf '%s\n' "${result}"
}

# One line per table, "<schema.table> <rows>", sorted, read in a single statement so the
# counts come from one snapshot.
live_counts() {
  run_sql <<'SQL' | LC_ALL=C sort
SELECT string_agg(
         format('SELECT %L, count(*) FROM %I.%I', format('%I.%I', n.nspname, c.relname), n.nspname, c.relname),
         ' UNION ALL ')
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'history') AND c.relkind IN ('r', 'p')
\gexec
SQL
}

# Encrypts as it dumps. tee feeds the same bytes through a pipe to a parser that only
# counts rows, so the counts describe exactly what was encrypted.
dump_and_encrypt() {
  local archive="$1" stream="$2" summary="$3" summary_pid

  set -- -r "${AGE_RECIPIENT_1}" -r "${AGE_RECIPIENT_2}"
  if [[ -n "${AGE_RECIPIENT_3:-}" ]]; then
    set -- "$@" -r "${AGE_RECIPIENT_3}"
  fi

  # pg_restore can stop reading before the end of the stream. Reading the rest keeps tee
  # from failing on a closed pipe, which would abort the dump.
  mkfifo "${stream}"
  {
    status=0
    pg_restore --data-only -f - || status=$?
    cat >/dev/null
    exit "${status}"
  } <"${stream}" \
    | LC_ALL=C awk -f "${script_dir}/copy-summary.awk" >"${summary}" &
  summary_pid=$!

  if ! pg_dump --format=custom --enable-row-security --no-password \
    --schema=public --schema=history \
    | tee "${stream}" \
    | age --encrypt "$@" -o "${archive}"; then
    wait "${summary_pid}" || true
    die "the dump or its encryption failed"
  fi
  wait "${summary_pid}" || die "could not read back the dump's row counts"
}

# The dump's snapshot falls between the two live counts, so each table's dumped rows
# must lie between them. When nothing was written meanwhile, that means an exact match.
check_counts() {
  local before="$1" dumped="$2" after="$3"

  LC_ALL=C sort -c "${before}" 2>/dev/null || die "live counts were not sorted"
  [[ -s "${before}" ]] || die "the live count returned no tables"
  LC_ALL=C sort -o "${dumped}" "${dumped}"

  [[ "$(cut -d' ' -f1 "${before}")" == "$(cut -d' ' -f1 "${dumped}")" ]] \
    || die "the dump's tables differ from the database's tables"
  [[ "$(cut -d' ' -f1 "${before}")" == "$(cut -d' ' -f1 "${after}")" ]] \
    || die "the database's tables changed during the dump"

  paste -d' ' "${before}" "${dumped}" "${after}" | awk '
    {
      low = ($2 < $6) ? $2 : $6
      high = ($2 > $6) ? $2 : $6
      if ($4 < low || $4 > high) {
        printf "run-backup: %s holds %d rows in the dump, but the live count was %d to %d\n", $1, $4, low, high > "/dev/stderr"
        bad = 1
      }
    }
    END { exit bad }
  ' || die "row counts do not match the live database"

  local total
  total="$(awk '{ sum += $2 } END { printf "%d", sum }' "${dumped}")"
  [[ "${total}" != "0" ]] || die "the dump holds no rows"
  grep -q '^public\.guild_config [1-9]' "${dumped}" \
    || die "the dump has no guild_config rows"
}

# Compares with the last good backup's manifest. A failed run leaves that manifest in
# place, so a drop keeps failing until someone looks at it.
check_drop() {
  local dumped="$1" previous="${backup_dir}/latest.manifest.txt"

  if [[ ! -f "${previous}" ]]; then
    echo "run-backup: no previous manifest, skipping the drop check"
    return 0
  fi

  if ! awk -v max="${max_drop_percent}" -v min_rows="${min_rows_for_percent}" \
    -v exempt="${DROP_EXEMPT_TABLES}" '
    FNR == NR { now[$1] = $2; next }
    $1 == "table" {
      name = $2; before = $3
      if (index(exempt, " " name " ") > 0) { next }
      if (!(name in now)) {
        printf "run-backup: %s was in the last backup and is gone\n", name > "/dev/stderr"
        bad = 1
      } else if (before > 0 && now[name] == 0) {
        printf "run-backup: %s fell from %d rows to none\n", name, before > "/dev/stderr"
        bad = 1
      } else if (before >= min_rows && now[name] * 100 < before * (100 - max)) {
        printf "run-backup: %s fell from %d rows to %d\n", name, before, now[name] > "/dev/stderr"
        bad = 1
      }
    }
    END { exit bad }
  ' "${dumped}" "${previous}"; then
    if [[ -n "${ACCEPT_DROP_REASON:-}" ]]; then
      echo "::warning::Row count drop accepted by a manual run: ${ACCEPT_DROP_REASON}"
      return 0
    fi
    die "a large unexplained drop in row counts, see docs/BACKUPS.md"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

check_archive() {
  local archive="$1" size header
  [[ -s "${archive}" ]] || die "the encrypted file is empty"
  size="$(wc -c <"${archive}" | tr -d ' ')"
  # Git hosting refuses files of 100 MiB. Finding out here keeps the error readable.
  ((size <= MAX_ARCHIVE_BYTES)) || die "the encrypted file is ${size} bytes, over the limit"
  IFS= read -r header <"${archive}" || true
  [[ "${header}" == "age-encryption.org/v1" ]] || die "the output is not an age file"
}

write_manifest() {
  local archive_path="$1" sha="$2" stamp="$3" dumped="$4" migrations="$5"
  echo "created_at ${stamp}"
  echo "archive ${archive_path}"
  echo "archive_sha256 ${sha}"
  echo "recipient ${AGE_RECIPIENT_1}"
  echo "recipient ${AGE_RECIPIENT_2}"
  if [[ -n "${AGE_RECIPIENT_3:-}" ]]; then
    echo "recipient ${AGE_RECIPIENT_3}"
  fi
  if [[ -n "${ACCEPT_DROP_REASON:-}" ]]; then
    echo "accepted_drop ${ACCEPT_DROP_REASON}"
  fi
  sed 's/^/migration /' "${migrations}"
  sed 's/^/table /' "${dumped}"
}

main() {
  case "$-" in
    *x*) die "refusing to run with shell tracing on" ;;
  esac

  check_settings
  local tool
  for tool in age pg_dump pg_restore psql; do
    command -v "${tool}" >/dev/null 2>&1 || die "${tool} is not installed"
  done
  check_client_version

  # Output in one zone, so a restored copy's text form can be compared with this one.
  export PGTZ=UTC

  umask 077
  work_dir="$(mktemp -d)"
  trap 'rm -rf "${work_dir}"' EXIT

  check_role
  applied_migrations >"${work_dir}/migrations"
  live_counts >"${work_dir}/before" || die "the live count failed before the dump"
  dump_and_encrypt "${work_dir}/out" "${work_dir}/stream" "${work_dir}/dumped"
  live_counts >"${work_dir}/after" || die "the live count failed after the dump"
  applied_migrations >"${work_dir}/migrations-after"
  cmp -s "${work_dir}/migrations" "${work_dir}/migrations-after" \
    || die "a migration was applied during the dump, so run the backup again"

  check_counts "${work_dir}/before" "${work_dir}/dumped" "${work_dir}/after"
  check_drop "${work_dir}/dumped"
  check_archive "${work_dir}/out"

  local stamp year base sha
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  year="${stamp:0:4}"
  base="${backup_dir}/${year}/backup-${stamp}"
  sha="$(sha256_of "${work_dir}/out")"

  mkdir -p "${backup_dir}/${year}"
  mv "${work_dir}/out" "${base}.data.age"
  write_manifest "${base}.data.age" "${sha}" "${stamp}" "${work_dir}/dumped" "${work_dir}/migrations" >"${base}.manifest.txt"
  cp "${base}.manifest.txt" "${backup_dir}/latest.manifest.txt"

  echo "run-backup: wrote ${base}.data.age"
  sed 's/^/run-backup: /' "${work_dir}/dumped"
}

main "$@"
