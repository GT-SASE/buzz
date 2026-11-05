import { ChevronDownIcon } from "lucide-react";

import { cn } from "~/lib/utils";

/**
 * A native <details> row: no client JavaScript. Rows that share a `name` open
 * one at a time, and an open row closes by pressing it again. The summary sits
 * in a heading so the question or title stays in the document outline.
 */
export function Disclosure({
  id,
  name,
  summary,
  children,
  className,
  summaryClassName,
  panelClassName,
}: {
  id?: string;
  name: string;
  summary: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  summaryClassName?: string;
  panelClassName?: string;
}) {
  return (
    <details
      id={id}
      name={name}
      className={cn("disclosure group border-b last:border-b-0", className)}
    >
      <summary
        className={cn(
          "focus-visible:border-ring focus-visible:ring-ring/50 flex min-h-11 cursor-pointer list-none items-start justify-between gap-4 rounded-md py-4 text-left text-sm font-medium transition-all outline-none focus-visible:ring-[3px] [&::-webkit-details-marker]:hidden",
          summaryClassName,
        )}
      >
        <h3 className="min-w-0 flex-1">{summary}</h3>
        <ChevronDownIcon className="text-muted-foreground pointer-events-none size-4 shrink-0 translate-y-0.5 transition-transform duration-200 group-open:rotate-180" />
      </summary>
      <div className={cn("pt-0 pb-4", panelClassName)}>{children}</div>
    </details>
  );
}
