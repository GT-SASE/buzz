#!/usr/bin/env bash
#
# Canary test for the gitleaks configuration.
#
# Builds a fake value for each custom rule at runtime, in a temp directory, and
# asserts that the expected rule reports it. Harmless lines must report nothing.
# Values are assembled here rather than written literally so that this file
# never looks like it holds a secret.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly repo_root
readonly gitleaks="${repo_root}/.tools/gitleaks"
readonly custom_config="${repo_root}/.gitleaks-custom.toml"
readonly default_config="${repo_root}/.gitleaks.toml"

# Isolate from the caller's git settings and any hook environment.
# shellcheck source=scripts/lib/git-test-env.sh
source "${repo_root}/scripts/lib/git-test-env.sh"

if [[ ! -x "${gitleaks}" ]]; then
  echo "test-gitleaks-rules: ${gitleaks#"${repo_root}/"} not found." >&2
  echo "Run: npm run gitleaks:install" >&2
  exit 1
fi

pinned_version="$(cat "${repo_root}/.gitleaks-version")"
actual_version="$("${gitleaks}" version)"
if [[ "${actual_version}" != "${pinned_version}" ]]; then
  echo "test-gitleaks-rules: gitleaks is ${actual_version}, ${pinned_version} is pinned." >&2
  echo "Run: npm run gitleaks:install" >&2
  exit 1
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT

failures=0
case_number=0

# Prints N lowercase hex characters, N <= 64.
random_hex() {
  local hex
  hex="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
  printf '%s' "${hex:0:$1}"
}

random_upper() {
  random_hex "$1" | tr 'a-f' 'A-F'
}

supabase_key() {
  printf 'sb_%s_%s' secret "$(random_hex 40)"
}

# scan <config> <file name> <content>: sets report to the JSON report path.
scan() {
  case_number=$((case_number + 1))
  local scan_dir="${work_dir}/case-${case_number}"
  report="${work_dir}/report-${case_number}.json"
  mkdir -p "${scan_dir}"
  printf '%s\n' "$3" >"${scan_dir}/$2"
  # gitleaks exits 1 both for a finding and for a fatal error, so the exit code
  # is not the assertion. The report contents are.
  "${gitleaks}" dir "${scan_dir}" --config "$1" --no-banner --redact \
    --log-level error --report-format json --report-path "${report}" || true
}

check_detected() {
  local rule="$1" label="$2"
  if [[ -f "${report}" ]] && grep -q "\"RuleID\": \"${rule}\"" "${report}"; then
    echo "PASS  ${rule}: ${label}"
  else
    echo "FAIL  ${rule}: ${label}: not detected" >&2
    failures=$((failures + 1))
  fi
}

expect_detected() {
  scan "${custom_config}" sample.txt "$2"
  check_detected "$1" "${3:-detected}"
}

expect_detected_in_file() {
  scan "${custom_config}" "$2" "$3"
  check_detected "$1" "detected in $2"
}

expect_clean() {
  local label="$1" content="$2" file="${3:-sample.txt}"
  scan "${custom_config}" "${file}" "${content}"
  if [[ -f "${report}" ]] && [[ "$(tr -d '[:space:]' <"${report}")" == "[]" ]]; then
    echo "PASS  ${label}: no finding"
  else
    echo "FAIL  ${label}: unexpected finding or scan error" >&2
    failures=$((failures + 1))
  fi
}

at='@'

expect_detected "supabase-secret-key" "key = $(supabase_key)"

expect_detected "age-secret-key" "$(printf 'AGE-%s-KEY-1' SECRET)$(random_upper 58)" "classic"
expect_detected "age-secret-key" "$(printf 'AGE-%s-KEY-PQ-1' SECRET)$(random_upper 60)" "post-quantum"

bot_token="M$(random_hex 25).$(random_hex 6).$(random_hex 38)"
expect_detected "discord-bot-token" "token: ${bot_token}" "plain"
expect_detected "discord-bot-token" "token: tok_${bot_token}" "with a tok_ prefix"
expect_detected "discord-bot-token" "token: x${bot_token}" "with a letter prefix"

expect_detected "discord-webhook-url" \
  "$(printf 'https://discord.com/api/%s/' webhooks)1$(printf '%017d' 7)/$(random_hex 60)" "discord.com"
expect_detected "discord-webhook-url" \
  "$(printf 'https://ptb.discordapp.com/api/v10/%s/' webhooks)1$(printf '%017d' 7)/$(random_hex 60)" "versioned discordapp.com"

expect_detected "postgres-connection-password" \
  "$(printf 'postgres://app:%s%sdb.host/main' "$(random_hex 12)" "${at}")" "postgres"
expect_detected "postgres-connection-password" \
  "$(printf 'postgresql://app:%s%sdb.host/main' "$(random_hex 12)" "${at}")" "postgresql"

expect_detected "discord-snowflake" "guild = 1$(printf '%017d' 42)" "18 digits"
expect_clean "16 digit number" "value = 1$(printf '%015d' 42)"

