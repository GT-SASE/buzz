import Link from "next/link";

import { TextLink } from "~/components/site/actions";
import { ThemeBadge, Wordmark } from "~/components/site/brand";
import { navGroups, site } from "~/data/site";

// On this ground the near-black --rule would be invisible, so the column
// weight has to come from white instead.
const column = "border-t-2 border-white/25 pt-6";
const columnLabel =
  "text-eyebrow tracking-masthead font-semibold text-white/70 uppercase";
// Block and taller than the text needs: these stack, and an inline-block at
// py-1.5 gave a ~34px row on 0.9375rem copy, under the 44px touch target.
const footerLink = "block py-3 transition hover:text-white";

export function SiteFooter() {
  return (
    <footer className="bg-ink text-white/65">
      <div className="bg-gold-bright h-0.5" />
      <div className="max-w-content mx-auto px-5 py-16 sm:px-6">
        <div className="grid gap-x-12 gap-y-14 sm:grid-cols-2 md:grid-cols-[1.6fr_1fr_1fr_1.4fr]">
          <div className={`${column} sm:col-span-2 md:col-span-1`}>
            <Wordmark tone="light" />
            <div className="mt-6">
              <ThemeBadge tone="light" />
            </div>
            <p className="text-body-sm mt-6 max-w-sm leading-relaxed">
              {site.description}
            </p>
            <TextLink
              href={`mailto:${site.email}`}
              tone="gold"
              className="mt-6 min-h-11 py-3"
            >
              {site.email}
            </TextLink>
          </div>

          <div className={column}>
            <h2 className={columnLabel}>Explore</h2>
            <ul className="text-body-sm mt-2 divide-y divide-white/10">
              {navGroups.map((group) => (
                <li key={group.href}>
                  <Link href={group.href} className={footerLink}>
                    {group.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div className={column}>
            <h2 className={columnLabel}>Connect</h2>
            <ul className="text-body-sm mt-2 divide-y divide-white/10">
              {site.socials.map((social) => (
                <li key={social.label}>
                  <a
                    href={social.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={footerLink}
                  >
                    {social.label}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div className={column}>
            <h2 className={columnLabel}>Partner with us</h2>
            <p className="text-body-sm mt-4 leading-relaxed">
              Recruit from a pipeline of Georgia Tech engineers, scientists, and
              business students. Sponsorship runs from a single info session to
              a named signature event.
            </p>
            <TextLink
              href={`mailto:${site.email}?subject=Sponsorship%20packet`}
              tone="gold"
              className="mt-4 min-h-11 py-3"
            >
              Request the sponsorship packet
            </TextLink>
          </div>
        </div>

        <div className="text-eyebrow tracking-caps mt-16 flex flex-col gap-4 border-t-2 border-white/20 pt-8 text-white/50 uppercase lg:flex-row lg:items-center lg:justify-between">
          <p>{site.name}</p>
          <p>Georgia Institute of Technology · Atlanta, GA</p>
          {/* No prefetch: /portal is dynamic and reads the session, so
              prefetching would fire an authenticated server render every time
              the footer scrolled into view, on every page. */}
          <Link
            href="/portal"
            prefetch={false}
            className="inline-flex min-h-11 items-center py-3 font-semibold transition hover:text-white"
          >
            Join SASE
          </Link>
        </div>
      </div>
    </footer>
  );
}
