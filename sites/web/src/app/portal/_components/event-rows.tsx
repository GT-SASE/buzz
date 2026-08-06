import { formatEventTime } from "~/app/portal/_lib/format";
import { Badge } from "~/components/ui/badge";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

export type EventRow = {
  key: string;
  title: string;
  at: Date;
  location: string | null;
  points: number;
  /** Already attended — shown instead of the points a check-in would earn. */
  done?: boolean;
  note?: string | null;
};

/**
 * Events as a table: date and points sit in fixed columns so they compare down
 * the page, and stay legible when there are twenty of them.
 */
export function EventRows({
  title,
  count,
  rows,
  empty,
}: {
  title: string;
  count?: string;
  rows: EventRow[];
  empty: React.ReactNode;
}) {
  return (
    <section className="mt-12">
      <div className="border-hairline flex items-baseline justify-between gap-4 border-b pb-3">
        <h2 className="text-eyebrow tracking-caps text-ink-muted font-semibold uppercase">
          {title}
        </h2>
        {count && (
          <p className="text-ink-muted text-body-sm tabular-nums">{count}</p>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="border-hairline bg-cream mt-6 rounded-lg border border-dashed px-6 py-10">
          {empty}
        </div>
      ) : (
        <Table>
          <TableCaption className="sr-only">{title}</TableCaption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="text-eyebrow tracking-caps text-ink-muted w-36 px-0 font-semibold uppercase">
                When
              </TableHead>
              <TableHead className="text-eyebrow tracking-caps text-ink-muted px-0 font-semibold uppercase">
                Event
              </TableHead>
              <TableHead className="text-eyebrow tracking-caps text-ink-muted px-0 text-right font-semibold uppercase">
                Points
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell className="text-ink-muted text-body-sm px-0 py-4 align-top tabular-nums">
                  {formatEventTime(row.at)}
                </TableCell>

                <TableCell className="px-0 py-4 align-top whitespace-normal">
                  <span className="text-navy font-semibold">{row.title}</span>
                  {row.location && (
                    <span className="text-ink-muted text-body-sm">
                      {" "}
                      · {row.location}
                    </span>
                  )}
                  {row.note && (
                    <span className="text-ink-muted/80 text-body-sm block italic">
                      {row.note}
                    </span>
                  )}
                </TableCell>

                <TableCell className="px-0 py-4 text-right align-top">
                  {row.done ? (
                    <Badge
                      variant="secondary"
                      className="text-ink-muted font-semibold"
                    >
                      Checked in
                    </Badge>
                  ) : (
                    <span className="text-gold-ink text-body-sm font-semibold tabular-nums">
                      +{row.points}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
