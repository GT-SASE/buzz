import Image from "next/image";
import Link from "next/link";

import { ArrowIcon } from "~/app/_components/icons";
import type { BoardMember, DatedEvent } from "~/data/content";
import type { Photo } from "~/data/photos";
import { site } from "~/data/site";

/** Renders a Link for in-app paths and an <a> for mail/tel/off-site targets. */
function isRouterHref(href: string, external: boolean) {
  return !external && href.startsWith("/");
}

const eyebrowTones = {
  /** Default: kicker on paper or cream. */
  dark: { text: "text-navy/85", rule: "bg-navy/35" },
  /** On navy grounds. */
  light: { text: "text-gold-bright", rule: "bg-gold-bright/50" },
  /** Gold that still reads as text on light grounds (5.4:1). */
  gold: { text: "text-gold-ink", rule: "bg-gold-ink/45" },
  /** Secondary kicker on light grounds — labels, not headings. */
  muted: { text: "text-ink-muted", rule: "bg-ink-muted/40" },
  /** Neutral kicker on navy, where gold would over-emphasize. */
  onNavy: { text: "text-white/75", rule: "bg-white/30" },
} as const;

/**
 * The one uppercase kicker on the site. `rule={false}` drops the leading
 * hairline; `as` lets the kicker be the real element its slot needs (a tier
 * heading, a definition term) without hand-rolling the type styles.
 */
export function Eyebrow({
  children,
  tone = "dark",
  rule = true,
  as: Tag = "p",
  className = "",
}: {
  children: React.ReactNode;
  tone?: keyof typeof eyebrowTones;
  rule?: boolean;
  as?: "p" | "h3" | "dt";
  className?: string;
}) {
  const { text, rule: ruleColor } = eyebrowTones[tone];
  return (
    <Tag
      className={`text-eyebrow tracking-caps flex items-center gap-3 font-semibold uppercase ${text} ${className}`}
    >
      {rule && <span className={`h-px w-8 shrink-0 ${ruleColor}`} />}
      {children}
    </Tag>
  );
}

/**
 * The chapter theme, as a lockup. Deliberately a badge rather than a heading:
 * it sits beside the real headline without competing with it for the page's
 * one h1, and it is the same object in the hero and the footer.
 */
export function ThemeBadge({ tone = "dark" }: { tone?: "dark" | "light" }) {
  return (
    <span
      className={`inline-flex items-center gap-2.5 rounded-full py-1.5 pl-4 pr-5 ring-1 ${
        tone === "dark"
          ? "bg-paper/70 text-navy ring-gold/45"
          : "text-white ring-white/20"
      }`}
    >
      <span
        aria-hidden="true"
        className="bg-gold-bright h-2 w-2 shrink-0 rounded-full"
      />
      <span className="font-display text-body-sm font-bold tracking-tight">
        {site.theme}
      </span>
    </span>
  );
}

/**
 * Colour only. Padding is shared below on purpose: variants used to carry their
 * own, and `outline` drifted 4px shorter than `primary`, so every pair sitting
 * in the same flex row rendered as two different-sized pills.
 */
const buttonVariants = {
  /** The one primary action anywhere on the site. Reads on cream and navy. */
  primary:
    "bg-gold-bright text-navy hover:bg-gold shadow-soft hover:shadow-lift hover:-translate-y-0.5",
  /** Solid secondary on light grounds. */
  solid: "bg-navy text-white hover:bg-navy-deep hover:-translate-y-0.5",
  /** Quiet secondary on paper or cream. */
  outline: "ring-hairline text-navy ring-1 hover:bg-navy hover:text-white",
  /** Quiet secondary on a navy ground. */
  ghost:
    "border border-white/25 text-white hover:border-gold-bright hover:text-gold-bright",
} as const;

/**
 * Every pill button on the site. `external` adds the new-tab affordances
 * (target, rel, screen-reader warning) so they cannot be forgotten per page.
 */
export function Button({
  href,
  children,
  variant = "primary",
  arrow = variant === "primary",
  external = false,
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  variant?: keyof typeof buttonVariants;
  arrow?: boolean;
  external?: boolean;
  className?: string;
}) {
  const classes = `group inline-flex items-center gap-2 rounded-full px-7 py-3.5 font-semibold transition duration-300 ${buttonVariants[variant]} ${className}`;
  const content = (
    <>
      {children}
      {external && <span className="sr-only"> (opens in a new tab)</span>}
      {arrow && (
        <ArrowIcon className="h-4 w-4 shrink-0 transition-transform duration-300 group-hover:translate-x-1" />
      )}
    </>
  );

  if (isRouterHref(href, external)) {
    return (
      <Link href={href} className={classes}>
        {content}
      </Link>
    );
  }

  return (
    <a
      href={href}
      className={classes}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {content}
    </a>
  );
}

