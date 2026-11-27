import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

let loaded: unknown = null;
mock.module("../../sites/web/src/data/announcement.ts", () => ({
  getAnnouncement: () => Promise.resolve(loaded),
}));

// Mocks are in place before these load: static imports would run first.
const { AnnouncementBanner } =
  await import("../../sites/web/src/components/site/announcement");
const { AnnouncementSlot } =
  await import("../../sites/web/src/components/site/announcement-slot");
const { ANNOUNCEMENT_DISMISS_KEY, announcementFromRow, announcementScript } =
  await import("../../sites/web/src/lib/announcement");
import type { Announcement } from "../../sites/web/src/lib/announcement";

const announcement: Announcement = {
  message: "Spring kickoff is Thursday.",
  link: { label: "See the calendar", href: "/events" },
  version: "1763640000000",
};

/** What the inline script does in the browser, once the banner is in the page. */
function runScript() {
  new Function(announcementScript)();
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("AnnouncementBanner", () => {
  it("is a labelled region with the message and an in-site link", () => {
    const { getByRole } = render(
      <AnnouncementBanner announcement={announcement} />,
    );

    const region = getByRole("region", { name: "Announcement" });
    expect(region.textContent).toContain("Spring kickoff is Thursday.");
    const link = getByRole("link", { name: "See the calendar" });
    expect(link.getAttribute("href")).toBe("/events");
    expect(link.getAttribute("target")).toBeNull();
  });

  it("opens an off-site link in a new tab and says so", () => {
    const { getByRole } = render(
      <AnnouncementBanner
        announcement={{
          ...announcement,
          link: { label: "Register", href: "https://example.com/rsvp" },
        }}
      />,
    );

    const link = getByRole("link", { name: /Register/ });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toContain("(opens in a new tab)");
  });

  it("renders no link when there is none", () => {
    const { queryByRole } = render(
      <AnnouncementBanner announcement={{ ...announcement, link: null }} />,
    );
    expect(queryByRole("link")).toBeNull();
  });

  it("keeps the dismiss button out of the page until the script runs", () => {
    const { container } = render(
      <AnnouncementBanner announcement={announcement} />,
    );
    const button = container.querySelector<HTMLElement>("[data-dismiss]");
    expect(button?.hidden).toBe(true);

    runScript();
    expect(button?.hidden).toBe(false);
    expect(button?.getAttribute("aria-label")).toBe("Dismiss announcement");
  });

  it("hides on dismiss and remembers the version", () => {
    const { container, getByRole } = render(
      <AnnouncementBanner announcement={announcement} />,
    );
    runScript();
    const region = container.querySelector<HTMLElement>("section");
    expect(region?.hidden).toBe(false);

    fireEvent.click(getByRole("button", { hidden: true }));

    expect(region?.hidden).toBe(true);
    expect(localStorage.getItem(ANNOUNCEMENT_DISMISS_KEY)).toBe(
      announcement.version,
    );
  });

  it("stays hidden for a visitor who dismissed this version, before any paint", () => {
    localStorage.setItem(ANNOUNCEMENT_DISMISS_KEY, announcement.version);
    const { container } = render(
      <AnnouncementBanner announcement={announcement} />,
    );

    runScript();

    expect(container.querySelector<HTMLElement>("section")?.hidden).toBe(true);
  });

  it("shows again when an officer saves a new version", () => {
    localStorage.setItem(ANNOUNCEMENT_DISMISS_KEY, "1763000000000");
    const { container } = render(
      <AnnouncementBanner announcement={announcement} />,
    );

    runScript();

    expect(container.querySelector<HTMLElement>("section")?.hidden).toBe(false);
  });

  it("stays up, with no error, when storage is blocked", () => {
    const original = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      const { container, getByRole } = render(
        <AnnouncementBanner announcement={announcement} />,
      );
      expect(runScript).not.toThrow();
      expect(container.querySelector<HTMLElement>("section")?.hidden).toBe(
        false,
      );
      fireEvent.click(getByRole("button", { hidden: true }));
      expect(container.querySelector<HTMLElement>("section")?.hidden).toBe(
        true,
      );
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
    }
  });
});

describe("AnnouncementSlot", () => {
  it("renders the banner an officer switched on", async () => {
    loaded = announcement;
    const { getByRole } = render(await AnnouncementSlot());
    expect(getByRole("region", { name: "Announcement" })).toBeTruthy();
  });

  it("renders nothing when there is no banner", async () => {
    loaded = null;
    expect(await AnnouncementSlot()).toBeNull();
  });
});

describe("announcementFromRow", () => {
  const row = {
    title: "  Spring kickoff is Thursday.  ",
    description: "See the calendar",
    body: "/events",
    published: true,
    updatedAt: new Date("2026-11-20T12:00:00Z"),
  };

  it("maps the page row and keys the version on updatedAt", () => {
    expect(announcementFromRow(row)).toEqual({
      message: "Spring kickoff is Thursday.",
      link: { label: "See the calendar", href: "/events" },
      version: String(row.updatedAt.getTime()),
    });
  });

  it("is off when unpublished, however full the row is", () => {
    expect(announcementFromRow({ ...row, published: false })).toBeNull();
  });

  it("is off when the message is blank", () => {
    expect(announcementFromRow({ ...row, title: "  " })).toBeNull();
  });

  it("drops a half-set link instead of rendering a dead one", () => {
    expect(announcementFromRow({ ...row, body: "" })?.link).toBeNull();
    expect(announcementFromRow({ ...row, description: "" })?.link).toBeNull();
  });
});
