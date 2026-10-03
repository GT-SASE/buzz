import { Avatar, AvatarFallback } from "~/components/ui/avatar";
import { SaseMark } from "~/components/site/hive";
import { cn } from "~/lib/utils";

/** SASE emblem + chapter name. Nav uses tone="dark", footer tone="light". */
export function Wordmark({ tone }: { tone: "light" | "dark" }) {
  return (
    <span className="flex items-center gap-3">
      <SaseMark tile={tone === "light"} />
      <span className="flex flex-col leading-none">
        <span
          className={cn(
            "font-display text-lg font-bold tracking-tight",
            tone === "dark" ? "text-navy" : "text-white",
          )}
        >
          SASE
        </span>
        <span
          className={cn(
            "text-eyebrow tracking-caps mt-1.5 font-semibold uppercase",
            tone === "dark" ? "text-ink-muted" : "text-white/60",
          )}
        >
          Georgia Tech
        </span>
      </span>
    </span>
  );
}

/**
 * Monogram disc. Deliberately avatar-scale rather than a headshot frame — an
 * empty 4:5 box reads as a missing image, a 56px disc reads as a monogram.
 */
export function InitialDisc({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  // Two words give two initials; one word gives its first two letters, so
  // single-word labels never collapse to a lone glyph.
  const words = label.split(/\s+/).filter(Boolean);
  const initials =
    words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => word[0]!.toUpperCase())
          .join("")
      : (words[0] ?? "").slice(0, 2).toUpperCase();

  return (
    <Avatar
      aria-hidden="true"
      className={cn("hex-face ring-gold/30 size-14 ring-1", className)}
    >
      <AvatarFallback className="bg-sand text-navy font-display text-lg font-bold">
        {initials || "GT"}
      </AvatarFallback>
    </Avatar>
  );
}
