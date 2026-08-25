import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { Button as UiButton } from "~/components/ui/button";
import { cn } from "~/lib/utils";

/** In-app paths route through <Link>; mail/tel/off-site targets stay <a>. */
function isRouterHref(href: string, external: boolean) {
  return !external && href.startsWith("/");
}

/**
 * Hex cells and ruled links, not pills — the hive system's two action
 * shapes, layered onto the Watermelon Button so it keeps the shared focus ring,
 * disabled handling, and icon sizing.
 */
const actionVariants = {
  /** The one primary action on a light ground. Invisible on navy — use `solid`. */
  primary: "bg-navy text-white hover:bg-navy-deep",
  /** The same weight on a navy ground. */
  solid: "bg-gold-bright text-navy hover:bg-gold",
  /** The quiet action: a word on a rule that thickens on hover. No box. */
  outline:
    "text-navy border-b-2 border-navy/30 hover:border-navy rounded-none bg-transparent px-0 pb-1.5 -mb-1.5 hover:bg-transparent",
  /** The same, on a navy ground. */
  ghost:
    "text-white border-b-2 border-white/35 hover:border-gold-bright hover:text-gold-bright rounded-none bg-transparent px-0 pb-1.5 -mb-1.5 hover:bg-transparent",
} as const;

export type ActionVariant = keyof typeof actionVariants;

export function Button({
  href,
  children,
  variant = "primary",
  arrow = variant === "primary",
  external = false,
  className,
}: {
  href: string;
  children: React.ReactNode;
  variant?: ActionVariant;
  arrow?: boolean;
  external?: boolean;
  className?: string;
}) {
  const boxed = variant === "primary" || variant === "solid";
  const content = (
    <>
      {children}
      {external && <span className="sr-only"> (opens in a new tab)</span>}
      {arrow && (
        <ArrowRight className="size-4 shrink-0 transition-transform duration-300 group-hover:translate-x-1" />
      )}
    </>
  );

  return (
    <UiButton
      asChild
      variant="ghost"
      size="lg"
      className={cn(
        "group text-eyebrow tracking-caps h-auto gap-3 font-semibold uppercase transition duration-200 max-sm:min-w-0 max-sm:shrink max-sm:whitespace-normal",
        boxed ? "rounded-md px-7 py-4" : "min-h-11 items-end py-3",
        actionVariants[variant],
        className,
      )}
    >
      {isRouterHref(href, external) ? (
        <Link href={href}>{content}</Link>
      ) : (
        <a
          href={href}
          {...(external
            ? { target: "_blank", rel: "noopener noreferrer" }
            : {})}
        >
          {content}
        </a>
      )}
    </UiButton>
  );
}

/** Inline "read more" link with an arrow that slides on hover. */
export function TextLink({
  href,
  children,
  tone = "navy",
  external = false,
  className,
}: {
  href: string;
  children: React.ReactNode;
  tone?: "navy" | "gold";
  external?: boolean;
  className?: string;
}) {
  const classes = cn(
    "group text-body-sm inline-flex min-h-11 items-center gap-2 py-3 font-semibold",
    tone === "gold" ? "text-gold-bright" : "text-navy",
    className,
  );
  const content = (
    <>
      {children}
      {external && <span className="sr-only"> (opens in a new tab)</span>}
      <ArrowRight className="size-4 shrink-0 transition-transform duration-300 group-hover:translate-x-1" />
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
