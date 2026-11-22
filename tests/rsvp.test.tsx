import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";

import { RsvpControl, RsvpProvider } from "~/components/site/rsvp";
import { rsvpSignInPath } from "~/app/portal/_lib/paths";

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + 48 * HOUR).toISOString();
const started = () => new Date(Date.now() - HOUR).toISOString();

type Call = { url: string; method: string; body: string | null };

/** A stand-in for /api/auth/session and the three tRPC procedures. */
function server(options: {
  signedIn: boolean;
  going?: string[];
  /** Status code and tRPC error message for the next RSVP or cancel. */
  failWith?: { status: number; message: string; code?: string };
  statusLookupFails?: boolean;
  offline?: boolean;
}) {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const ok = (value: unknown) => json({ result: { data: { json: value } } });

  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (options.offline && !url.startsWith("/api/auth/session")) {
        throw new TypeError("Failed to fetch");
      }
      if (url.startsWith("/api/auth/session")) {
        return json(options.signedIn ? { user: { id: "me" } } : null);
      }
      if (url.includes("event.myRsvps")) {
        if (options.statusLookupFails) return json({}, 500);
        const input = new URL(url, "http://localhost").searchParams.get(
          "input",
        )!;
        const { eventIds } = (
          JSON.parse(input) as { json: { eventIds: string[] } }
        ).json;
        return ok(eventIds.filter((id) => options.going?.includes(id)));
      }
      if (options.failWith) {
        const { status, message, code } = options.failWith;
        return json(
          {
            error: { json: { message, data: { code: code ?? "BAD_REQUEST" } } },
          },
          status,
        );
      }
      if (url.endsWith("event.rsvp"))
        return ok({ rsvped: true, invited: true });
      if (url.endsWith("event.cancelRsvp")) {
        return ok({ rsvped: false, uninvited: true });
      }
      return json({}, 404);
    },
  ) as unknown as typeof fetch;

  return {
    calls,
    trpc: () => calls.filter((call) => call.url.startsWith("/api/trpc")),
    posts: () => calls.filter((call) => call.method === "POST"),
  };
}

function page(options: {
  ids?: string[];
  returnTo?: string;
  startsAt?: string;
  title?: string;
  prominent?: boolean;
}) {
  const ids = options.ids ?? ["e1"];
  return (
    <RsvpProvider eventIds={ids} returnTo={options.returnTo}>
      {ids.map((id) => (
        <RsvpControl
          key={id}
          eventId={id}
          title={options.title ?? `Event ${id}`}
          startsAt={options.startsAt ?? future()}
          prominent={options.prominent}
        >
          <a href={rsvpSignInPath(id)}>Sign in to RSVP</a>
        </RsvpControl>
      ))}
    </RsvpProvider>
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/events/e1");
  window.sessionStorage.clear();
});
afterEach(cleanup);

describe("what the server renders", () => {
  it("is the sign-in link, so a visitor without JavaScript or a session sees it", () => {
    const html = renderToString(page({}));
    expect(html).toContain("Sign in to RSVP");
    expect(html).toContain(
      `href="${rsvpSignInPath("e1")}"`.replaceAll("&", "&amp;"),
    );
    expect(html).not.toContain("<button");
  });

  it("sends sign-in back to the event page with the RSVP flag", () => {
    expect(rsvpSignInPath("e1")).toBe(
      "/portal/signin?from=%2Fevents%2Fe1%3Frsvp%3D1",
    );
  });
});

describe("signed out", () => {
  it("keeps the sign-in link and asks the server nothing but who is there", async () => {
    const api = server({ signedIn: false });
    render(page({}));
    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(api.calls[0]!.url).toBe("/api/auth/session");
    expect(screen.getByRole("link", { name: "Sign in to RSVP" })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(api.trpc()).toEqual([]);
  });

  it("says RSVPs are closed instead of offering a sign-in for an event that started", async () => {
    server({ signedIn: false });
    render(page({ startsAt: started() }));
    expect(await screen.findByText("RSVPs are closed.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sign in to RSVP" })).toBeNull();
  });
});

