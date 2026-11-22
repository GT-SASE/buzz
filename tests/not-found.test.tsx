import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, mock } from "bun:test";

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

import MarketingLayout from "../sites/web/src/app/(marketing)/layout";
import MarketingNotFound from "../sites/web/src/app/(marketing)/not-found";
import RootNotFound from "../sites/web/src/app/not-found";

afterEach(cleanup);

/** The landmarks and skip link a visitor's assistive tech would count. */
function chrome(container: HTMLElement) {
  return {
    navs: container.querySelectorAll("nav").length,
    mains: container.querySelectorAll("main").length,
    footers: container.querySelectorAll("footer").length,
    skipLinks: container.querySelectorAll('a[href="#content"]').length,
    nestedMains: container.querySelectorAll("main main").length,
    h1s: container.querySelectorAll("h1").length,
  };
}

describe("404 pages", () => {
  it("(marketing) not-found renders the body with no chrome of its own", () => {
    const { container, getByText } = render(<MarketingNotFound />);

    expect(chrome(container)).toEqual({
      navs: 0,
      mains: 0,
      footers: 0,
      skipLinks: 0,
      nestedMains: 0,
      h1s: 1,
    });
    expect(
      getByText("This page took the Tech Trolley somewhere else."),
    ).toBeTruthy();
    expect(getByText("Back home").closest("a")?.getAttribute("href")).toBe("/");
    expect(getByText("See events").closest("a")?.getAttribute("href")).toBe(
      "/events",
    );
  });

  it("notFound() inside the (marketing) layout shows one nav, main, footer and skip link", () => {
    const { container } = render(
      <MarketingLayout>
        <MarketingNotFound />
      </MarketingLayout>,
    );

    expect(chrome(container)).toEqual({
      navs: 1,
      mains: 1,
      footers: 1,
      skipLinks: 1,
      nestedMains: 0,
      h1s: 1,
    });
  });

  it("the root not-found, for URLs outside every route, mounts the chrome once", () => {
    const { container, getByText } = render(<RootNotFound />);

    expect(chrome(container)).toEqual({
      navs: 1,
      mains: 1,
      footers: 1,
      skipLinks: 1,
      nestedMains: 0,
      h1s: 1,
    });
    expect(
      getByText("This page took the Tech Trolley somewhere else."),
    ).toBeTruthy();
  });
});
