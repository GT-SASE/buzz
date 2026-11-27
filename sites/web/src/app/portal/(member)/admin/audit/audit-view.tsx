"use client";

import { keepPreviousData } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import type { AuditAction, PointsSource } from "@buzz/db";

import { Action, Field, inputClass } from "~/app/portal/_components/controls";
import { EmptyState } from "~/app/portal/_components/portal-ui";
import { formatEventTime } from "~/app/portal/_lib/format";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
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
import {
  actionLabels,
  actionNames,
  dateRange,
  describeChange,
  describeTarget,
  PAGE_SIZE,
  sourceLabels,
  sourceNames,
} from "./audit-text";

type View = "log" | "ledger";
type LogRow = RouterOutputs["audit"]["log"]["rows"][number];
type LedgerRow = RouterOutputs["audit"]["ledger"]["rows"][number];

const DEBOUNCE_MS = 250;
const SEARCH_MAX = 100;

const columnHeading =
  "text-eyebrow tracking-caps text-ink-muted h-auto py-3 font-semibold uppercase";

const controlClass = cn(inputClass, "bg-paper/80 h-11 w-full px-3");

function who(name: string | null, email: string | null, fallback: string) {
  return name ?? email ?? fallback;
}

function signed(delta: number) {
  return delta > 0 ? `+${delta}` : String(delta);
}

export function AuditView() {
  const [view, setView] = useState<View>("log");

  return (
    <div>
      {/* One track, two positions, the same control the events list uses. */}
      <div
        role="group"
        aria-label="Choose a list"
        className="ring-hairline bg-cream inline-grid max-w-full grid-cols-2 gap-1 rounded-xl p-1 ring-1"
      >
        {(
          [
            ["log", "Audit log"],
            ["ledger", "Points ledger"],
          ] as const
        ).map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant={view === key ? "default" : "ghost"}
            aria-pressed={view === key}
            onClick={() => setView(key)}
            className={cn(
              "min-h-11 rounded-lg px-4 text-sm font-semibold transition-all sm:min-h-9 sm:text-xs",
              view === key
                ? "bg-navy text-white shadow-xs"
                : "text-ink-muted hover:bg-paper hover:text-navy",
            )}
          >
            {label}
          </Button>
        ))}
      </div>

      <div className="mt-8">
        {view === "log" ? <AuditLogPanel /> : <LedgerPanel />}
      </div>
    </div>
  );
}

/** Previous / Next and the live count, shared by both lists. */
function Pager({
  line,
  offset,
  total,
  stale,
  onGo,
}: {
  line: string;
  offset: number;
  total: number;
  stale: boolean;
  onGo: (next: number) => void;
}) {
  const paged = total > PAGE_SIZE || offset > 0;

  return (
    <div
      className={cn(
        "mt-4 flex flex-wrap items-center justify-between gap-4",
        paged && "border-hairline bg-paper/50 rounded-xl border p-4 shadow-xs",
      )}
    >
      <p
        aria-live="polite"
        className="text-ink-muted text-body-sm font-medium tabular-nums"
      >
        {line}
      </p>
      {paged && (
        <div className="flex items-center gap-2">
          <Action
            disabled={stale || offset === 0}
            onClick={() => onGo(Math.max(0, offset - PAGE_SIZE))}
            className="min-h-11 px-4 text-sm font-semibold"
          >
            Previous
          </Action>
          <Action
            disabled={stale || offset + PAGE_SIZE >= total}
            onClick={() => onGo(offset + PAGE_SIZE)}
            className="min-h-11 px-4 text-sm font-semibold"
          >
            Next
          </Action>
        </div>
      )}
    </div>
  );
}

function SkeletonList() {
  return (
    <div aria-hidden="true" inert className="grid gap-3">
      {Array.from({ length: 5 }, (_, index) => (
        <div
          key={index}
          className="border-hairline rounded-lg border px-4 py-4"
        >
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-2 h-3 w-64 max-w-full" />
        </div>
      ))}
    </div>
  );
}

function DateFilters({
  idPrefix,
  from,
  to,
  onFrom,
  onTo,
}: {
  idPrefix: string;
  from: string;
  to: string;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
}) {
  return (
    <>
      <Field label="From" htmlFor={`${idPrefix}-from`}>
        <Input
          id={`${idPrefix}-from`}
          type="date"
          value={from}
          max={to || undefined}
          onChange={(event) => onFrom(event.target.value)}
          className={controlClass}
        />
      </Field>
      <Field label="To" htmlFor={`${idPrefix}-to`}>
        <Input
          id={`${idPrefix}-to`}
          type="date"
          value={to}
          min={from || undefined}
          onChange={(event) => onTo(event.target.value)}
          className={controlClass}
        />
      </Field>
    </>
  );
}