describe("signed in, not RSVPed", () => {
  it("replaces the link with an RSVP button named for the event", async () => {
    server({ signedIn: true });
    render(page({ title: "GBM 4" }));
    const button = await screen.findByRole("button", {
      name: "RSVP for GBM 4",
    });
    expect(button).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sign in to RSVP" })).toBeNull();
  });

  it("RSVPs through event.rsvp and shows the confirmed state", async () => {
    const api = server({ signedIn: true });
    render(page({ title: "GBM 4" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "RSVP for GBM 4" }),
    );
    expect(await screen.findByText("You’re going")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Cancel RSVP for GBM 4" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "RSVP for GBM 4" })).toBeNull();

    const [post] = api.posts();
    expect(post).toEqual({
      url: "/api/trpc/event.rsvp",
      method: "POST",
      body: JSON.stringify({ json: { eventId: "e1" } }),
    });
    expect(screen.getByRole("status").textContent).toBe(
      "You're going. Calendar invite sent.",
    );
  });

  it("holds the button, saying so, while the request is out: a second click sends nothing", async () => {
    const api = server({ signedIn: true });
    render(page({ title: "GBM 4" }));
    const button = await screen.findByRole("button", { name: /^RSVP/ });

    // Hold the RSVP in flight until released.
    const real = globalThis.fetch;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") await gate;
        return real(input, init);
      },
    ) as unknown as typeof fetch;

    const user = userEvent.setup();
    await user.click(button);
    const saving = await screen.findByRole("button", { name: /^Saving/ });
    expect((saving as HTMLButtonElement).disabled).toBe(true);
    await user.click(saving);
    release();

    expect(await screen.findByText("You’re going")).toBeTruthy();
    expect(api.posts()).toHaveLength(1);
  });
});

