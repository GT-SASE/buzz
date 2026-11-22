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

/** So a refresh does not ask again. The RSVP itself is idempotent anyway. */
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
 * One session check and one RSVP lookup for every control inside it.
 * `eventIds` are the events a control may appear for. `returnTo` is the one
 * event whose page is the landing spot after sign-in: arriving with `?rsvp=1`
 * and a session RSVPs once, shows the confirmed state and drops the parameter.
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
        if (!going.includes(returnTo)) await act(returnTo, true);
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
const quiet =
  "text-navy decoration-gold hover:text-gold-ink text-body-sm inline-flex min-h-11 items-center py-3 font-semibold underline decoration-2 underline-offset-4 transition disabled:opacity-60";

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
  children,
}: {
  eventId: string;
  title: string;
  /** ISO time. RSVPs close at the start, as the server enforces. */
  startsAt: string;
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
    body = children;
  } else if (going) {
    body = (
      <>
        <span className="text-navy text-body-sm inline-flex items-center gap-2 py-3 font-semibold">
          <Check />
          You&rsquo;re going
        </span>
        {!closed && (
          <button
            type="button"
            className={quiet}
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
        className={primary}
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
      <div className="flex min-h-11 flex-wrap items-center gap-x-5 gap-y-1">
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
