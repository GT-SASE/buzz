import { createHmac, timingSafeEqual } from "node:crypto";

import { TRPCError } from "@trpc/server";

/**
 * Rotating check-in codes. The QR on the projector changes every window, so a
 * photograph of it stops admitting people about a minute later.
 *
 * A code is `<key><mac>`: `key` is the event's stored `checkInCode`, which
 * only finds the row, and `mac` is the first MAC_LENGTH characters of
 * HMAC-SHA256(secret, "<event id>:<window>") in the same alphabet. The stored
 * key alone admits nobody, so an old printed poster, an old bookmark or a
 * screenshot of the pre-rotation QR is refused. The secret is derived from
 * AUTH_SECRET, so there is no new environment variable to set.
 *
 * A code is valid in the window it was issued and the one before it: a member
 * who scans just as the QR flips, or reads it off the screen and types it,
 * still gets in.
 */

/** How long one code is on screen. */
export const WINDOW_MS = 30_000;

/** Windows a code is accepted in, counting the one it was issued for. */
export const WINDOWS_ACCEPTED = 2;

/** Same alphabet as the stored key, so one scanner regex covers both. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const MAC_LENGTH = 8;

function secret() {
  const base = process.env.AUTH_SECRET;
  if (!base) {
    // Fail closed. Falling back to a constant would make every code forgeable.
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Check-in is not configured on this deployment.",
    });
  }
  return createHmac("sha256", base).update("buzz:check-in:v1").digest();
}

export function windowAt(now: number) {
  return Math.floor(now / WINDOW_MS);
}

/** When the window that contains `now` ends, in epoch milliseconds. */
export function windowEnd(now: number) {
  return (windowAt(now) + 1) * WINDOW_MS;
}

function mac(eventId: string, window: number) {
  const digest = createHmac("sha256", secret())
    .update(`${eventId}:${window}`)
    .digest();
  let out = "";
  for (let i = 0; i < MAC_LENGTH; i++) {
    // 256 % 30 is not 0, so the first characters are very slightly likelier;
    // the bias is far below what guessing 30^8 values could use.
    out += ALPHABET[digest[i]! % ALPHABET.length];
  }
  return out;
}

/** The code to show for `window`. */
export function checkInCodeFor(
  event: { id: string; checkInCode: string },
  now: number = Date.now(),
) {
  return event.checkInCode + mac(event.id, windowAt(now));
}

/**
 * Whether `submitted` (already normalised) is a code this event accepts at
 * `now`: its key is followed by the MAC of the current or previous window.
 */
export function checkInCodeIsCurrent(
  event: { id: string; checkInCode: string },
  submitted: string,
  now: number = Date.now(),
) {
  if (!submitted.startsWith(event.checkInCode)) return false;
  const given = Buffer.from(submitted.slice(event.checkInCode.length));
  const current = windowAt(now);
  let ok = false;
  // Every window is compared, so the time taken does not say which matched.
  for (let back = 0; back < WINDOWS_ACCEPTED; back++) {
    const want = Buffer.from(mac(event.id, current - back));
    if (given.length === want.length && timingSafeEqual(given, want)) ok = true;
  }
  return ok;
}
