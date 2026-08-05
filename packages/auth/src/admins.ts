/**
 * Who is an officer.
 *
 * The allowlist is the seed, not the source of truth: it decides the role a
 * brand-new account is created with, and promotes an existing account the next
 * time it signs in. After that the `role` column governs, so removing an
 * address here does not silently demote someone mid-semester — that is a
 * deliberate database edit.
 *
 * Entries are either an exact address or `@domain`, which matches everyone on
 * that domain. Override the defaults with the ADMIN_EMAILS environment
 * variable, comma-separated.
 */
const DEFAULT_ADMINS = ["aamoghsawantt@gmail.com"];

function allowlist() {
  const configured = process.env.ADMIN_EMAILS;
  const entries = configured ? configured.split(",") : DEFAULT_ADMINS;
  return entries
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
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
  const domain = address.slice(address.indexOf("@"));

  return allowlist().some((entry) =>
    entry.startsWith("@") ? entry === domain : canonical(entry) === address,
  );
}
