#!/usr/bin/env bash
#
# Runs the backup, the restore check and the recovery steps with real pg_dump, pg_restore,
# psql and age against real Postgres servers, as the Database workflow's backup job sets
# them up:
#
#   localhost:5432  stands in for production, with TLS
#   localhost:5433  an empty server for verify-restore.sh, with none of the app's roles
#   localhost:5434  stands in for a new project in a recovery, with TLS
#
# Needs BACKUP_RLS_PATH (policies or bypassrls), and POSTGRES_CONTAINER and
# RECOVERY_CONTAINER, the service container IDs. Hosted Supabase, its pooler, the Supabase
# CLI and the bot are not involved, so docs/BACKUPS.md lists those as untested.
#
# Run only on disposable servers. It changes their settings, roles and data.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly repo_root
cd "${repo_root}"

readonly rls_path="${BACKUP_RLS_PATH:?}"
readonly postgres_container="${POSTGRES_CONTAINER:?}"
readonly recovery_container="${RECOVERY_CONTAINER:?}"

work_dir="$(mktemp -d)"
readonly work_dir
trap 'rm -rf "${work_dir}"' EXIT

canary="backup-canary-$(openssl rand -hex 8)"
readonly canary

step() {
  echo
  echo "=== $*"
}

die() {
  echo "test-backup-restore: FAILED: $*" >&2
  exit 1
}

# Runs SQL as the superuser, with the port and database as the first two arguments.
admin() {
  local port="$1" database="$2"
  shift 2
  psql -X -q -A -t -v ON_ERROR_STOP=1 -h localhost -p "${port}" -U postgres -d "${database}" "$@"
}

# Runs a command that must fail with a given message in its output.
expect_failure() {
  local message="$1" output
  shift
  if output="$("$@" 2>&1)"; then
    echo "${output}"
    die "this should have failed: $*"
  fi
  echo "${output}"
  [[ "${output}" == *"${message}"* ]] || die "expected the failure to say: ${message}"
  echo "refused as expected: ${message}"
}

setup_tls() {
  local tls="${work_dir}/tls"
  mkdir "${tls}"
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=backup test CA" \
    -keyout "${tls}/ca-private.txt" -out "${tls}/ca.pem" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
    -keyout "${tls}/server-private.txt" -out "${tls}/server.csr" 2>/dev/null
  printf 'subjectAltName=DNS:localhost\n' >"${tls}/ext.txt"
  openssl x509 -req -days 2 -in "${tls}/server.csr" -CA "${tls}/ca.pem" \
    -CAkey "${tls}/ca-private.txt" -CAcreateserial -extfile "${tls}/ext.txt" \
    -out "${tls}/server-cert.pem" 2>/dev/null

  local container port data_dir=/var/lib/postgresql/data
  for pair in "${postgres_container}:5432" "${recovery_container}:5434"; do
    container="${pair%%:*}"
    port="${pair##*:}"
    docker cp "${tls}/server-cert.pem" "${container}:${data_dir}/server.crt"
    docker cp "${tls}/server-private.txt" "${container}:${data_dir}/server.key"
    docker exec "${container}" chown postgres:postgres "${data_dir}/server.crt" "${data_dir}/server.key"
    docker exec "${container}" chmod 600 "${data_dir}/server.key"
    admin "${port}" postgres -c "ALTER SYSTEM SET ssl = on"
    admin "${port}" postgres -c "SELECT pg_reload_conf()" >/dev/null
  done
  # The reload is not instant, so wait for a verified connection.
  sleep 2
  PGSSLMODE=verify-full PGSSLROOTCERT="${tls}/ca.pem" admin 5432 postgres -c "SELECT 1" >/dev/null
  PGSSLMODE=verify-full PGSSLROOTCERT="${tls}/ca.pem" admin 5434 postgres -c "SELECT 1" >/dev/null
  ca_file="${tls}/ca.pem"
}

# Runs the backup job's script as a given role, against a given port and directory.
run_backup() {
  local user="$1" port="$2" directory="$3"
  (
    export PGHOST=localhost PGPORT="${port}" PGDATABASE=postgres PGUSER="${user}"
    export PGPASSWORD=unused PGSSLMODE=verify-full PGSSLROOTCERT="${ca_file}"
    export AGE_RECIPIENT_1="${recipient_1}" AGE_RECIPIENT_2="${recipient_2}"
    export AGE_RECIPIENT_3="${recipient_3}" BACKUP_DIR="${directory}"
    bash backup/run-backup.sh
  )
}

