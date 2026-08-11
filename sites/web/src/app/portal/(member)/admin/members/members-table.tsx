"use client";

import { keepPreviousData } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Action, Field, inputClass } from "~/app/portal/_components/controls";
import { EmptyState } from "~/app/portal/_components/portal-ui";
import { downloadCsv, toCsv } from "~/app/portal/_lib/csv";
import { formatDate } from "~/app/portal/_lib/format";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

type Member = RouterOutputs["member"]["list"]["members"][number];
type SortKey = "points" | "name" | "recent";

const PAGE_SIZE = 25;
const DEBOUNCE_MS = 250;
/** Matches the router's input cap, so a long paste cannot become a zod error. */
const SEARCH_MAX = 100;

/**
 * Each sort has one fixed direction — a roster read "least recent first" is
 * nobody's question — so a header click picks a sort rather than flipping one.
 */
const sorts = {
  points: { direction: "descending", phrase: "highest first" },
  name: { direction: "ascending", phrase: "A to Z" },
  recent: { direction: "descending", phrase: "most recent first" },
} as const;

const columnHeading =
  "text-eyebrow tracking-caps text-ink-muted h-auto py-3 font-semibold uppercase";

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortKey;
  onSort: (next: SortKey) => void;
  className?: string;
}) {
  const active = sort === sortKey;
  const { direction, phrase } = sorts[sortKey];

  return (
    <TableHead
      aria-sort={active ? direction : "none"}
      className={cn(columnHeading, className)}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        aria-label={
          active ? `${label}, sorted ${phrase}` : `Sort by ${label}, ${phrase}`
        }
        className={cn(
          "inline-flex min-h-11 items-center gap-1.5",
          active ? "text-navy" : "hover:text-navy",
        )}
      >
        {label}
        {/* Held in the layout when inactive so the heading does not jump, and
            so the arrow — not colour alone — marks the sorted column. */}
        <span aria-hidden="true" className={active ? "" : "opacity-0"}>
          {direction === "ascending" ? "↑" : "↓"}
        </span>
      </button>
    </TableHead>
  );
}

