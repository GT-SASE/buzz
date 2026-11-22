/**
 * Plain `fetch` calls to the endpoints the public event pages need after they
 * paint: is this visitor signed in, which of these events have they RSVPed to,
 * and RSVP or cancel. They go to the same tRPC procedures the portal uses, so
 * the rate limit and the "already started" rule are the server's, not copied
 * here.
 *
 * Not the tRPC React client: that and react-query, superjson and zod would put
 * most of the portal's data layer into every public page. The wire format is
 * tRPC's with the superjson transformer, `{ json: value }` both ways, and every
 * value here is a plain string, boolean or array of strings, so there is no
 * `meta` to carry. tests/public-bundle.test.ts keeps this file's imports empty.
 */

const TRPC = "/api/trpc";

const OFFLINE = "Could not reach the server. Try again.";
const SESSION_ENDED = "Your sign-in expired. Sign in again to RSVP.";

/** A message fit to show the visitor, from the server or from this file. */
export class RsvpRequestError extends Error {}

type Envelope = {
  result?: { data?: { json?: unknown } };
  error?: { json?: { message?: string; data?: { code?: string } } };
};

async function trpc<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${TRPC}/${path}`, init);
  } catch {
    throw new RsvpRequestError(OFFLINE);
  }
  let body: Envelope;
  try {
    body = (await response.json()) as Envelope;
  } catch {
    throw new RsvpRequestError(OFFLINE);
  }
  if (!response.ok || !body.result) {
    const error = body.error?.json;
    // The bare code is not a sentence; say what happened.
    if (error?.data?.code === "UNAUTHORIZED") {
      throw new RsvpRequestError(SESSION_ENDED);
    }
    throw new RsvpRequestError(error?.message ?? OFFLINE);
  }
  return body.result.data?.json as T;
}

function mutate<T>(procedure: string, eventId: string) {
  return trpc<T>(procedure, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ json: { eventId } }),
  });
}

/**
 * Whether there is a session. Anything but a clear yes is "no": a visitor who
 * is wrongly shown the sign-in link just signs in again, and the sign-in page
 * sends someone already signed in straight back.
 */
export async function fetchSignedIn() {
  try {
    const response = await fetch("/api/auth/session");
    if (!response.ok) return false;
    const session = (await response.json()) as { user?: unknown } | null;
    return Boolean(session?.user);
  } catch {
    return false;
  }
}

/** The ids, of those asked about, this member has RSVPed to. */
export function fetchRsvped(eventIds: string[]) {
  const input = encodeURIComponent(JSON.stringify({ json: { eventIds } }));
  return trpc<string[]>(`event.myRsvps?input=${input}`, {});
}

export function sendRsvp(eventId: string) {
  return mutate<{ invited: boolean }>("event.rsvp", eventId);
}

export function sendCancel(eventId: string) {
  return mutate<{ uninvited: boolean }>("event.cancelRsvp", eventId);
}
