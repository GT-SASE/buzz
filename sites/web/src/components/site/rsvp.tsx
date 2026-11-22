"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useSyncExternalStore,
} from "react";

import {
  fetchRsvped,
  fetchSignedIn,
  RsvpRequestError,
  sendCancel,
  sendRsvp,
} from "~/lib/rsvp-client";

/**
 * RSVP on the public event pages, which are prerendered and so cannot know who
 * is looking. The server renders the signed-out answer, a "Sign in to RSVP"
 * link, and passes it in as `children`. After the page paints, `RsvpProvider`
 * asks whether there is a session and which events it has RSVPed to, once for
 * the whole page, and `RsvpControl` swaps the link for the member's own state.
 * A signed-out visitor never sees anything change.
 *
 * Plain markup and plain `fetch`, no `cn`, ui kit, icon library or tRPC client:
 * this file is client JS on every /events page. tests/public-bundle.test.ts
 * keeps those imports out.
 */

type Session = "checking" | "signed-out" | "signed-in";

type Entry = {
  going: boolean;
  busy: boolean;
  /** The visitor did something, so the result is announced. Loading is not. */
  acted: boolean;
  /** What happened beyond "going": a calendar invite, a cancellation. */
  detail: string;
  error: string;
};

const idle: Entry = {
  going: false,
  busy: false,
  acted: false,
  detail: "",
  error: "",
};

type State = { session: Session; entries: Record<string, Entry> };

type Action =
  | { type: "signed-out" }
  | { type: "signed-in"; going: string[] }
  | { type: "busy"; id: string }
  | { type: "done"; id: string; going: boolean; detail: string }
  | { type: "failed"; id: string; error: string };

function reduce(state: State, action: Action): State {
  const at = (id: string) => state.entries[id] ?? idle;
  const put = (id: string, entry: Entry): State => ({
    ...state,
    entries: { ...state.entries, [id]: entry },
  });
  switch (action.type) {
    case "signed-out":
      return { ...state, session: "signed-out" };
    case "signed-in":
      return {
        session: "signed-in",
        entries: Object.fromEntries(
          action.going.map((id) => [id, { ...idle, going: true }]),
        ),
      };
    case "busy":
      return put(action.id, { ...at(action.id), busy: true, error: "" });
    case "done":
      return put(action.id, {
        going: action.going,
        busy: false,
        acted: true,
        detail: action.detail,
        error: "",
      });
    case "failed":
      return put(action.id, {
        ...at(action.id),
        busy: false,
        error: action.error,
      });
  }
}

type Rsvp = {
  session: Session;
  entries: Record<string, Entry>;
  act: (eventId: string, going: boolean) => Promise<void>;
};

const RsvpContext = createContext<Rsvp | null>(null);

/** `?rsvp=1`: the sign-in round trip says "RSVP when I get back". */
function returnedToRsvp() {
  return new URLSearchParams(window.location.search).get("rsvp") === "1";
}

