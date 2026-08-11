/**
 * Who is an officer.
 *
 * The allowlist is the seed, not the source of truth: it decides the role a
 * brand-new account is created with, and promotes an existing account the next
 * time it signs in. After that the `role` column governs, so removing an
 * address here does not silently demote someone mid-semester — that is a
 * deliberate database edit.
 *
 * Exact addresses only. Fail closed: with no ADMIN_EMAILS set, nobody is
 * promoted on sign-in — use `pnpm db:studio` or set the env for the first
 * officer.
 *
 * Prefer wiring through the app's `@t3-oss/env-nextjs` schema via
 * `configureAdminEmails` so empty strings are treated as unset. Falls back to
 * `process.env.ADMIN_EMAILS` for tests and scripts.
 */

type AdminEmailsReader = () => string | undefined;

let adminEmailsReader: AdminEmailsReader | undefined;

/** Called once from the Next app after `env` is validated. */
export function configureAdminEmails(reader: AdminEmailsReader) {
  adminEmailsReader = reader;
}

function allowlist() {
  const configured = adminEmailsReader
    ? adminEmailsReader()
    : process.env.ADMIN_EMAILS;
  if (!configured) return [];
  return configured
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0 && !entry.startsWith("@"));
}

/** Gmail ignores dots and anything after a `+`; two spellings, one inbox. */
function canonical(email: string) {
  const [name, domain] = email.trim().toLowerCase().split("@");
  if (!name || !domain) return email.trim().toLowerCase();
  if (domain !== "gmail.com" && domain !== "googlemail.com") {
    return `${name}@${domain}`;
  }
  return `${name.split("+")[0]!.replace(/\./g, "")}@gmail.com`;
}

export function isOfficerEmail(email: string | null | undefined) {
  if (!email) return false;
  const address = canonical(email);

  return allowlist().some((entry) => canonical(entry) === address);
}
