import Link from "next/link";

import { TextLink, ThemeBadge, Wordmark } from "~/app/_components/ui";
import { navGroups, site } from "~/data/site";

const columnLabel =
  "text-eyebrow tracking-caps font-semibold text-white/70 uppercase";
// Block, and taller than the text needs, because these stack: an inline-block
// at py-1.5 gave a ~34px row on 0.9375rem copy, under the 44px minimum touch
// target. The lists carry no vertical spacing of their own — the padding is the
// gap, so the rows cannot end up spaced twice.
const footerLink = "block py-3 transition hover:text-white";

export function SiteFooter() {
  return (
    <footer className="bg-ink navy-wash relative overflow-hidden text-white/65">
      <div className="from-gold-bright/70 via-gold/25 h-px bg-gradient-to-r to-transparent" />
      <div className="max-w-content relative mx-auto px-5 py-16 sm:px-6">
        <div className="grid gap-x-12 gap-y-14 sm:grid-cols-2 md:grid-cols-[1.6fr_1fr_1fr_1.4fr]">
          <div className="sm:col-span-2 md:col-span-1">
            <Wordmark tone="light" />
            <div className="mt-5">
              <ThemeBadge tone="light" />
            </div>
            <p className="text-body-sm mt-5 max-w-sm leading-relaxed">
              {site.description}
            </p>
            <TextLink
              href={`mailto:${site.email}`}
              tone="gold"
              className="mt-6 py-1.5"
            >
              {site.email}
            </TextLink>
          </div>

          <div>
            <h2 className={columnLabel}>Explore</h2>
            <ul className="text-body-sm mt-4">
              {navGroups.map((group) => (
                <li key={group.href}>
                  <Link href={group.href} className={footerLink}>
                    {group.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className={columnLabel}>Connect</h2>
            <ul className="text-body-sm mt-4">
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

          <div>
            <h2 className={columnLabel}>Partner with us</h2>
            <p className="text-body-sm mt-4 leading-relaxed">
              Recruit from a pipeline of Georgia Tech engineers, scientists, and
              business students. Sponsorship runs from a single info session to
              a named signature event.
            </p>
            <TextLink
              href={`mailto:${site.email}?subject=Sponsorship%20packet`}
              tone="gold"
              className="mt-4 py-1.5"
            >
              Request the sponsorship packet
            </TextLink>
          </div>
        </div>

        <div className="text-body-sm mt-14 flex flex-col gap-6 border-t border-white/10 pt-8 text-white/55 sm:flex-row sm:items-center sm:justify-between">
          <p>{site.name}</p>
          <p>Georgia Institute of Technology · Atlanta, GA</p>
          {/* Utility, not a social profile: the portal is chapter software a
              member signs into, so it belongs with the fine print rather than
              in Connect beside Instagram and Discord. */}
          {/* No prefetch: /portal is force-dynamic and reads the session, so
              prefetching would fire an authenticated server render every time
              the footer scrolled into view, on every page of the site. */}
          <Link
            href="/portal"
            prefetch={false}
            className="py-3 font-semibold transition hover:text-white"
          >
            Member portal
          </Link>
        </div>
      </div>
    </footer>
  );
}