expect_detected "email-address" "contact $(printf 'a.person%smail' "${at}").org"
expect_clean "GitHub no-reply address" "$(printf '1+someone%susers.noreply.github' "${at}").com"
expect_clean "no-reply address" "$(printf 'noreply%sgithub' "${at}").com"
expect_clean "Dependabot sign-off address" "$(printf 'support%sgithub' "${at}").com"
expect_clean "example address" "$(printf 'someone%sexample' "${at}").com"
expect_clean "example subdomain address" "$(printf 'someone%smail.example' "${at}").org"
expect_clean ".invalid address" "$(printf 'someone%sany' "${at}").invalid"
expect_clean ".test address" "$(printf 'someone%sany' "${at}").test"

for name in DISCORD_BOT_TOKEN SUPABASE_SECRET_KEY CRON_SECRET BACKUP_PGPASSWORD PGPASSWORD; do
  expect_detected "named-secret-env-assignment" "${name}=$(random_hex 12)" "${name} plain"
  expect_detected "named-secret-env-assignment" "export ${name}=\"$(random_hex 12)\"" "${name} quoted"
  expect_detected "named-secret-env-assignment" "\"${name}\": \"$(random_hex 12)\"" "${name} JSON"
  expect_detected "named-secret-env-assignment" "${name}=abc#$(random_hex 12)" "${name} containing #"

  expect_clean "${name} left empty" "${name}="
  expect_clean "${name} from the shell" "${name}=\"\$${name}\""
  expect_clean "${name} from process.env" "const ${name} = process.env.${name};"
  expect_clean "${name} with a non-null assertion" "const ${name} = process.env.${name}!;"
  expect_clean "${name} from process.env brackets" "const ${name} = process.env[\"${name}\"];"
  expect_clean "${name} from import.meta.env" "const ${name} = import.meta.env.${name};"
  expect_clean "${name} from a helper" "${name} = requireEnv(\"${name}\");"
  expect_clean "${name} in a schema" "  ${name}: z.string().min(1),"
done

# A human-chosen password has too little entropy for the default config to report.
low_entropy="$(printf 'Winter%sClub' 2026)"
for name in BACKUP_PGPASSWORD PGPASSWORD; do
  expect_detected "named-secret-env-assignment" "${name}=${low_entropy}" "${name} low entropy"
  expect_detected "named-secret-env-assignment" "export ${name}='${low_entropy}'" "${name} low entropy, quoted"
  expect_clean "${name} from a workflow secret" "${name}: \${{ secrets.${name} }}"
  expect_clean "${name} from another variable" "${name}=\"\${BACKUP_PGPASSWORD}\""
  expect_clean "${name} set to a test constant" "${name}: CANARY_PASSWORD,"
  expect_clean "${name} in a test assertion" "expect(code.match(/${name}:/g)).toHaveLength(2);"
done

expect_detected "pgpass-line" "db.host.test:5432:postgres:app.ref:$(random_hex 20)" "random password"
expect_detected "pgpass-line" "db.host.test:5432:postgres:app.ref:${low_entropy}" "low entropy password"
expect_detected "pgpass-line" "*:*:*:app:${low_entropy}" "wildcard fields"
expect_detected "pgpass-line" "$(printf 'first line\ndb.host.test:6543:main:app:%s\nlast line' "${low_entropy}")" "among other lines"
expect_detected "pgpass-line" "db.host.test:5432:main:app:pa\\:ss${low_entropy}" "escaped colon in the password"
expect_detected_in_file "pgpass-line" .pgpass "db.host.test:5432:postgres:app:${low_entropy}"
expect_clean "colon-separated template string" "\`setup.confirm:0:\${FIRST}:\${SECOND}:admin\`,"
expect_detected "pgpass-line" "/var/run/postgresql:5432:main:app:${low_entropy}" "socket directory as the host"
expect_clean "string with a literal backtick" "\`setup.confirm:0:first:second:admin\`,"
expect_clean "pgpass template" "hostname:port:database:username:password"
expect_clean "pgpass comment" "# db.host.test:5432:postgres:app:${low_entropy}"
expect_clean "host and port only" "db.host.test:5432"
expect_clean "four fields" "db.host.test:5432:postgres:app"
expect_clean "clock time" "at 12:30:45 today"
expect_clean "URL with a port" "https://db.host.test:5432/main:extra"

# gitleaks' default global allowlist must not apply to the project rules.
for file in package-lock.json report.pdf firmware.bin sheet.xlsx; do
  expect_detected_in_file "supabase-secret-key" "${file}" "key = $(supabase_key)"
done
for word in false true null; do
  expect_detected "supabase-secret-key" \
    "key = $(printf 'sb_%s_' secret)$(random_hex 20)${word}" "value containing ${word}"
done

expect_clean "env template" "$(cat "${repo_root}/.env.example")" .env.example

# The default rules must still load and fire.
scan "${default_config}" sample.txt "token = $(printf 'gh%s_' p)$(random_hex 36)"
check_detected "github-pat" "default rules still active"

if ((failures > 0)); then
  echo "${failures} canary check(s) failed." >&2
  exit 1
fi
echo "All ${case_number} canary scans ran and every check passed."
