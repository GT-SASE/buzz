import { Card as UiCard } from "~/components/ui/card";
import { Separator } from "~/components/ui/separator";
import { cn } from "~/lib/utils";

const eyebrowTones = {
  /** Default: kicker on paper or cream. */
  dark: { text: "text-navy/85", rule: "bg-navy/35" },
  /** On navy grounds. */
  light: { text: "text-gold-bright", rule: "bg-gold-bright/50" },
  /** Gold made legible as text on light grounds (5.4:1). */
  gold: { text: "text-gold-ink", rule: "bg-gold-ink/45" },
  /** Secondary kicker on light grounds — labels, not headings. */
  muted: { text: "text-ink-muted", rule: "bg-ink-muted/40" },
  /** Neutral kicker on navy, where gold would over-emphasize. */
  onNavy: { text: "text-white/75", rule: "bg-white/30" },
} as const;

/** The one uppercase kicker on the site. */
export function Eyebrow({
  children,
  tone = "dark",
  rule = true,
  as: Tag = "p",
  className,
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
      className={cn(
        "text-eyebrow tracking-masthead flex items-center gap-3 font-semibold uppercase",
        text,
        className,
      )}
    >
      {rule && <span className={cn("h-px w-8 shrink-0", ruleColor)} />}
      {children}
    </Tag>
  );
}

/** Masthead at the top of every interior page. One per page. */
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
    <header className="px-5 pt-10 pb-14 sm:px-6 sm:pt-14 sm:pb-20">
      <div className="max-w-content rise mx-auto">
        <p className="text-eyebrow tracking-masthead text-ink-muted pb-4 font-semibold uppercase">
          {eyebrow}
        </p>
        <div className="rule-heavy grid gap-x-16 gap-y-6 pt-8 lg:grid-cols-[1.35fr_1fr] lg:items-end">
          <h1 className="font-display text-navy text-h1 optical-left font-bold tracking-tight text-balance">
            {title}
          </h1>
          <p className="text-lead text-ink-muted max-w-measure lg:pb-2">
            {body}
          </p>
        </div>
      </div>
    </header>
  );
}

const sectionPadding = {
  sm: "py-12 sm:py-16 lg:py-20",
  md: "py-16 sm:py-20 lg:py-28",
  lg: "py-20 sm:py-28 lg:py-36",
} as const;

const sectionTones = {
  paper: "",
  cream: "bg-cream",
} as const;

/**
 * A page division, set the way print sets one: a heavy rule across the measure,
 * the section number hanging in the left margin, the title flush beneath it.
 */
export function Section({
  eyebrow,
  title,
  lead,
  number,
  children,
  className,
  id,
  size = "md",
  layout = "stack",
  tone = "paper",
}: {
  eyebrow?: string;
  title?: string;
  lead?: string;
  /** "01", "02" — hangs in the margin beside the title on wide screens. */
  number?: string;
  children: React.ReactNode;
  className?: string;
  id?: string;
  size?: keyof typeof sectionPadding;
  layout?: "stack" | "split";
  tone?: keyof typeof sectionTones;
}) {
  const split = layout === "split";
  // `??` here would let an empty-string eyebrow swallow a supplied title.
  const hasHeader = [eyebrow, title, lead].some(Boolean);

  const header = hasHeader ? (
    <div className="reveal hang mb-10 sm:mb-14">
      {number && (
        <span
          aria-hidden="true"
          className="hang-number text-numeral tracking-caps text-gold-ink block pb-3 font-semibold xl:pb-0"
        >
          {number}
        </span>
      )}
      <div
        className={
          split
            ? "grid gap-y-5"
            : "grid gap-x-16 gap-y-5 lg:grid-cols-[1.35fr_1fr] lg:items-end"
        }
      >
        <div>
          {eyebrow && (
            <p className="text-eyebrow tracking-masthead text-ink-muted pb-4 font-semibold uppercase">
              {eyebrow}
            </p>
          )}
          {title && (
            <h2 className="font-display text-navy text-h2 optical-left font-bold tracking-tight text-balance">
              {title}
            </h2>
          )}
        </div>
        {lead && (
          <p
            className={cn(
              "text-ink-muted text-lead max-w-measure",
              split ? "" : "lg:pb-2",
            )}
          >
            {lead}
          </p>
        )}
      </div>
    </div>
  ) : null;

  return (
    <section
      id={id}
      className={cn(
        "px-5 sm:px-6",
        sectionPadding[size],
        sectionTones[tone],
        className,
      )}
    >
      <div className="max-w-content mx-auto">
        {hasHeader && <Separator className="rule-heavy mb-8 border-0" />}
        {split ? (
          <div className="lg:grid lg:grid-cols-[minmax(0,20rem)_1fr] lg:gap-16">
            {header}
            <div className="reveal">{children}</div>
          </div>
        ) : (
          <>
            {header}
            <div className="reveal">{children}</div>
          </>
        )}
      </div>
    </section>
  );
}

type CardTone = "paper" | "cream" | "navy";

/**
 * A column of content, ruled at the top rather than boxed. `tone="navy"` fills,
 * because a closing panel genuinely is a block of colour rather than a column.
 */
export function Card({
  children,
  className,
  tone = "paper",
}: {
  children: React.ReactNode;
  className?: string;
  tone?: CardTone;
}) {
  if (tone === "navy") {
    return (
      <UiCard
        className={cn(
          "bg-navy navy-wash relative gap-0 rounded-none border-0 p-8 text-white shadow-none lg:p-12",
          className,
        )}
      >
        {children}
      </UiCard>
    );
  }

  return (
    <UiCard
      className={cn(
        "border-rule gap-0 rounded-none border-0 border-t-2 bg-transparent py-0 pt-6 shadow-none",
        tone === "cream" ? "bg-cream px-6 pb-6" : "",
        className,
      )}
    >
      {children}
    </UiCard>
  );
}

/** The closing navy panel that ends a page. One geometry, one alignment. */
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
    <div className="bg-navy navy-wash relative overflow-hidden px-6 py-16 sm:px-12 lg:py-24">
      <div className="max-w-measure relative mx-auto text-center">
        {eyebrow && (
          <Eyebrow tone="light" rule={false} className="justify-center">
            {eyebrow}
          </Eyebrow>
        )}
        <h2
          className={cn(
            "font-display text-h2 font-bold text-balance text-white",
            eyebrow && "mt-5",
          )}
        >
          {title}
        </h2>
        {body && <p className="text-lead mt-4 text-white/75">{body}</p>}
        <div className="mt-9 flex flex-wrap items-center justify-center gap-4">
          {children}
        </div>
      </div>
    </div>
  );
}