run_freshness() {
  (
    export PGHOST=localhost PGPORT=5432 PGDATABASE=postgres PGUSER=backup_ro
    export PGPASSWORD=unused PGSSLMODE=verify-full PGSSLROOTCERT="${ca_file}"
    bash backup/check-freshness.sh
  )
}

reset_scratch() {
  admin 5433 postgres -c "DROP DATABASE IF EXISTS backup_scratch"
  admin 5433 postgres -c "CREATE DATABASE backup_scratch OWNER restore_drill"
}

# The same filter as verify-restore.sh and the recovery steps in docs/BACKUPS.md.
restore_list() {
  grep -Ev '^[0-9]+; [0-9]+ [0-9]+ (POLICY |SCHEMA - public |DEFAULT ACL )' "$1"
}

# Restores into the recovery stand-in as its owner, who is not a superuser, using a given list.
restore_to_recovery() {
  age --decrypt -i "${keys}/holder-1" "${archive}" \
    | pg_restore --no-owner --single-transaction --use-list="$1" \
      -h localhost -p 5434 -U migration_owner -d postgres
}

# The query the guide's "Schema check" runs, read from the guide so the two stay the same.
schema_check_of() {
  sed -n '/^-- schema check$/,/^ORDER BY 1, 2;$/p' docs/BACKUPS.md | admin "$1" postgres
}

step "TLS on the production and recovery stand-ins"
setup_tls

step "Prepare the production stand-in (${rls_path})"
BACKUP_TEST_DATABASE_URL="postgres://postgres@localhost:5432/postgres" \
  BACKUP_RLS_PATH="${rls_path}" BACKUP_CANARY="${canary}" \
  node scripts/prepare-backup-db.ts source
admin 5432 postgres -c "ALTER ROLE backup_ro LOGIN"

# What the role must be able to read, from the catalog, so a new table changes nothing here.
readonly tables_in_scope="
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'history') AND c.relkind IN ('r', 'p')"
table_count="$(admin 5432 postgres -c "SELECT count(*) ${tables_in_scope}")"
readonly table_count
[[ "${table_count}" -gt 0 ]] || die "the catalog lists no tables"

step "The role's real attributes match the path"
expected_bypass=f
expected_policies="$(admin 5432 postgres -c "SELECT count(*) ${tables_in_scope} AND c.relrowsecurity")"
[[ "${expected_policies}" -gt 0 ]] || die "the catalog lists no tables with row level security"
if [[ "${rls_path}" == "bypassrls" ]]; then
  expected_bypass=t
  expected_policies=0
fi
[[ "$(admin 5432 postgres -c "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'backup_ro'")" == "${expected_bypass}" ]] \
  || die "rolbypassrls is not ${expected_bypass}"
[[ "$(admin 5432 postgres -c "SELECT count(*) FROM pg_policies WHERE policyname = 'backup_ro_read'")" == "${expected_policies}" ]] \
  || die "expected ${expected_policies} policies"

step "backup_ro cannot change app data or take on another role"
as_backup=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h localhost -p 5432 -U backup_ro -d postgres)
expect_failure "permission denied to set role" "${as_backup[@]}" -c "SET ROLE postgres"
expect_failure "read-only transaction" "${as_backup[@]}" -c "INSERT INTO public.job_runs (job_name) VALUES ('x')"
# The role can turn the read-only default off, so the grants have to hold by themselves.
# Separate -c options run as separate transactions, so the setting takes effect.
expect_failure "permission denied" "${as_backup[@]}" \
  -c "SET default_transaction_read_only = off" \
  -c "INSERT INTO public.job_runs (job_name) VALUES ('x')"
expect_failure "permission denied" "${as_backup[@]}" \
  -c "SET default_transaction_read_only = off" \
  -c "DELETE FROM public.tasks"

step "Generate three keys"
keys="${work_dir}/keys"
mkdir -m 700 "${keys}"
for number in 1 2 3; do
  age-keygen -o "${keys}/holder-${number}" 2>/dev/null
  chmod 600 "${keys}/holder-${number}"
done
recipient_1="$(age-keygen -y "${keys}/holder-1")"
recipient_2="$(age-keygen -y "${keys}/holder-2")"
recipient_3="$(age-keygen -y "${keys}/holder-3")"

step "The job refuses the wrong role, and a hidden or unreadable table"
backups="${work_dir}/backups"
expect_failure "wrong role" run_backup postgres 5432 "${backups}"
admin 5432 postgres -c "REVOKE SELECT ON public.tasks FROM backup_ro"
expect_failure "cannot read 1 tables" run_backup backup_ro 5432 "${backups}"
admin 5432 postgres -c "GRANT SELECT ON public.tasks TO backup_ro"
if [[ "${rls_path}" == "policies" ]]; then
  admin 5432 postgres -c "ALTER POLICY backup_ro_read ON public.tasks USING (false)"
  expect_failure "hides 1 tables" run_backup backup_ro 5432 "${backups}"
  admin 5432 postgres -c "ALTER POLICY backup_ro_read ON public.tasks USING (true)"