describe("signed in, already RSVPed", () => {
  it("shows going and a cancel button from the first paint of the state", async () => {
    const api = server({ signedIn: true, going: ["e1"] });
    render(page({ title: "GBM 4" }));
    expect(await screen.findByText("You’re going")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Cancel RSVP for GBM 4" }),
    ).toBeTruthy();
    // Loading it is not an announcement.
    expect(screen.getByRole("status").textContent).toBe("");
    expect(api.posts()).toEqual([]);
  });

  it("cancels through event.cancelRsvp and offers the RSVP button again", async () => {
    const api = server({ signedIn: true, going: ["e1"] });
    render(page({ title: "GBM 4" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Cancel RSVP for GBM 4" }),
    );
    expect(
      await screen.findByRole("button", { name: "RSVP for GBM 4" }),
    ).toBeTruthy();
    expect(screen.queryByText("You’re going")).toBeNull();
    expect(api.posts()[0]).toMatchObject({
      url: "/api/trpc/event.cancelRsvp",
      body: JSON.stringify({ json: { eventId: "e1" } }),
    });
    expect(screen.getByRole("status").textContent).toBe(
      "RSVP cancelled and taken off your calendar.",
    );
  });

  it("offers no cancel once the event has started", async () => {
    server({ signedIn: true, going: ["e1"] });
    render(page({ startsAt: started() }));
    expect(await screen.findByText("You’re going")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("closed", () => {
  it("says so and offers nothing when signed in and not going", async () => {
    server({ signedIn: true });
    render(page({ startsAt: started() }));
    expect(await screen.findByText("RSVPs are closed.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("what the server says no to", () => {
  it.each([
    ["already started", 400, "This event has already started."],
    ["full", 400, "This event is full."],
    ["rate limited", 429, "Too many RSVPs. Try again in a minute."],
  ])(
    "shows the %s message and lets the visitor try again",
    async (_, status, message) => {
      server({ signedIn: true, failWith: { status, message } });
      render(page({ title: "GBM 4" }));
      await userEvent.click(
        await screen.findByRole("button", { name: "RSVP for GBM 4" }),
      );
      expect((await screen.findByRole("alert")).textContent).toBe(message);
      const button = screen.getByRole("button", { name: "RSVP for GBM 4" });
      expect((button as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByText("You’re going")).toBeNull();
    },
  );

  it("asks to sign in again when the session ended", async () => {
    server({
      signedIn: true,
      failWith: { status: 401, message: "UNAUTHORIZED", code: "UNAUTHORIZED" },
    });
    render(page({}));
    await userEvent.click(await screen.findByRole("button", { name: /^RSVP/ }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Your sign-in expired. Sign in again to RSVP.",
    );
  });

  it("says so when the request never arrives", async () => {
    server({ signedIn: true });
    render(page({}));
    const button = await screen.findByRole("button", { name: /^RSVP/ });
    server({ signedIn: true, offline: true });
    await userEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not reach the server. Try again.",
    );
  });

  it("clears the error when the next try works", async () => {
    server({
      signedIn: true,
      failWith: { status: 400, message: "This event is full." },
    });
    render(page({}));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^RSVP/ }));
    await screen.findByRole("alert");
    server({ signedIn: true });
    await user.click(screen.getByRole("button", { name: /^RSVP/ }));
    expect(await screen.findByText("You’re going")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("treats a failed status lookup as not going and still offers RSVP", async () => {
    server({ signedIn: true, statusLookupFails: true });
    render(page({}));
    expect(await screen.findByRole("button", { name: /^RSVP/ })).toBeTruthy();
  });
});

describe("coming back from sign-in", () => {
  const search = () => window.location.search;
  const INTENT_KEY = "buzz:rsvp-intent";

  /** The visitor's own click on "Sign in to RSVP", on a page that is then left. */
  async function clickSignIn(eventId = "e1") {
    server({ signedIn: false });
    const view = render(page({ ids: [eventId] }));
    const link = await screen.findByRole("link", { name: "Sign in to RSVP" });
    // Following the link would leave the page; the click is what is under test.
    const stay = (event: Event) => event.preventDefault();
    document.addEventListener("click", stay);
    await userEvent.click(link);
    document.removeEventListener("click", stay);
    view.unmount();
  }

  async function landOnEvent(url = "/events/e1?rsvp=1") {
    window.history.replaceState(null, "", url);
  }

  it("RSVPs once, shows the confirmed state and drops the flag", async () => {
    await clickSignIn();
    await landOnEvent();
    const api = server({ signedIn: true });
    render(page({ returnTo: "e1", title: "GBM 4" }));
    expect(await screen.findByText("You’re going")).toBeTruthy();
    expect(api.posts()).toHaveLength(1);
    expect(api.posts()[0]!.url).toBe("/api/trpc/event.rsvp");
    expect(search()).toBe("");
    expect(screen.getByRole("status").textContent).toContain("You're going.");
  });

  it("does not RSVP again on a refresh", async () => {
    await clickSignIn();
    await landOnEvent();
    const first = server({ signedIn: true });
    const { unmount } = render(page({ returnTo: "e1" }));
    await screen.findByText("You’re going");
    unmount();

    // A refresh: new page load, the flag and the memory of the click both
    // used up, the RSVP now on file.
    const second = server({ signedIn: true, going: ["e1"] });
    render(page({ returnTo: "e1" }));
    await screen.findByText("You’re going");
    expect(first.posts()).toHaveLength(1);
    expect(second.posts()).toEqual([]);
    expect(window.sessionStorage.getItem(INTENT_KEY)).toBeNull();
  });

  it("only drops the flag when the visitor was already going", async () => {
    await clickSignIn();
    await landOnEvent("/events/e1?rsvp=1&utm=x");
    const api = server({ signedIn: true, going: ["e1"] });
    render(page({ returnTo: "e1" }));
    await screen.findByText("You’re going");
    expect(api.posts()).toEqual([]);
    expect(search()).toBe("?utm=x");
  });

  it("shows the server's reason when the RSVP is refused on return", async () => {
    await clickSignIn();
    await landOnEvent();
    server({
      signedIn: true,
      failWith: { status: 400, message: "This event has already started." },
    });
    render(page({ returnTo: "e1" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This event has already started.",
    );
    expect(search()).toBe("");
    expect(screen.getByRole("button", { name: /^RSVP/ })).toBeTruthy();
  });

  it("does nothing with the flag while signed out", async () => {
    await landOnEvent();
    const api = server({ signedIn: false });
    render(page({ returnTo: "e1" }));
    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(api.posts()).toEqual([]);
    expect(search()).toBe("?rsvp=1");
    expect(screen.getByRole("link", { name: "Sign in to RSVP" })).toBeTruthy();
  });

  it("ignores the flag on a page that is not the landing spot", async () => {
    await landOnEvent("/events?rsvp=1");
    const api = server({ signedIn: true });
    render(page({}));
    await screen.findByRole("button", { name: /^RSVP/ });
    expect(api.posts()).toEqual([]);
    expect(search()).toBe("?rsvp=1");
  });

  describe("a link alone never RSVPs", () => {
    it("does not RSVP a signed-in visitor who arrives with the flag from elsewhere", async () => {
      await landOnEvent();
      const api = server({ signedIn: true });
      render(page({ returnTo: "e1", title: "GBM 4" }));
      expect(
        await screen.findByRole("button", { name: "RSVP for GBM 4" }),
      ).toBeTruthy();
      expect(api.posts()).toEqual([]);
      expect(screen.queryByText("You’re going")).toBeNull();
      // Still gone from the address bar, so sharing the page does not carry it.
      expect(search()).toBe("");
    });

    it("does not RSVP for an event the visitor asked about something else", async () => {
      await clickSignIn("e2");
      await landOnEvent();
      const api = server({ signedIn: true });
      render(page({ returnTo: "e1" }));
      await screen.findByRole("button", { name: /^RSVP/ });
      expect(api.posts()).toEqual([]);
    });

    it("does not RSVP on the strength of a click from long ago", async () => {
      await clickSignIn();
      const stored = JSON.parse(window.sessionStorage.getItem(INTENT_KEY)!);
      window.sessionStorage.setItem(
        INTENT_KEY,
        JSON.stringify({ ...stored, at: stored.at - 16 * 60 * 1000 }),
      );
      await landOnEvent();
      const api = server({ signedIn: true });
      render(page({ returnTo: "e1" }));
      await screen.findByRole("button", { name: /^RSVP/ });
      expect(api.posts()).toEqual([]);
    });

    it("uses up the memory of the click even when it was not needed", async () => {
      await clickSignIn("e2");
      await landOnEvent();
      server({ signedIn: true });
      render(page({ returnTo: "e1" }));
      await screen.findByRole("button", { name: /^RSVP/ });
      expect(window.sessionStorage.getItem(INTENT_KEY)).toBeNull();
    });
  });

  describe("remembering the click", () => {
    it("is the visitor's own click on the sign-in link, for that event", async () => {
      await clickSignIn("e2");
      expect(
        JSON.parse(window.sessionStorage.getItem(INTENT_KEY)!),
      ).toMatchObject({
        id: "e2",
      });
    });

    it("does not stop the link from working", async () => {
      server({ signedIn: false });
      render(page({}));
      const link = await screen.findByRole("link", { name: "Sign in to RSVP" });
      let followed = false;
      const watch = (event: Event) => {
        followed = true;
        event.preventDefault();
      };
      document.addEventListener("click", watch);
      await userEvent.click(link);
      document.removeEventListener("click", watch);
      expect(followed).toBe(true);
    });

    it("still works, as an RSVP button on return, when storage is blocked", async () => {
      const real = window.sessionStorage;
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        get() {
          throw new Error("blocked");
        },
      });
      try {
        await clickSignIn();
        await landOnEvent();
        const api = server({ signedIn: true });
        render(page({ returnTo: "e1" }));
        await screen.findByRole("button", { name: /^RSVP/ });
        expect(api.posts()).toEqual([]);
      } finally {
        Object.defineProperty(window, "sessionStorage", {
          configurable: true,
          value: real,
        });
      }
    });
  });
});
describe("a list of events", () => {
  it("asks who is signed in and which are RSVPed once for the whole page", async () => {
    const api = server({ signedIn: true, going: ["e2"] });
    render(page({ ids: ["e1", "e2", "e3"] }));
    expect(await screen.findByText("You’re going")).toBeTruthy();
    expect(api.calls.filter((c) => c.url.startsWith("/api/auth"))).toHaveLength(
      1,
    );
    const lookups = api.trpc();
    expect(lookups).toHaveLength(1);
    const input = new URL(lookups[0]!.url, "http://localhost").searchParams.get(
      "input",
    )!;
    expect(JSON.parse(input)).toEqual({
      json: { eventIds: ["e1", "e2", "e3"] },
    });
  });

  it("gives each event its own state and acts on only the one clicked", async () => {
    const api = server({ signedIn: true, going: ["e2"] });
    render(page({ ids: ["e1", "e2", "e3"] }));
    await userEvent.click(
      await screen.findByRole("button", { name: "RSVP for Event e1" }),
    );
    await waitFor(() =>
      expect(screen.getAllByText("You’re going")).toHaveLength(2),
    );
    expect(
      screen.getByRole("button", { name: "RSVP for Event e3" }),
    ).toBeTruthy();
    expect(api.posts()).toHaveLength(1);
    expect(api.posts()[0]!.body).toBe(
      JSON.stringify({ json: { eventId: "e1" } }),
    );
  });

  it("asks nothing when no event on the page takes RSVPs", async () => {
    const api = server({ signedIn: true });
    render(<RsvpProvider eventIds={[]}>{null}</RsvpProvider>);
    await Promise.resolve();
    expect(api.calls).toEqual([]);
  });
});

describe("the lead action on an event page", () => {
  it("is the same control, in the same states, as the one on a card", async () => {
    const api = server({ signedIn: true });
    render(page({ prominent: true, title: "GBM 4" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "RSVP for GBM 4" }),
    );
    expect(await screen.findByText("You’re going")).toBeTruthy();
    expect(api.posts()).toHaveLength(1);
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel RSVP for GBM 4" }),
    );
    expect(
      await screen.findByRole("button", { name: "RSVP for GBM 4" }),
    ).toBeTruthy();
  });

  it("keeps the signed-out link until it knows better", async () => {
    server({ signedIn: false });
    render(page({ prominent: true }));
    expect(screen.getByRole("link", { name: "Sign in to RSVP" })).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "Sign in to RSVP" }),
      ).toBeTruthy(),
    );
  });
});
