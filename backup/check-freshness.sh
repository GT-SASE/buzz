#!/usr/bin/env bash
#
# Fails if the reminder job has stopped succeeding, using the job_runs table. Vercel Cron
# delivers on a best-effort basis and raises no alert when it misses a run, so this check
# comes from outside Vercel.
#
# Only the latest successful run counts, because a failed row is no evidence of health. A
# failed run is caught by the next check, once the last success has aged past the limit.
# Reads a time only, because job_runs.error and .results may hold text that must not reach
# a log.
#
# Connection settings come from libpq's PG* environment variables.

set -euo pipefail

# A daily cron can fire anywhere within its hour, so 26 hours would be too tight for the
# job that raises the alert. This still fails on the first day a run is missed.
readonly MAX_SUCCESS_AGE_HOURS=30

die() {
  echo "check-freshness: $*" >&2
  exit 1
}

[[ "${PGSSLMODE:-}" == "verify-full" ]] || die "PGSSLMODE must be verify-full"

age_seconds="$(
  psql -X -q -A -t -v ON_ERROR_STOP=1 <<'SQL'
SELECT extract(epoch FROM now() - started_at)::bigint
FROM public.job_runs
WHERE job_name = 'reminders' AND status = 'succeeded'
ORDER BY started_at DESC
LIMIT 1;
SQL
)" || die "could not read job_runs"

[[ -n "${age_seconds}" ]] || die "reminders has never succeeded"
[[ "${age_seconds}" =~ ^-?[0-9]+$ ]] || die "unexpected output from job_runs"

# Both times come from the database's clock, so a real run cannot be dated in the future. Such
# a row says nothing about the job, and would otherwise look like the freshest run possible.
if ((age_seconds < 0)); then
  die "the latest successful reminders run is dated in the future, check job_runs"
fi

if ((age_seconds > MAX_SUCCESS_AGE_HOURS * 3600)); then
  die "reminders last succeeded $((age_seconds / 3600)) hours ago, the limit is ${MAX_SUCCESS_AGE_HOURS}"
fi

echo "check-freshness: reminders last succeeded $((age_seconds / 3600)) hours ago"
