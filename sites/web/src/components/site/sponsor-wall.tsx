import Image from "next/image";

import type { Sponsor } from "~/data/sponsors";

/**
 * The partners' logos, one tile each. Logos are contained, never cropped or
 * stretched, so a wide wordmark and a square mark sit in the same tile. The
 * company name is the alt text; a linked logo says it opens a new tab.
 */
export function SponsorWall({ sponsors }: { sponsors: readonly Sponsor[] }) {
  if (sponsors.length === 0) return null;

  return (
    <ul
      role="list"
      className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
    >
      {sponsors.map((sponsor) => {
        const logo = (
          <Image
            src={sponsor.logo}
            alt={sponsor.name}
            fill
            sizes="(min-width: 1024px) 16rem, (min-width: 640px) 33vw, 50vw"
            // An SVG is already resolution independent, and the optimizer
            // refuses it unless dangerouslyAllowSVG is on.
            unoptimized={sponsor.logo.endsWith(".svg")}
            className="object-contain"
          />
        );
        return (
          <li
            key={sponsor.name}
            className="border-hairline bg-paper overflow-hidden rounded-lg border"
          >
            {sponsor.href ? (
              <a
                href={sponsor.href}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:bg-cream relative block h-28 p-6 transition sm:h-36"
              >
                <span className="relative block size-full">{logo}</span>
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              <div className="relative h-28 p-6 sm:h-36">
                <span className="relative block size-full">{logo}</span>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
