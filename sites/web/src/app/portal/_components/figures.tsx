import { Eyebrow } from "~/components/site";
import { Skeleton } from "~/components/ui/skeleton";

export const figureGrid = "grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4";

export function Figure({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: React.ReactNode;
}) {
  return (
    <div className="border-hairline bg-paper/80 hover:border-gold-ink/30 flex flex-col rounded-xl border p-4 shadow-xs transition-colors sm:p-5">
      <Eyebrow
        as="dt"
        tone="muted"
        rule={false}
        className="text-ink-muted text-xs font-semibold tracking-wider uppercase"
      >
        {label}
      </Eyebrow>
      <dd className="mt-4">
        <span className="font-display text-navy block text-2xl font-bold tracking-tight tabular-nums sm:text-4xl">
          {value}
        </span>
        <span className="text-ink-muted text-body-sm mt-1.5 block tabular-nums">
          {note}
        </span>
      </dd>
    </div>
  );
}

/** Four placeholder figures, the same grid the real ones fill. */
export function FigureSkeletons() {
  return (
    <div className={figureGrid}>
      {[0, 1, 2, 3].map((figure) => (
        <div
          key={figure}
          className="border-hairline bg-paper/50 rounded-xl border p-5"
        >
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="mt-4 h-9 w-20" />
          <Skeleton className="mt-2.5 h-3.5 w-32" />
        </div>
      ))}
    </div>
  );
}