function countLine(
  pending: boolean,
  total: number,
  offset: number,
  shown: number,
  noun: string,
) {
  if (pending) return `Loading ${noun}.`;
  if (total === 0) return `No ${noun} found.`;
  return `Showing ${offset + 1}-${Math.min(offset + shown, total)} of ${total}`;
}

// ------------------------------------------------------------------ audit log

function AuditLogPanel() {
  const [actorId, setActorId] = useState("");
  const [action, setAction] = useState<AuditAction | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);

  const actors = api.audit.actors.useQuery();
  const range = dateRange(from, to);

  const listing = api.audit.log.useQuery(
    {
      actorId: actorId || undefined,
      action: action || undefined,
      from: range.from,
      to: range.to,
      limit: PAGE_SIZE,
      offset,
    },
    { placeholderData: keepPreviousData },
  );

  const rows = listing.data?.rows ?? [];
  const total = listing.data?.total ?? 0;
  const stale = listing.isPlaceholderData;
  const filtered = Boolean(actorId || action || from || to);

  // Every filter change starts again from the first page: page 3 of one
  // result set is not page 3 of another.
  const change = <T,>(set: (value: T) => void) => {
    return (value: T) => {
      set(value);
      setOffset(0);
    };
  };

  const clear = () => {
    setActorId("");
    setAction("");
    setFrom("");
    setTo("");
    setOffset(0);
  };

  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Officer" htmlFor="audit-actor">
          <select
            id="audit-actor"
            value={actorId}
            onChange={(event) => change(setActorId)(event.target.value)}
            className={controlClass}
          >
            <option value="">Everyone</option>
            {(actors.data ?? []).map((actor) => (
              <option key={actor.id} value={actor.id}>
                {who(actor.name, actor.email, actor.id)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Action" htmlFor="audit-action">
          <select
            id="audit-action"
            value={action}
            onChange={(event) =>
              change(setAction)(event.target.value as AuditAction | "")
            }
            className={controlClass}
          >
            <option value="">Every action</option>
            {actionNames.map((name) => (
              <option key={name} value={name}>
                {actionLabels[name]}
              </option>
            ))}
          </select>
        </Field>
        <DateFilters
          idPrefix="audit"
          from={from}
          to={to}
          onFrom={change(setFrom)}
          onTo={change(setTo)}
        />
      </div>

      <div className="mt-8" aria-busy={stale}>
        {listing.error ? (
          <Alert variant="destructive" className="border-hairline">
            <AlertTitle>Could not load the audit log.</AlertTitle>
            <AlertDescription>{listing.error.message}</AlertDescription>
          </Alert>
        ) : listing.isPending ? (
          <SkeletonList />
        ) : rows.length > 0 ? (
          <div
            className={cn(
              "transition-opacity duration-200",
              stale && "opacity-60",
            )}
          >
            <ul className="grid gap-3 md:hidden">
              {rows.map((row) => (
                <AuditCard key={row.id} row={row} />
              ))}
            </ul>
            <div className="border-hairline bg-paper/50 hidden overflow-hidden rounded-xl border shadow-xs md:block">
              <Table label="Audit log" className="min-w-[48rem] text-left">
                <TableHeader className="bg-cream/40 border-hairline border-b">
                  <TableRow className="border-hairline">
                    <TableHead className={cn(columnHeading, "pr-6")}>
                      When
                    </TableHead>
                    <TableHead className={cn(columnHeading, "pr-6")}>
                      Officer
                    </TableHead>
                    <TableHead className={cn(columnHeading, "pr-6")}>
                      Action
                    </TableHead>
                    <TableHead className={cn(columnHeading, "pr-6")}>
                      About
                    </TableHead>
                    <TableHead className={columnHeading}>Change</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <AuditRow key={row.id} row={row} />
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : offset > 0 ? (
          <EmptyState
            headingLevel="h2"
            title="Nothing on this page."
            body="The log is shorter than it was when this page was opened."
          >
            <Action onClick={() => setOffset(0)} className="min-h-11">
              Back to the first page
            </Action>
          </EmptyState>
        ) : filtered ? (
          <EmptyState
            headingLevel="h2"
            title="No entries match."
            body="Widen the dates, or pick another officer or action."
          >
            <Action onClick={clear} className="min-h-11">
              Clear the filters
            </Action>
          </EmptyState>
        ) : (
          <EmptyState
            headingLevel="h2"
            title="Nothing logged yet."
            body="Role changes, application decisions, manual check-ins, point awards, exports and resume downloads appear here as they happen."
          />
        )}
      </div>

      {!listing.error && (
        <Pager
          line={countLine(
            listing.isPending,
            total,
            offset,
            rows.length,
            "entries",
          )}
          offset={offset}
          total={total}
          stale={stale}
          onGo={setOffset}
        />
      )}
    </div>
  );
}

function AuditRow({ row }: { row: LogRow }) {
  return (
    <TableRow className="border-hairline hover:bg-cream/30 transition-colors">
      <TableCell className="text-ink-muted text-body-sm py-3.5 pr-6 whitespace-nowrap tabular-nums">
        {formatEventTime(row.at)}
      </TableCell>
      <TableCell className="text-navy py-3.5 pr-6 font-semibold">
        {who(row.actorName, row.actorEmail, "Removed account")}
      </TableCell>
      <TableCell className="py-3.5 pr-6">
        <Badge
          variant="outline"
          className="border-hairline text-navy font-semibold whitespace-nowrap"
        >
          {actionLabels[row.action]}
        </Badge>
      </TableCell>
      <TableCell className="text-ink py-3.5 pr-6 break-words whitespace-normal">
        {describeTarget(row)}
      </TableCell>
      <TableCell className="text-ink-muted text-body-sm py-3.5 whitespace-normal">
        {describeChange(row)}
      </TableCell>
    </TableRow>
  );
}

function AuditCard({ row }: { row: LogRow }) {
  return (
    <li className="border-hairline bg-paper/80 rounded-xl border p-4 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge
          variant="outline"
          className="border-hairline text-navy font-semibold"
        >
          {actionLabels[row.action]}
        </Badge>
        <span className="text-ink-muted text-body-sm tabular-nums">
          {formatEventTime(row.at)}
        </span>
      </div>
      <p className="text-ink mt-3 font-semibold break-words">
        {describeTarget(row)}
      </p>
      <p className="text-ink-muted text-body-sm mt-1 break-words">
        {describeChange(row)}
      </p>
      <p className="text-ink-muted text-body-sm border-hairline mt-3 border-t pt-2.5">
        By {who(row.actorName, row.actorEmail, "a removed account")}
      </p>
    </li>
  );
}

// ------------------------------------------------------------- points ledger

function LedgerPanel() {
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [source, setSource] = useState<PointsSource | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);

  // The offset resets with the term in the same commit, as the roster search does.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = search.trim();
      if (next === term) return;
      setTerm(next);
      setOffset(0);
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [search, term]);

  const range = dateRange(from, to);

  const listing = api.audit.ledger.useQuery(
    {
      search: term || undefined,
      source: source || undefined,
      from: range.from,
      to: range.to,
      limit: PAGE_SIZE,
      offset,
    },
    { placeholderData: keepPreviousData },
  );

  const rows = listing.data?.rows ?? [];
  const total = listing.data?.total ?? 0;
  const net = listing.data?.net ?? 0;
  const stale = listing.isPlaceholderData;
  const filtered = Boolean(term || source || from || to);

  const change = <T,>(set: (value: T) => void) => {
    return (value: T) => {
      set(value);
      setOffset(0);
    };
  };

  const clear = () => {
    setSearch("");
    setTerm("");
    setSource("");
    setFrom("");
    setTo("");
    setOffset(0);
  };

  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Member" htmlFor="ledger-member">
          <Input
            id="ledger-member"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name or email"
            maxLength={SEARCH_MAX}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="search"
            className={cn(inputClass, "bg-paper/80 h-11")}
          />
        </Field>
        <Field label="Source" htmlFor="ledger-source">
          <select
            id="ledger-source"
            value={source}
            onChange={(event) =>
              change(setSource)(event.target.value as PointsSource | "")
            }
            className={controlClass}
          >
            <option value="">Every source</option>
            {sourceNames.map((name) => (
              <option key={name} value={name}>
                {sourceLabels[name]}
              </option>
            ))}
          </select>
        </Field>
        <DateFilters
          idPrefix="ledger"
          from={from}
          to={to}
          onFrom={change(setFrom)}
          onTo={change(setTo)}
        />
      </div>

      <div className="mt-8" aria-busy={stale}>
        {listing.error ? (
          <Alert variant="destructive" className="border-hairline">
            <AlertTitle>Could not load the ledger.</AlertTitle>
            <AlertDescription>{listing.error.message}</AlertDescription>
          </Alert>
        ) : listing.isPending ? (
          <SkeletonList />
        ) : rows.length > 0 ? (
          <div
            className={cn(
              "transition-opacity duration-200",
              stale && "opacity-60",
            )}
          >
            <ul className="grid gap-3 md:hidden">
              {rows.map((row) => (
                <LedgerCard key={row.id} row={row} />
              ))}
            </ul>
            <div className="border-hairline bg-paper/50 hidden overflow-hidden rounded-xl border shadow-xs md:block">
              <Table label="Points ledger" className="min-w-[48rem] text-left">
                <TableHeader className="bg-cream/40 border-hairline border-b">
                  <TableRow className="border-hairline">
                    <TableHead className={cn(columnHeading, "pr-6")}>
                      When
                    </TableHead>
                    <TableHead className={cn(columnHeading, "pr-6")}>
                      Member
                    </TableHead>
                    <TableHead className={cn(columnHeading, "pr-6 text-right")}>
                      Points
                    </TableHead>
                    <TableHead className={cn(columnHeading, "pr-6")}>
                      Why
                    </TableHead>
                    <TableHead className={columnHeading}>Source</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <LedgerTableRow key={row.id} row={row} />
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : offset > 0 ? (
          <EmptyState
            headingLevel="h2"
            title="Nothing on this page."
            body="The ledger is shorter than it was when this page was opened."
          >
            <Action onClick={() => setOffset(0)} className="min-h-11">
              Back to the first page
            </Action>
          </EmptyState>
        ) : filtered ? (
          <EmptyState
            headingLevel="h2"
            title="No points match."
            body="Try part of a name, another source, or wider dates."
          >
            <Action onClick={clear} className="min-h-11">
              Clear the filters
            </Action>
          </EmptyState>
        ) : (
          <EmptyState
            headingLevel="h2"
            title="No points yet."
            body="Check-ins and KIN awards appear here as they happen."
          />
        )}
      </div>

      {!listing.error && (
        <Pager
          line={`${countLine(listing.isPending, total, offset, rows.length, "rows")}${
            total > 0 && !listing.isPending
              ? ` · Net ${signed(net)} points across all of them`
              : ""
          }`}
          offset={offset}
          total={total}
          stale={stale}
          onGo={setOffset}
        />
      )}
    </div>
  );
}

function PointsFigure({ delta }: { delta: number }) {
  return (
    <span
      className={cn(
        "font-bold tabular-nums",
        delta < 0 ? "text-destructive" : "text-navy",
      )}
    >
      {signed(delta)}
    </span>
  );
}

function LedgerTableRow({ row }: { row: LedgerRow }) {
  return (
    <TableRow className="border-hairline hover:bg-cream/30 transition-colors">
      <TableCell className="text-ink-muted text-body-sm py-3.5 pr-6 whitespace-nowrap tabular-nums">
        {formatEventTime(row.at)}
      </TableCell>
      <TableCell className="py-3.5 pr-6 whitespace-normal">
        <span className="text-navy block font-semibold">
          {who(row.name, row.email, row.userId)}
        </span>
        {row.name && (
          <span className="text-ink-muted text-body-sm block break-all">
            {row.email}
          </span>
        )}
      </TableCell>
      <TableCell className="py-3.5 pr-6 text-right">
        <PointsFigure delta={row.delta} />
      </TableCell>
      <TableCell className="text-ink py-3.5 pr-6 break-words whitespace-normal">
        {row.reason}
      </TableCell>
      <TableCell className="text-ink-muted text-body-sm py-3.5 whitespace-normal">
        {sourceLabels[row.source]}
        {(row.actorName ?? row.actorEmail)
          ? `, by ${who(row.actorName, row.actorEmail, "")}`
          : ""}
      </TableCell>
    </TableRow>
  );
}

function LedgerCard({ row }: { row: LedgerRow }) {
  return (
    <li className="border-hairline bg-paper/80 rounded-xl border p-4 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <p className="text-navy font-semibold break-words">
          {who(row.name, row.email, row.userId)}
        </p>
        <PointsFigure delta={row.delta} />
      </div>
      <p className="text-ink mt-1 break-words">{row.reason}</p>
      <p className="text-ink-muted text-body-sm border-hairline mt-3 flex flex-wrap justify-between gap-2 border-t pt-2.5">
        <span>
          {sourceLabels[row.source]}
          {(row.actorName ?? row.actorEmail)
            ? `, by ${who(row.actorName, row.actorEmail, "")}`
            : ""}
        </span>
        <span className="tabular-nums">{formatEventTime(row.at)}</span>
      </p>
    </li>
  );
}