/** So a refresh does not ask again. */
function forgetReturnedToRsvp() {
  const url = new URL(window.location.href);
  url.searchParams.delete("rsvp");
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

/**
 * The visitor's own click on "Sign in to RSVP", remembered for this tab. The
 * URL alone cannot be trusted to mean "RSVP me": anyone can send a signed-in
 * member a link ending in `?rsvp=1`, and a state change that a link can cause
 * is the one thing a cross-site page must not be able to do. A tab's
 * `sessionStorage` survives the trip to Google and back and is not something
 * another site can write. Storage that is blocked just means nothing is
 * remembered: the visitor comes back to an RSVP button instead.
 */
const INTENT_KEY = "buzz:rsvp-intent";
const INTENT_TTL_MS = 15 * 60 * 1000;

function rememberIntent(eventId: string) {
  try {
    window.sessionStorage.setItem(
      INTENT_KEY,
      JSON.stringify({ id: eventId, at: Date.now() }),
    );
  } catch {
    // Blocked storage: the RSVP button is the fallback.
  }
}

/** True once, and only for the event the visitor asked about a moment ago. */
function takeIntent(eventId: string) {
  try {
    const stored = window.sessionStorage.getItem(INTENT_KEY);
    window.sessionStorage.removeItem(INTENT_KEY);
    if (!stored) return false;
    const intent = JSON.parse(stored) as { id?: unknown; at?: unknown };
    return (
      intent.id === eventId &&
      typeof intent.at === "number" &&
      Date.now() - intent.at < INTENT_TTL_MS
    );
  } catch {
    return false;
  }
}

/**
 * One session check and one RSVP lookup for every control inside it.
 * `eventIds` are the events a control may appear for. `returnTo` is the one
 * event whose page is the landing spot after sign-in. Arriving there with
 * `?rsvp=1` drops the flag, and if the visitor asked to RSVP on this tab (see
 * `rememberIntent`) and has a session, RSVPs once and shows the confirmed state.
 */
export function RsvpProvider({
  eventIds,
  returnTo,
  children,
}: {
  eventIds: string[];
  returnTo?: string;
  children: React.ReactNode;
}) {
  const [state, dispatch] = useReducer(reduce, {
    session: "checking",
    entries: {},
  });
  const ids = eventIds.join(",");

  const act = useCallback(async (eventId: string, going: boolean) => {
    dispatch({ type: "busy", id: eventId });
    try {
      if (going) {
        const { invited } = await sendRsvp(eventId);
        dispatch({
          type: "done",
          id: eventId,
          going: true,
          detail: invited ? "Calendar invite sent." : "",
        });
      } else {
        const { uninvited } = await sendCancel(eventId);
        dispatch({
          type: "done",
          id: eventId,
          going: false,
          detail: uninvited
            ? "RSVP cancelled and taken off your calendar."
            : "RSVP cancelled.",
        });
      }
    } catch (error) {
      dispatch({
        type: "failed",
        id: eventId,
        error:
          error instanceof RsvpRequestError
            ? error.message
            : "Could not save that. Try again.",
      });
    }
  }, []);

  useEffect(() => {
    if (!ids) return;
    let cancelled = false;
    void (async () => {
      if (!(await fetchSignedIn())) {
        if (!cancelled) dispatch({ type: "signed-out" });
        return;
      }
      let going: string[] = [];
      try {
        going = await fetchRsvped(ids.split(","));
      } catch {
        // Unknown counts as not going: the button is still right, and an RSVP
        // that already exists is a no-op on the server.
      }
      if (cancelled) return;
      dispatch({ type: "signed-in", going });
      if (returnTo && returnedToRsvp()) {
        forgetReturnedToRsvp();
        const asked = takeIntent(returnTo);
        if (asked && !going.includes(returnTo)) await act(returnTo, true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ids, returnTo, act]);

  const value = useMemo(
    () => ({ session: state.session, entries: state.entries, act }),
    [state, act],
  );
  return <RsvpContext value={value}>{children}</RsvpContext>;
}

const noSubscription = () => () => undefined;

const primary =
  "bg-navy hover:bg-navy-deep text-body-sm inline-flex min-h-11 items-center justify-center rounded-full px-6 py-3 font-semibold text-white transition disabled:opacity-70";
/** The site's primary `Button`, resolved, for the one RSVP that leads a page. */
const primaryLarge =
  "group bg-navy hover:bg-navy-deep text-body inline-flex items-center justify-center gap-3 rounded-full px-7 py-4 font-bold [font-stretch:112%] text-white transition duration-200 disabled:opacity-70 max-sm:min-w-0 max-sm:whitespace-normal";
const quiet =
  "text-navy decoration-gold hover:text-gold-ink text-body-sm inline-flex min-h-11 items-center py-3 font-semibold underline decoration-2 underline-offset-4 transition disabled:opacity-60";
/** Going, at the pill's size, in the gold of the portal's "Going" badge. */
const goingLarge =
  "bg-gold-bright text-navy text-body inline-flex items-center justify-center rounded-full px-7 py-4 font-bold [font-stretch:112%]";
const quietLarge = quiet.replace("text-body-sm", "text-body");

function Check() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4 shrink-0"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/**
 * The RSVP slot for one event: its own row, at least a button tall, so
 * swapping the sign-in link for the member's state moves nothing.
 * `children` is the signed-out link the server rendered.
 */
export function RsvpControl({
  eventId,
  title,
  startsAt,
  prominent = false,
  children,
}: {
  eventId: string;
  title: string;
  /** ISO time. RSVPs close at the start, as the server enforces. */
  startsAt: string;
  /** The page's lead action: the large pill, with the slot sized to it. */
  prominent?: boolean;
  children: React.ReactNode;
}) {
  const rsvp = useContext(RsvpContext);
  // False while hydrating, so the first client render matches the server's.
  const closed = useSyncExternalStore(
    noSubscription,
    () => Date.now() >= Date.parse(startsAt),
    () => false,
  );
  if (!rsvp) return <div className="w-full">{children}</div>;

  const entry = rsvp.entries[eventId] ?? idle;
  const signedIn = rsvp.session === "signed-in";
  const going = signedIn && entry.going;
  const forTitle = <span className="sr-only"> for {title}</span>;

  let body: React.ReactNode;
  if (closed && !going) {
    body = (
      <span className="text-ink-muted text-body-sm py-3">
        RSVPs are closed.
      </span>
    );
  } else if (!signedIn) {
    // `contents` keeps the wrapper out of the layout; the click still passes through it.
    body = (
      <div className="contents" onClickCapture={() => rememberIntent(eventId)}>
        {children}
      </div>
    );
  } else if (going) {
    body = (
      <>
        {prominent ? (
          <span className={goingLarge}>You&rsquo;re going</span>
        ) : (
          <span className="text-navy text-body-sm inline-flex items-center gap-2 py-3 font-semibold">
            <Check />
            You&rsquo;re going
          </span>
        )}
        {!closed && (
          <button
            type="button"
            className={prominent ? quietLarge : quiet}
            disabled={entry.busy}
            onClick={() => void rsvp.act(eventId, false)}
          >
            {entry.busy ? "Cancelling…" : "Cancel RSVP"}
            {forTitle}
          </button>
        )}
      </>
    );
  } else {
    body = (
      <button
        type="button"
        className={prominent ? primaryLarge : primary}
        disabled={entry.busy}
        onClick={() => void rsvp.act(eventId, true)}
      >
        {entry.busy ? "Saving…" : "RSVP"}
        {forTitle}
      </button>
    );
  }

  const announcement = !entry.acted
    ? ""
    : going
      ? `You're going.${entry.detail ? ` ${entry.detail}` : ""}`
      : entry.detail;

  return (
    <div className="w-full">
      <div
        className={`flex flex-wrap items-center gap-x-5 gap-y-1 ${prominent ? "min-h-[3.6rem]" : "min-h-11"}`}
      >
        {body}
        {entry.detail && (
          <span aria-hidden="true" className="text-ink-muted text-body-sm">
            {entry.detail}
          </span>
        )}
      </div>
      {entry.error && (
        <p role="alert" className="text-destructive text-body-sm pb-2">
          {entry.error}
        </p>
      )}
      {/* Always present, so a screen reader is already listening when it fills. */}
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}