/** Inline "read more" link with an arrow that slides on hover. */
export function TextLink({
  href,
  children,
  tone = "navy",
  external = false,
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  tone?: "navy" | "gold";
  external?: boolean;
  className?: string;
}) {
  const classes = `group text-body-sm inline-flex items-center gap-2 font-semibold ${
    tone === "gold" ? "text-gold-bright" : "text-navy"
  } ${className}`;
  const content = (
    <>
      {children}
      {external && <span className="sr-only"> (opens in a new tab)</span>}
      <ArrowIcon className="h-4 w-4 shrink-0 transition-transform duration-300 group-hover:translate-x-1" />
    </>
  );

  if (isRouterHref(href, external)) {
    return (
      <Link href={href} className={classes}>
        {content}
      </Link>
    );
  }

  return (
    <a
      href={href}
      className={classes}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {content}
    </a>
  );
}

/**
 * Masthead at the top of every interior page. One per page. Warm cream rather
 * than a navy slab, so an interior page opens on the same ground the homepage
 * body uses instead of a cold band.
 */
export function PageHeader({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <section className="bg-cream paper-wash border-hairline relative border-b">
      <div className="max-w-content relative mx-auto px-5 py-16 sm:px-6 sm:py-20 lg:py-24">
        <div className="rise max-w-3xl">
          <Eyebrow tone="gold">{eyebrow}</Eyebrow>
          <h1 className="font-display text-navy text-h1 mt-6 text-balance font-bold tracking-tight">
            {title}
          </h1>
          <p className="text-lead text-ink-muted max-w-measure mt-6">{body}</p>
        </div>
      </div>
    </section>
  );
}

const sectionPadding = {
  sm: "py-12 sm:py-16 lg:py-20",
  md: "py-16 sm:py-20 lg:py-28",
  lg: "py-20 sm:py-28 lg:py-36",
} as const;

/**
 * Alternating ground. Owned here rather than passed as a class string per page:
 * the literal used to be hand-written at every call site and had already
 * drifted — one band carried no rule at all, another only a top rule — which
 * reads as a section boundary that forgot to finish.
 */
const sectionTones = {
  paper: "",
  cream: "bg-cream border-hairline border-y",
} as const;

/**
 * Page band with optional eyebrow/title/lead header; `size` sets vertical
 * rhythm and `layout="split"` pins the header beside the content on desktop.
 */
export function Section({
  eyebrow,
  title,
  lead,
  children,
  className = "",
  id,
  size = "md",
  layout = "stack",
  tone = "paper",
}: {
  eyebrow?: string;
  title?: string;
  lead?: string;
  children: React.ReactNode;
  className?: string;
  id?: string;
  size?: "sm" | "md" | "lg";
  layout?: "stack" | "split";
  tone?: keyof typeof sectionTones;
}) {
  const split = layout === "split";
  // `??` here would let an empty-string eyebrow swallow a supplied title.
  const hasHeader = [eyebrow, title, lead].some(Boolean);

  const header = hasHeader ? (
    <div
      className={
        split
          ? "reveal mb-10 self-start sm:mb-14 lg:sticky lg:top-24 lg:mb-0"
          : "reveal max-w-measure mb-10 sm:mb-14"
      }
    >
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      {title && (
        <h2 className="font-display text-navy text-h2 mt-5 text-balance font-bold tracking-tight">
          {title}
        </h2>
      )}
      {lead && <p className="text-ink-muted text-lead mt-4">{lead}</p>}
    </div>
  ) : null;

  return (
    <section
      id={id}
      className={`px-5 sm:px-6 ${sectionPadding[size]} ${sectionTones[tone]} ${className}`}
    >
      <div
        className={`max-w-content mx-auto ${
          split ? "lg:grid lg:grid-cols-[minmax(0,22rem)_1fr] lg:gap-16" : ""
        }`}
      >
        {header}
        <div className="reveal">{children}</div>
      </div>
    </section>
  );
}

const cardTones = {
  paper: "bg-paper ring-hairline",
  cream: "bg-cream ring-hairline",
  navy: "bg-navy navy-wash text-white ring-white/10",
} as const;