function RosterTable({
  sort,
  onSort,
  children,
}: {
  sort: SortKey;
  onSort: (next: SortKey) => void;
  children: React.ReactNode;
}) {
  return (
    <Table className="border-hairline min-w-[46rem] border-b text-left">
      <TableHeader>
        <TableRow className="border-hairline">
          {/* w-full on the one elastic column; the rest hug their text. */}
          <SortHeader
            label="Name"
            sortKey="name"
            sort={sort}
            onSort={onSort}
            className="w-full pr-6"
          />
          <TableHead className={cn(columnHeading, "pr-6")}>Email</TableHead>
          <TableHead className={cn(columnHeading, "pr-6")}>Role</TableHead>
          <SortHeader
            label="Points"
            sortKey="points"
            sort={sort}
            onSort={onSort}
            className="pr-6 text-right"
          />
          <TableHead className={cn(columnHeading, "pr-6 text-right")}>
            Events
          </TableHead>
          <SortHeader
            label="Last check-in"
            sortKey="recent"
            sort={sort}
            onSort={onSort}
            className="text-right"
          />
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

function MemberRow({ member }: { member: Member }) {
  return (
    <TableRow className="border-hairline">
      <TableCell className="py-3 pr-6 whitespace-normal">
        {/* A real anchor, so middle-click and open-in-new-tab work. The label
            carries the email when there is no name to read out. */}
        <Link
          href={`/portal/admin/members/${member.id}`}
          aria-label={member.name ?? `Member ${member.email}`}
          className="font-display text-navy hover:text-gold-ink inline-flex min-h-11 items-center font-bold"
        >
          {member.name ?? "—"}
        </Link>
      </TableCell>

      <TableCell className="text-ink-muted text-body-sm py-3 pr-6">
        {member.email}
      </TableCell>

      <TableCell className="py-3 pr-6">
        {member.role === "ADMIN" ? (
          <Badge className="bg-gold-bright text-navy border-transparent font-semibold">
            Officer
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="border-hairline text-ink-muted font-semibold"
          >
            Member
          </Badge>
        )}
      </TableCell>

      <TableCell className="text-navy py-3 pr-6 text-right font-semibold tabular-nums">
        {member.totalPoints}
      </TableCell>

      <TableCell className="text-ink-muted py-3 pr-6 text-right tabular-nums">
        {member.totalEvents}
      </TableCell>

      <TableCell className="text-ink-muted text-body-sm py-3 text-right tabular-nums">
        {member.lastCheckInAt ? formatDate(member.lastCheckInAt) : "Never"}
      </TableCell>
    </TableRow>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 6 }, (_, index) => (
        <TableRow key={index} className="border-hairline">
          <TableCell className="py-4 pr-6">
            <Skeleton className="h-4 w-40" />
          </TableCell>
          <TableCell className="py-4 pr-6">
            <Skeleton className="h-3 w-52" />
          </TableCell>
          <TableCell className="py-4 pr-6">
            <Skeleton className="h-5 w-16 rounded-full" />
          </TableCell>
          <TableCell className="py-4 pr-6">
            <Skeleton className="ml-auto h-4 w-8" />
          </TableCell>
          <TableCell className="py-4 pr-6">
            <Skeleton className="ml-auto h-4 w-8" />
          </TableCell>
          <TableCell className="py-4">
            <Skeleton className="ml-auto h-4 w-24" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function exportFilename(term: string) {
  const slug = term.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug ? `chapter-roster-${slug}.csv` : "chapter-roster.csv";
}

export function MembersTable() {
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<SortKey>("points");
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState("");

  const utils = api.useUtils();

  // The offset resets with the term, in the same commit: a page 3 left behind
  // by a narrower search renders as "no members found". Only on a real change,
  // so a typed-then-deleted character does not throw away the page.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = search.trim();
      if (next === term) return;
      setTerm(next);
      setOffset(0);
      setExportStatus("");
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [search, term]);

  const listing = api.member.list.useQuery(
    {
      search: term.length > 0 ? term : undefined,
      limit: PAGE_SIZE,
      offset,
      sort,
    },
    // Paging swaps the query key; without this the rows drop to skeletons for
    // every click of Next.
    { placeholderData: keepPreviousData },
  );

  const members = listing.data?.members ?? [];
  const total = listing.data?.total ?? 0;
  const stale = listing.isPlaceholderData;

  // Clamped: `offset` moves in the click's commit while the placeholder rows
  // are still the previous page, so the unclamped end can read past the total —
  // and this string is what the live region announces.
  const countLine = listing.isPending
    ? "Loading members."
    : total === 0
      ? "No members found."
      : `Showing ${offset + 1}-${Math.min(offset + members.length, total)} of ${total} member${total === 1 ? "" : "s"}`;

  // The export result shares the live region with the count, so it is cleared
  // whenever the window moves — otherwise "Exported 412 members" is announced
  // again beside a count of the 3 that a later search matched.
  const clearSearch = () => {
    setSearch("");
    setTerm("");
    setOffset(0);
    setExportStatus("");
  };

  // A sort is part of the query key, so it moves the window the same way a new
  // search does: page 3 of "by points" is not page 3 of "by name".
  const changeSort = (next: SortKey) => {
    if (next === sort) return;
    setSort(next);
    setOffset(0);
    setExportStatus("");
  };

  const goTo = (next: number) => {
    setOffset(next);
    setExportStatus("");
  };

  // The whole matching roster, fetched on the click rather than kept warm on
  // every render of the page.
  const exportRoster = async () => {
    setExporting(true);
    setExportStatus("Preparing the export...");

    try {
      // staleTime 0, or the shared query client answers a second export from
      // its 30-second cache and hands back the previous snapshot as fresh.
      const { members: rows, truncated } =
        await utils.member.exportRoster.fetch(
          { search: term.length > 0 ? term : undefined },
          { staleTime: 0 },
        );

      downloadCsv(
        exportFilename(term),
        toCsv([
          ["Name", "Email", "Role", "Points", "Events", "Last check-in"],
          ...rows.map((row) => [
            row.name ?? "",
            row.email,
            row.role === "ADMIN" ? "Officer" : "Member",
            row.totalPoints,
            row.totalEvents,
            row.lastCheckInAt?.toISOString() ?? "",
          ]),
        ]),
      );

      setExportStatus(
        truncated
          ? `Exported the first ${rows.length} members. Narrow the search to export the rest.`
          : `Exported ${rows.length} member${rows.length === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      setExportStatus(
        `Export failed. ${error instanceof Error ? error.message : "Try again."}`,
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Field
          label="Search members"
          htmlFor="member-search"
          className="max-w-sm flex-1"
        >
          <Input
            id="member-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name or email"
            maxLength={SEARCH_MAX}
            className={cn(inputClass, "h-11")}
          />
        </Field>

        <div className="sm:text-right">
          <Action
            onClick={() => void exportRoster()}
            disabled={exporting || total === 0}
            className="min-h-11"
          >
            {exporting ? "Exporting..." : "Export CSV"}
          </Action>
          <p className="text-ink-muted text-body-sm max-w-measure mt-2">
            Exports every member matching the current search, not only this
            page.
          </p>
        </div>
      </div>

      <div className="mt-8" aria-busy={stale}>
        {listing.error ? (
          <Alert variant="destructive" className="border-hairline">
            <AlertTitle>Could not load members.</AlertTitle>
            <AlertDescription>{listing.error.message}</AlertDescription>
          </Alert>
        ) : listing.isPending ? (
          // inert as well as hidden: the sort headers are real buttons, and a
          // focusable control inside an aria-hidden subtree is a trap.
          <div aria-hidden="true" inert>
            <RosterTable sort={sort} onSort={changeSort}>
              <SkeletonRows />
            </RosterTable>
          </div>
        ) : members.length > 0 ? (
          <div
            className={cn(
              "transition-opacity duration-200",
              stale && "opacity-60",
            )}
          >
            <RosterTable sort={sort} onSort={changeSort}>
              {members.map((member) => (
                <MemberRow key={member.id} member={member} />
              ))}
            </RosterTable>
          </div>
        ) : offset > 0 ? (
          // A page past the end of a result set that shrank. Without this the
          // search empty state claims there are no matches while page 1 has them.
          <EmptyState
            title="Nothing on this page."
            body="The roster is shorter than it was when this page was opened."
          >
            <Action onClick={() => goTo(0)} className="min-h-11">
              Back to the first page
            </Action>
          </EmptyState>
        ) : term.length > 0 ? (
          <EmptyState
            title={`No members match "${term}".`}
            body="Try part of a name, or the email address they sign in with."
          >
            <Action onClick={clearSearch} className="min-h-11">
              Clear the search
            </Action>
          </EmptyState>
        ) : (
          <EmptyState
            title="No members yet."
            body="They appear here after their first sign-in."
          />
        )}
      </div>

      {!listing.error && (
        <div className="border-hairline mt-6 flex flex-wrap items-center justify-between gap-4 border-t pt-4">
          {/* The only thing that tells a screen reader the page moved, and the
              one region the export reports into rather than opening a second. */}
          <p
            aria-live="polite"
            className="text-ink-muted text-body-sm tabular-nums"
          >
            {countLine}
            {exportStatus ? ` · ${exportStatus}` : ""}
          </p>

          {/* Both disabled while the rows are stale: `total` still describes
              the previous result set, so Next would page past the end of a
              narrower search that has not landed yet. */}
          {(total > PAGE_SIZE || offset > 0) && (
            <div className="flex items-center gap-2">
              <Action
                disabled={stale || offset === 0}
                onClick={() => goTo(Math.max(0, offset - PAGE_SIZE))}
                className="min-h-11"
              >
                Previous
              </Action>
              <Action
                disabled={stale || offset + PAGE_SIZE >= total}
                onClick={() => goTo(offset + PAGE_SIZE)}
                className="min-h-11"
              >
                Next
              </Action>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
