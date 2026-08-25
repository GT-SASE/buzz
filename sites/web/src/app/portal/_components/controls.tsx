import { cloneElement, isValidElement, type ReactElement } from "react";

import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { cn } from "~/lib/utils";

/**
 * Officer screens carry a dozen controls per row, so they need a smaller,
 * quieter set than the marketing Button. These wrap the Watermelon primitives
 * so the whole portal inherits their focus and disabled behaviour.
 */
const actionTones = {
  /** The one committing action in a form. */
  primary: "bg-gold-bright text-navy hover:bg-gold",
  /** Secondary commit, or a navigation that matters. */
  solid: "bg-navy text-white hover:bg-navy-deep",
  /** Everything reversible. */
  quiet: "ring-hairline text-navy hover:bg-cream bg-transparent ring-1",
  /** Reserved for the confirm step of something destructive. */
  danger:
    "text-destructive ring-1 ring-destructive/30 hover:bg-destructive/10 bg-transparent",
} as const;

export function Action({
  children,
  tone = "quiet",
  type = "button",
  disabled = false,
  onClick,
  className,
}: {
  children: React.ReactNode;
  tone?: keyof typeof actionTones;
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <Button
      type={type}
      disabled={disabled}
      onClick={onClick}
      variant="ghost"
      className={cn(
        "h-auto min-h-11 rounded-full px-5 py-2.5 text-sm font-semibold transition duration-200 disabled:cursor-not-allowed disabled:opacity-45",
        actionTones[tone],
        className,
      )}
    >
      {children}
    </Button>
  );
}

/**
 * Sinking inputs a shade below the panel is what says "type here" without a
 * heavier border. Placeholder is full-strength muted ink: at /50 it measured
 * 2.27:1 on this ground, less than half the 4.5:1 minimum, and a placeholder
 * is text content with no exemption.
 */
export const inputClass =
  "border-hairline bg-cream/60 text-ink placeholder:text-ink-muted focus:bg-paper w-full rounded-lg border px-4 py-2.5 text-base transition";

export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const hintId = hint ? `${htmlFor}-hint` : undefined;

  // Cloned rather than left to the caller: the hint is the only thing that
  // explains what an empty value means, and a describedby you have to remember
  // to pass is one nobody passes.
  const control =
    hintId && isValidElement(children)
      ? cloneElement(
          children as ReactElement<{ "aria-describedby"?: string }>,
          {
            "aria-describedby": hintId,
          },
        )
      : children;

  return (
    <div className={className}>
      <Label
        htmlFor={htmlFor}
        className="text-eyebrow tracking-caps text-ink-muted font-semibold uppercase"
      >
        {label}
      </Label>
      <div className="mt-2">{control}</div>
      {hint && (
        <p id={hintId} className="text-ink-muted text-body-sm mt-1.5">
          {hint}
        </p>
      )}
    </div>
  );
}
