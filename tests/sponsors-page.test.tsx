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
mock.module("next/image", () => ({
  default: ({
    src,
    alt,
    fill: _fill,
    unoptimized: _unoptimized,
    ...props
  }: {
    src: string;
    alt: string;
    fill?: boolean;
    unoptimized?: boolean;
    // eslint-disable-next-line @next/next/no-img-element -- stands in for next/image
  }) => <img src={src} alt={alt} {...props} />,
}));

import type { Sponsor, SponsorPacket } from "../sites/web/src/data/sponsors";
import { site } from "../sites/web/src/data/site";

const partners: Sponsor[] = [
  {
    name: "Northwind",
    logo: "/sponsors/northwind.svg",
    href: "https://northwind.example",
  },
  { name: "Globex", logo: "/sponsors/globex.png" },
  {
    name: "Initech",
    logo: "/sponsors/initech.webp",
    href: "https://initech.example",
  },
];
const pdf: SponsorPacket = { href: "/sponsors/sase-gt-sponsorship-packet.pdf" };

// The page reads these two at render time, so a test can swap them.
// A snapshot: mock.module patches the module in place, so the namespace would
// call the mock back.
const real = { ...(await import("../sites/web/src/data/sponsors")) };
// The partner list is shared and filled in place: the page holds this array.
const partnerList: Sponsor[] = [];
const state: { packet: SponsorPacket | null } = { packet: null };
mock.module("../sites/web/src/data/sponsors.ts", () => ({
  ...real,
  sponsors: partnerList,
  packetAction: (packet: SponsorPacket | null = state.packet) =>
    real.packetAction(packet),
}));
const { SponsorWall } =
  await import("../sites/web/src/components/site/sponsor-wall");
const { packetAction } = real;
const { default: SponsorsPage } =
  await import("../sites/web/src/app/(marketing)/sponsors/page");

afterEach(() => {
  cleanup();
  partnerList.length = 0;
  state.packet = null;
});

describe("SponsorWall", () => {
  it("renders nothing for an empty list, never a broken image", () => {
    const { container } = render(<SponsorWall sponsors={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders one tile per partner, named by its alt text", () => {
    const { getAllByRole, getByAltText } = render(
      <SponsorWall sponsors={partners} />,
    );

    expect(getAllByRole("listitem")).toHaveLength(3);
    for (const partner of partners) {
      expect(getByAltText(partner.name).getAttribute("src")).toBe(partner.logo);
    }
  });

  it("links only the partners that have a site, in a new tab, and says so", () => {
    const { getAllByRole } = render(<SponsorWall sponsors={partners} />);

    const links = getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://northwind.example",
      "https://initech.example",
    ]);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
      expect(link.textContent).toContain("(opens in a new tab)");
    }
  });
});

describe("packetAction", () => {
  it("keeps the email request while there is no PDF", () => {
    const action = packetAction(null);
    expect(action.label).toBe("Request the sponsorship packet");
    expect(action.href).toBe(
      `mailto:${site.email}?subject=Sponsorship%20packet`,
    );
    expect(action.external).toBe(false);
  });

  it("points at the PDF once there is one", () => {
    expect(packetAction(pdf)).toEqual({
      label: "Download the sponsorship packet",
      href: pdf.href,
      external: true,
    });
  });
});

describe("/sponsors", () => {
  it("invites the first partner when there are none, with no logo wall", () => {
    const { container, getByRole, queryByText } = render(<SponsorsPage />);

    expect(
      getByRole("heading", { name: "Become our first partner." }),
    ).toBeTruthy();
    expect(queryByText("Our partners.")).toBeNull();
    expect(container.querySelectorAll("img")).toHaveLength(0);
    const request = getByRole("link", {
      name: /Request the sponsorship packet/,
    });
    expect(request.getAttribute("href")).toMatch(/^mailto:/);
  });

  it("shows the wall and drops the invitation once partners exist", () => {
    partnerList.push(...partners);
    const { container, getByRole, queryByRole } = render(<SponsorsPage />);

    expect(getByRole("heading", { name: "Our partners." })).toBeTruthy();
    expect(
      queryByRole("heading", { name: "Become our first partner." }),
    ).toBeNull();
    expect(container.querySelectorAll("img")).toHaveLength(3);
  });

  it("offers the PDF when one is set, and the email request otherwise", () => {
    state.packet = pdf;
    const { getByRole, queryByRole } = render(<SponsorsPage />);

    const download = getByRole("link", {
      name: /Download the sponsorship packet/,
    });
    expect(download.getAttribute("href")).toBe(pdf.href);
    expect(
      queryByRole("link", { name: /Request the sponsorship packet/ }),
    ).toBeNull();
  });
});