fi
admin 5432 postgres -c "REVOKE USAGE ON SCHEMA supabase_migrations FROM backup_ro"
expect_failure "could not read the applied migrations" run_backup backup_ro 5432 "${backups}"
admin 5432 postgres -c "GRANT USAGE ON SCHEMA supabase_migrations TO backup_ro"
[[ ! -e "${backups}" ]] || die "a refused run left files behind"

step "Run the backup"
run_backup backup_ro 5432 "${backups}"
manifest="${backups}/latest.manifest.txt"
archive="$(sed -n 's/^archive //p' "${manifest}")"
manifest_copy="${archive%.data.age}.manifest.txt"
[[ "$(grep -c '^recipient ' "${manifest}")" == "3" ]] || die "the manifest should list three recipients"
[[ "$(grep -c '^table ' "${manifest}")" == "${table_count}" ]] \
  || die "the manifest should list all ${table_count} tables"
grep -q '^table history\.row_versions [1-9]' "${manifest}" || die "the backup has no history rows"

step "The manifest records every applied migration"
diff <(ls supabase/migrations | cut -c1-14) <(sed -n 's/^migration //p' "${manifest}") \
  || die "the manifest's migrations differ from the migration files"

step "Every table carries rows, so each one is really dumped, compared and restored"
# Space-separated. Name a table here only if it has to stay empty in this test.
readonly tables_allowed_empty=""
empty_tables="$(
  awk -v allowed=" ${tables_allowed_empty} " \
    '$1 == "table" && $3 == 0 && index(allowed, " " $2 " ") == 0 { print $2 }' "${manifest}"
)"
[[ -z "${empty_tables}" ]] || die "these tables are empty in the backup: ${empty_tables}"

step "No plaintext canary on the runner's disk"
if grep -rlaF --exclude-dir=node_modules --exclude-dir=.git "${canary}" "${repo_root}" "${work_dir}"; then
  die "the canary text reached the disk"
fi
echo "canary text not found"

step "Each holder restores with their own key"
admin 5433 postgres -c "CREATE ROLE restore_drill LOGIN"
for number in 1 2 3; do
  reset_scratch
  bash backup/verify-restore.sh --archive "${archive}" --manifest "${manifest_copy}" \
    --identity "${keys}/holder-${number}" \
    --scratch-url postgres://restore_drill@localhost:5433/backup_scratch
  [[ "$(admin 5433 backup_scratch -c "SELECT count(*) FROM public.events WHERE name = '${canary} again'")" == "1" ]] \
    || die "the restored database does not hold the canary row"
done

step "verify-restore.sh refuses a wrong key and a powerful role"
age-keygen -o "${keys}/other" 2>/dev/null
chmod 600 "${keys}/other"
reset_scratch
expect_failure "no identity matched" bash backup/verify-restore.sh --archive "${archive}" \
  --manifest "${manifest_copy}" --identity "${keys}/other" \
  --scratch-url postgres://restore_drill@localhost:5433/backup_scratch
admin 5433 postgres -c "CREATE ROLE restore_admin LOGIN SUPERUSER"
reset_scratch
expect_failure "too powerful" bash backup/verify-restore.sh --archive "${archive}" \
  --manifest "${manifest_copy}" --identity "${keys}/holder-1" \
  --scratch-url postgres://restore_admin@localhost:5433/backup_scratch

step "verify-restore.sh refuses a local port that leads to the app's server"
admin 5432 postgres -c "CREATE ROLE restore_drill LOGIN"
admin 5432 postgres -c "CREATE DATABASE backup_scratch OWNER restore_drill"
expect_failure "looks like a hosted project" bash backup/verify-restore.sh --archive "${archive}" \
  --manifest "${manifest_copy}" --identity "${keys}/holder-1" \
  --scratch-url postgres://restore_drill@localhost:5432/backup_scratch

step "Reminder freshness"
run_freshness
admin 5432 postgres -c "UPDATE public.job_runs SET started_at = now() - interval '31 hours' WHERE job_name = 'reminders'"
expect_failure "last succeeded 31 hours ago" run_freshness
admin 5432 postgres -c "INSERT INTO public.job_runs (job_name, status, finished_at) VALUES ('reminders', 'failed', now())"
expect_failure "last succeeded 31 hours ago" run_freshness
admin 5432 postgres -c "UPDATE public.job_runs SET started_at = now() WHERE job_name = 'reminders' AND status = 'succeeded'"
run_freshness

