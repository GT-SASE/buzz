/**
 * Who sponsors the chapter, and the sponsorship packet. Pure data: /sponsors,
 * the footer and /contact all read it.
 *
 * To add a partner, drop the logo in `public/sponsors/` and add a row to
 * `sponsors`. To publish the packet, drop the PDF in `public/sponsors/` and set
 * `sponsorPacket`. While `sponsors` is empty /sponsors invites the first
 * partner, and while `sponsorPacket` is null every packet link opens an email
 * to the chapter inbox instead.
 */

import { site } from "~/data/site";

export type Sponsor = {
  name: string;
  /** Path under `/sponsors/` in `public`, PNG, WebP or SVG. */
  logo: string;
  /** The partner's own site, if it should link there. */
  href?: string;
};

export type SponsorPacket = {
  /** Path under `/sponsors/` in `public`, a PDF. */
  href: string;
};

export const sponsors: readonly Sponsor[] = [];

export const sponsorPacket: SponsorPacket | null = null;

/**
 * The link every "sponsorship packet" call to action shares: the PDF once there
 * is one, an email request until then.
 */
export function packetAction(packet: SponsorPacket | null = sponsorPacket) {
  if (packet) {
    return {
      label: "Download the sponsorship packet",
      href: packet.href,
      external: true,
    };
  }
  return {
    label: "Request the sponsorship packet",
    href: `mailto:${site.email}?subject=${encodeURIComponent("Sponsorship packet")}`,
    external: false,
  };
}
