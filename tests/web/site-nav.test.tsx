import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MouseEvent, ReactNode } from "react";
import { afterEach, describe, expect, it, mock } from "bun:test";

mock.module("next/link", () => ({
  default: ({
    href,
    children,
    onClick,
    ...props
  }: {
    href: string;
    children: ReactNode;
    onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      href={href}
      onClick={(event) => {
        onClick?.(event);
        event.preventDefault();
      }}
      {...props}
    >
      {children}
    </a>
  ),
}));

import { SiteNav } from "~/components/site/site-nav";
import { navGroups } from "~/data/site";

afterEach(cleanup);

const group = navGroups.find(
  (candidate) => candidate.href !== "/join" && candidate.items.length > 0,
)!;

describe("site nav dropdowns", () => {
  it("closes the open dropdown when one of its links is followed", async () => {
    const user = userEvent.setup();
    const { container } = render(<SiteNav />);
    const menu = container.querySelector("details")!;

    menu.open = true;
    expect(menu.open).toBe(true);

    const item = group.items[0]!;
    const link = [...menu.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === item.label,
    )!;
    await user.click(link);

    expect(menu.open).toBe(false);
  });
});
