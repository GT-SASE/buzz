import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
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

import { SidebarContents } from "~/app/portal/_components/portal-sidebar";
import { adminNav, portalNav } from "~/data/portal";

afterEach(cleanup);

function renderAt(
  pathname: string,
  isOfficer: boolean,
  onNavigate?: () => void,
) {
  render(
    <SidebarContents
      isOfficer={isOfficer}
      name="Ada Lovelace"
      email="ada@example.com"
      signOut={<button type="button">Sign out</button>}
      pathname={pathname}
      onNavigate={onNavigate}
    />,
  );
  return within(screen.getByRole("navigation", { name: "Portal" }));
}

const labels = (nav: ReturnType<typeof renderAt>) =>
  nav.getAllByRole("link").map((link) => link.textContent);

describe("portal sidebar", () => {
  it("shows a member the member links and no view switcher", () => {
    const nav = renderAt("/portal", false);
    expect(labels(nav)).toEqual(portalNav.map((link) => link.label));
    expect(screen.queryByRole("group", { name: "View" })).toBeNull();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("marks the exact route with aria-current=page", () => {
    const nav = renderAt("/portal", false);
    expect(nav.getByRole("link", { name: "My card" }).ariaCurrent).toBe("page");
    expect(nav.getByRole("link", { name: "Events" }).ariaCurrent).toBeNull();
  });

  it("puts an officer on a nested admin route in the officer view", () => {
    const nav = renderAt("/portal/admin/members/abc", true);
    const view = within(screen.getByRole("group", { name: "View" }));
    expect(view.getByRole("link", { name: "Officer" }).ariaCurrent).toBe(
      "true",
    );
    expect(view.getByRole("link", { name: "Member" }).ariaCurrent).toBeNull();
    expect(labels(nav)).toEqual(adminNav.map((link) => link.label));
    expect(nav.getByRole("link", { name: "Members" }).ariaCurrent).toBe("true");
    expect(nav.getByRole("link", { name: "Events" }).ariaCurrent).toBeNull();
  });

  it("puts an officer off the admin routes in the member view", () => {
    const nav = renderAt("/portal", true);
    const view = within(screen.getByRole("group", { name: "View" }));
    expect(view.getByRole("link", { name: "Member" }).ariaCurrent).toBe("true");
    expect(view.getByRole("link", { name: "Officer" }).ariaCurrent).toBeNull();
    expect(labels(nav)).toEqual(portalNav.map((link) => link.label));
  });

  it("keeps an officer scanning in at the door in the member view", () => {
    const nav = renderAt("/portal/check-in", true);
    const view = within(screen.getByRole("group", { name: "View" }));
    expect(view.getByRole("link", { name: "Member" }).ariaCurrent).toBe("true");
    expect(nav.getByRole("link", { name: "Check in" }).ariaCurrent).toBe(
      "page",
    );
  });

  it("closes the menu on any link, the page already open included", async () => {
    const onNavigate = vi.fn();
    const nav = renderAt("/portal", true, onNavigate);
    await userEvent.click(nav.getByRole("link", { name: "My card" }));
    await userEvent.click(screen.getByRole("link", { name: "Officer" }));
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });
});
