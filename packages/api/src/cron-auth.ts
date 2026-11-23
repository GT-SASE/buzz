import { createHash, timingSafeEqual } from "node:crypto";

const MIN_SECRET_LENGTH = 32;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** An unset or short secret refuses everything, and is worth an operator's notice. */
export function isCronSecretUsable(
  secret: string | undefined,
): secret is string {
  return secret !== undefined && secret.trim().length >= MIN_SECRET_LENGTH;
}

/**
 * Whether a request's `Authorization` value is the cron secret. Nothing else about a
 * request authorizes it: `x-vercel-cron-*` headers and the user agent can be sent by
 * anyone. The URL is assumed public.
 *
 * Digests are compared so the comparison does not reveal the secret's length. The
 * secret is trimmed like every other setting, because a pasted value can bring a
 * trailing newline that no request's header can carry. The header is not trimmed.
 */
export function isCronAuthorized(
  authorization: string | null,
  secret: string | undefined,
): boolean {
  if (authorization === null || !isCronSecretUsable(secret)) {
    return false;
  }
  return timingSafeEqual(
    digest(authorization),
    digest(`Bearer ${secret.trim()}`),
  );
}