step "Ending backup_ro's sessions releases a lock it holds, as docs/BACKUPS.md describes"
readonly advisory_locks="SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'"
"${as_backup[@]}" \
  -c "SELECT pg_advisory_lock(hashtextextended('job_runs:reminders', 0))" \
  -c "SELECT pg_sleep(120)" >/dev/null 2>&1 &
lock_holder=$!
for _ in {1..20}; do
  [[ "$(admin 5432 postgres -c "${advisory_locks}")" == "1" ]] && break
  sleep 0.5
done
[[ "$(admin 5432 postgres -c "${advisory_locks}")" == "1" ]] || die "backup_ro did not take the lock"
admin 5432 postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'backup_ro'" >/dev/null
wait "${lock_holder}" || true
for _ in {1..20}; do
  [[ "$(admin 5432 postgres -c "${advisory_locks}")" == "0" ]] && break
  sleep 0.5
done
[[ "$(admin 5432 postgres -c "${advisory_locks}")" == "0" ]] || die "the lock outlived the session"

step "A real drop fails against the last backup, and a same-size overwrite does not"
admin 5432 postgres -c "DELETE FROM public.job_runs WHERE job_name = 'reminders' AND status = 'succeeded'"
expect_failure "public.job_runs fell" run_backup backup_ro 5432 "${backups}"
admin 5432 postgres -c "INSERT INTO public.job_runs (job_name, status, finished_at) SELECT 'reminders', 'succeeded', now() FROM generate_series(1, 6)"
admin 5432 postgres -c "UPDATE public.tasks SET description = 'overwritten'"
run_backup backup_ro 5432 "${backups}"
echo "a same-size overwrite passed the drop check, the limit docs/BACKUPS.md states"

step "Recovery into a new project's starting state, as docs/BACKUPS.md describes"
BACKUP_TEST_DATABASE_URL="postgres://postgres@localhost:5434/postgres" \
  BACKUP_RLS_PATH="${rls_path}" \
  node scripts/prepare-backup-db.ts recovery
as_owner=(psql -X -q -v ON_ERROR_STOP=1 -h localhost -p 5434 -U migration_owner -d postgres)
"${as_owner[@]}" -f supabase/migrations/20261104000001_default_privileges.sql
"${as_owner[@]}" -f backup/create-backup-role.psql
[[ "$(admin 5434 postgres -c "SELECT rolsuper FROM pg_roles WHERE rolname = 'migration_owner'")" == "f" ]] \
  || die "the recovery must restore as a role that is not a superuser, as on the platform"
age --decrypt -i "${keys}/holder-1" "${archive}" | pg_restore --list >"${work_dir}/recovery-full-list"
grep -q ' DEFAULT ACL public DEFAULT PRIVILEGES FOR SEQUENCES ' "${work_dir}/recovery-full-list" \
  || die "the dump should carry the platform's default privileges"

# Without the filter's DEFAULT ACL entry, the first such line rolls back the whole restore.
grep -Ev '^[0-9]+; [0-9]+ [0-9]+ (POLICY |SCHEMA - public )' "${work_dir}/recovery-full-list" >"${work_dir}/unfiltered-list"
expect_failure "permission denied to change default privileges" restore_to_recovery "${work_dir}/unfiltered-list"
[[ "$(admin 5434 postgres -c "SELECT count(*) ${tables_in_scope}")" == "0" ]] \
  || die "the failed restore should have left no tables"

restore_list "${work_dir}/recovery-full-list" >"${work_dir}/recovery-list"
restore_to_recovery "${work_dir}/recovery-list"
[[ "$(admin 5434 postgres -c "SELECT count(*) FROM public.task_reassignments")" == "1" ]] \
  || die "the recovered project lost its task_reassignments row"
[[ "$(admin 5434 postgres -c "SELECT count(*) FROM public.events WHERE post_attempt_at IS NOT NULL")" == "1" ]] \
  || die "the recovered project lost its post_attempt_at value"

# Stands in for step 6's repair: the Supabase CLI creates this table and records the versions.
admin 5434 postgres <<'SQL'
CREATE SCHEMA supabase_migrations AUTHORIZATION migration_owner;
CREATE TABLE supabase_migrations.schema_migrations (
  version text PRIMARY KEY,
  statements text[],
  name text
);
ALTER TABLE supabase_migrations.schema_migrations OWNER TO migration_owner;
SQL
sed -n 's/^migration //p' "${manifest_copy}" | while read -r version; do
  admin 5434 postgres -c "INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('${version}')"