/** Content tile with a hairline edge and a warm resting shadow. */
export function Card({
  children,
  className = "",
  tone = "paper",
}: {
  children: React.ReactNode;
  className?: string;
  tone?: keyof typeof cardTones;
}) {
  return (
    <div
      className={`rounded-card shadow-soft hover:shadow-lift p-6 ring-1 transition duration-300 hover:-translate-y-1 lg:p-8 ${
        tone === "navy" ? "hover:ring-gold-bright/35" : "hover:ring-gold/45"
      } ${cardTones[tone]} ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * The closing navy panel that ends a page. One geometry, one alignment.
 *
 * Three pages had hand-rolled their own copy of this shell and the padding had
 * already drifted three ways, so the same block landed at a different size
 * depending on which page you arrived from.
 */
export function CtaPanel({
  eyebrow,
  title,
  body,
  children,
}: {
  eyebrow?: string;
  title: string;
  body?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-navy navy-wash rounded-panel relative overflow-hidden px-6 py-14 text-center sm:px-12 lg:py-20">
      <div className="max-w-measure relative mx-auto">
        {eyebrow && (
          <Eyebrow tone="light" rule={false} className="justify-center">
            {eyebrow}
          </Eyebrow>
        )}
        <h2
          className={`font-display text-h2 text-balance font-bold text-white ${
            eyebrow ? "mt-5" : ""
          }`}
        >
          {title}
        </h2>
        {body && <p className="text-lead mt-4 text-white/75">{body}</p>}
        <div className="mt-9 flex flex-wrap justify-center gap-4">
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Small initials disc. Deliberately an avatar-scale element, not a headshot
 * frame — an empty 4:5 box reads as a missing image, a 56px disc reads as a
 * monogram. Swap for next/image once real headshots exist.
 */
export function InitialDisc({
  label,
  className = "",
}: {
  label: string;
  className?: string;
}) {
  // Two words give two initials; a single word gives its first two letters, so
  // one-word labels ("President") never collapse to a lone glyph.
  const words = label.split(/\s+/).filter(Boolean);
  const initials =
    words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => word[0]!.toUpperCase())
          .join("")
      : (words[0] ?? "").slice(0, 2).toUpperCase();

  return (
    <span
      aria-hidden="true"
      className={`bg-sand text-navy ring-hairline font-display grid h-14 w-14 shrink-0 place-items-center rounded-full text-lg font-bold ring-1 ${className}`}
    >
      {initials || "GT"}
    </span>
  );
}

/**
 * One board seat, as a roster row rather than a card with an empty photo
 * frame. Rows read as a finished directory with no assets at all.
 *
 * The disc waits for a real name: a monogram derived from the role renders
 * "PR" twenty pixels from an h3 that spells out "President", which is the
 * empty-placeholder problem in miniature. The row's hover likewise only
 * appears when there is something in it to click.
 */
export function BoardRow({ member }: { member: BoardMember }) {
  return (
    <li
      className={`border-hairline border-b transition duration-200 ${
        member.email ? "hover:bg-cream" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-5 sm:px-6">
        {member.name && <InitialDisc label={member.name} />}
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-navy text-h3 font-bold">
            {member.role}
          </h3>
          <p className="text-ink-muted text-body-sm mt-1">
            {member.name ? (
              <>
                {member.name} · {member.major}
              </>
            ) : (
              <>
                {member.major}
                <span className="text-ink-muted/80 italic"> · seat open</span>
              </>
            )}
          </p>
        </div>
        {member.email && (
          <a
            href={`mailto:${member.email}`}
            className="text-navy decoration-gold hover:text-gold-ink text-body-sm font-semibold underline decoration-2 underline-offset-4 transition"
          >
            {member.email}
          </a>
        )}
      </div>
    </li>
  );
}

/** One calendar entry. Identical on the homepage and /events. */
export function EventCard({ event }: { event: DatedEvent }) {
  return (
    <Card className="flex h-full flex-col">
      <p className="bg-parchment text-navy text-eyebrow tracking-caps inline-flex w-fit rounded-full px-3.5 py-1.5 font-semibold uppercase">
        {event.displayDate}
      </p>
      <h3 className="font-display text-navy text-h3 mt-5 font-bold">
        {event.title}
      </h3>
      <p className="text-gold-ink text-body-sm mt-2 font-semibold">
        {event.location}
      </p>
      <p className="text-ink-muted text-body-sm mt-4">{event.body}</p>
    </Card>
  );
}

/** The three mission pillars, numbered. One treatment, used on / and /about. */
export function PillarGrid({
  pillars,
}: {
  pillars: readonly { title: string; body: string }[];
}) {
  return (
    <div className="stagger grid gap-x-10 gap-y-12 md:grid-cols-3">
      {pillars.map((pillar, i) => (
        <div key={pillar.title}>
          <p
            aria-hidden="true"
            className="font-display text-gold text-numeral font-bold"
          >
            0{i + 1}
          </p>
          <span className="bg-gold/40 mt-4 block h-px w-full" />
          <h3 className="font-display text-navy text-h3 mt-6 font-bold">
            {pillar.title}
          </h3>
          <p className="text-ink-muted text-body mt-3">{pillar.body}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * A chapter photo in a rounded frame. The caller sizes the frame (an aspect
 * utility, a height, a grid area) and this fills it.
 *
 * `sizes` is not optional on purpose: with `fill`, omitting it makes Next
 * request a 100vw source for a tile that may render at 300px, which is the
 * single easiest way to make an image-heavy page slow.
 */
export function PhotoFrame({
  photo,
  sizes,
  className = "",
  priority = false,
  rounded = "rounded-panel",
}: {
  photo: Photo;
  sizes: string;
  className?: string;
  priority?: boolean;
  rounded?: string;
}) {
  return (
    <div
      className={`bg-sand group relative overflow-hidden ${rounded} ${className}`}
    >
      <Image
        src={photo.src}
        alt={photo.alt}
        fill
        sizes={sizes}
        priority={priority}
        placeholder="blur"
        className="object-cover transition duration-700 group-hover:scale-[1.04]"
      />
    </div>
  );
}

/**
 * Asymmetric photo mosaic. Five frames, deliberately unequal, so the block
 * reads as a spread rather than a grid of thumbnails.
 */
export function PhotoMosaic({ photos }: { photos: Photo[] }) {
  const [lead, ...rest] = photos;
  if (!lead) return null;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:grid-rows-2">
      <PhotoFrame
        photo={lead}
        rounded="rounded-card"
        sizes="(min-width: 1024px) 50vw, (min-width: 640px) 50vw, 100vw"
        className="aspect-[4/3] lg:col-span-2 lg:row-span-2 lg:aspect-auto"
      />
      {rest.map((photo) => (
        <PhotoFrame
          key={photo.alt}
          photo={photo}
          rounded="rounded-card"
          sizes="(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw"
          className="aspect-[4/3]"
        />
      ))}
    </div>
  );
}

/**
 * A statistic that counts up as it scrolls into view, using a registered CSS
 * custom property — no JavaScript, no hydration, no layout shift. Generated
 * content is not reliably announced, so the real value ships as sr-only text
 * and the animated figure is hidden from assistive tech.
 */
export function StatValue({
  value,
  className = "",
}: {
  value: string;
  className?: string;
}) {
  // "200+" counts; "2011" does not — a founding year ticking up from zero
  // reads as a bug rather than a flourish.
  const parts = /^(\d{1,3})(\D*)$/.exec(value);

  if (!parts) {
    return <span className={className}>{value}</span>;
  }

  const [, digits, suffix] = parts;

  return (
    <span className={className}>
      <span className="sr-only">{value}</span>
      <span
        aria-hidden="true"
        className="count-up"
        style={{ "--to": Number(digits) } as React.CSSProperties}
      />
      <span aria-hidden="true">{suffix}</span>
    </span>
  );
}

/**
 * Scrolling ribbon. The track is duplicated because a seamless -50% loop needs
 * two identical halves; the clone is hidden from assistive tech so the phrases
 * are not announced twice.
 */
export function Marquee({ items }: { items: readonly string[] }) {
  const row = (clone: boolean) => (
    <ul
      aria-hidden={clone || undefined}
      className="flex shrink-0 items-center"
      role="list"
    >
      {items.map((item) => (
        <li
          key={item}
          className="font-display text-navy/90 flex items-center whitespace-nowrap text-lg font-bold sm:text-xl"
        >
          {item}
          <span
            aria-hidden="true"
            className="bg-gold-bright mx-7 h-1.5 w-1.5 rounded-full sm:mx-10"
          />
        </li>
      ))}
    </ul>
  );

  return (
    <div className="border-hairline bg-sand overflow-hidden border-y py-5">
      <div className="marquee-track">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}

/** GT + SASE lockup. Use in the nav (tone="dark") and footer (tone="light"). */
export function Wordmark({ tone }: { tone: "light" | "dark" }) {
  return (
    <span className="flex items-center gap-3">
      <span className="bg-navy text-gold-bright font-display flex h-10 w-10 items-center justify-center rounded-full text-sm font-bold">
        GT
      </span>
      <span className="flex flex-col leading-none">
        <span
          className={`font-display text-lg font-bold tracking-tight ${
            tone === "dark" ? "text-navy" : "text-white"
          }`}
        >
          SASE
        </span>
        <span
          className={`text-eyebrow tracking-caps mt-1.5 font-semibold uppercase ${
            tone === "dark" ? "text-ink-muted" : "text-white/60"
          }`}
        >
          Georgia Tech
        </span>
      </span>
    </span>
  );
}