done

# The filter drops policies, so this brings back whichever path the new server allows,
# for every table the catalog lists.
"${as_owner[@]}" --single-transaction -f backup/grant-backup-role.psql
admin 5434 postgres -c "ALTER ROLE backup_ro LOGIN"

step "The recovered project's access matches the original's exactly"
access_of() {
  admin "$1" postgres <<'SQL'
SELECT 'table', grantee, table_schema, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema IN ('public', 'history')
UNION ALL
SELECT 'column', grantee, table_schema, table_name || '.' || column_name, privilege_type
FROM information_schema.column_privileges
WHERE table_schema IN ('public', 'history')
UNION ALL
SELECT 'routine', grantee, routine_schema, routine_name, privilege_type
FROM information_schema.role_routine_grants
WHERE routine_schema IN ('public', 'history')
UNION ALL
SELECT 'schema', r.rolname, n.nspname, '', p.priv
FROM pg_namespace n
CROSS JOIN pg_roles r
CROSS JOIN (VALUES ('USAGE'), ('CREATE')) AS p (priv)
WHERE n.nspname IN ('public', 'history')
  AND r.rolname IN ('anon', 'authenticated', 'service_role', 'backup_ro')
  AND has_schema_privilege(r.oid, n.oid, p.priv)
UNION ALL
SELECT 'sequence', 'backup_ro', n.nspname, c.relname, 'SELECT'
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'history')
  AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege('backup_ro', c.oid, 'SELECT') ELSE false END
UNION ALL
SELECT 'policy', array_to_string(roles, ','), schemaname, tablename || '.' || policyname,
       permissive || ' ' || cmd || ' ' || coalesce(qual, '')
FROM pg_policies
WHERE schemaname IN ('public', 'history')
UNION ALL
SELECT 'role', rolname, '', '', rolbypassrls::text
FROM pg_roles
WHERE rolname = 'backup_ro'
UNION ALL
SELECT 'rls', '', n.nspname, c.relname, c.relrowsecurity::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'history') AND c.relkind = 'r'
UNION ALL
SELECT 'trigger', '', c.relname, t.tgname, ''
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'history') AND NOT t.tgisinternal
ORDER BY 1, 2, 3, 4, 5;
SQL
}
access_of 5432 >"${work_dir}/access-original"
access_of 5434 >"${work_dir}/access-recovered"
[[ -s "${work_dir}/access-original" ]] || die "read no access rules from the original"
diff "${work_dir}/access-original" "${work_dir}/access-recovered" \
  || die "the recovered project's access differs from the original's"
grep -q 'service_role|public|tasks|SELECT' "${work_dir}/access-recovered" \
  || die "the bot's role lost its access"
if grep -Eq '^table\|(anon|authenticated|PUBLIC)\|' "${work_dir}/access-recovered"; then
  die "a public role holds a table grant"
fi
echo "ok: grants, policies, row level security and triggers match"

step "The guide's schema check passes, and notices a missing guard"
schema_check_of 5432 >"${work_dir}/schema-original"
schema_check_of 5434 >"${work_dir}/schema-recovered"
[[ -s "${work_dir}/schema-original" ]] || die "the schema check returned nothing"
diff "${work_dir}/schema-original" "${work_dir}/schema-recovered" \
  || die "the recovered project's schema differs from the original's"
admin 5434 postgres -c "ALTER TABLE public.tasks DROP CONSTRAINT tasks_completed_matches_status"
if diff "${work_dir}/schema-original" <(schema_check_of 5434) >/dev/null; then
  die "the schema check did not notice a dropped constraint"
fi
admin 5434 postgres -c "ALTER TABLE public.tasks ADD CONSTRAINT tasks_completed_matches_status CHECK ((completed_at IS NOT NULL) = (status = 'done'))"
diff "${work_dir}/schema-original" <(schema_check_of 5434) \
  || die "the schema check should match again"

step "A backup of the recovered project matches the restored one"
recovered="${work_dir}/recovered"
mkdir "${recovered}"
cp "${manifest_copy}" "${recovered}/latest.manifest.txt"
run_backup backup_ro 5434 "${recovered}"
if ! diff <(grep '^table ' "${manifest_copy}") <(grep '^table ' "${recovered}/latest.manifest.txt"); then
  die "the recovered project's row counts differ from the backup's"
fi
if ! diff <(grep '^migration ' "${manifest_copy}") <(grep '^migration ' "${recovered}/latest.manifest.txt"); then
  die "the recovered project's migrations differ from the backup's"
fi

echo
echo "test-backup-restore: all steps passed (${rls_path})"
