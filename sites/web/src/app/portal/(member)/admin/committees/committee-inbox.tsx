"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Action } from "~/app/portal/_components/controls";
import { downloadCsv, toCsv } from "~/app/portal/_lib/csv";
import { formatDate } from "~/app/portal/_lib/format";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { selectedCommitteeIds, committees } from "~/data/committees";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

type Row = RouterOutputs["committee"]["list"][number];

const statusLabel: Record<Row["status"], string> = {
  submitted: "Submitted",
  interviewing: "Interviewing",
  accepted: "Accepted",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

function committeePhrase(row: {
  wantsEvents: boolean;
  wantsMarketing: boolean;
  wantsTreasury: boolean;
}) {
  const titles = selectedCommitteeIds(row).map(
    (id) => committees.find((committee) => committee.id === id)?.title ?? id,
  );
  return titles.join(", ");
}

function StatusBadge({ status }: { status: Row["status"] }) {
  return (
    <Badge
      variant={
        status === "accepted"
          ? "default"
          : status === "declined"
            ? "destructive"
            : "secondary"
      }
      className="font-semibold capitalize"
    >
      {statusLabel[status]}
    </Badge>
  );
}

export function CommitteeInbox() {
  const listing = api.committee.list.useQuery();
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState("");
  const utils = api.useUtils();

  if (listing.isPending) {
    return (
      <div className="grid gap-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (listing.error) {
    return <p className="text-destructive">{listing.error.message}</p>;
  }

  const rows = listing.data ?? [];

  const exportCycle = async () => {
    setExporting(true);
    setExportStatus("Preparing the export...");
    try {
      const { rows: exported, truncated } =
        await utils.committee.exportCycle.fetch(undefined, { staleTime: 0 });

      downloadCsv(
        "sase-committee-applications-fall-2026.csv",
        toCsv([
          [
            "Name",
            "Email",
            "Discord",
            "Committees",
            "Events why",
            "Events collabs",
            "Marketing why",
            "Marketing connections",
            "Treasury why",
            "Other orgs",
            "Comments",
            "Status",
            "Officer notes",
            "Submitted",
          ],
          ...exported.map((row) => [
            row.name ?? "",
            row.email,
            row.discordHandle,
            committeePhrase(row),
            row.eventsWhy ?? "",
            row.eventsCollabs ?? "",
            row.marketingWhy ?? "",
            row.marketingConnections ?? "",
            row.treasuryWhy ?? "",
            row.otherOrgs ?? "",
            row.comments ?? "",
            row.status,
            row.officerNotes ?? "",
            row.submittedAt.toISOString(),
          ]),
        ]),
      );

      setExportStatus(
        truncated
          ? `Exported the first ${exported.length} applications.`
          : `Exported ${exported.length} application${exported.length === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not export.");
      setExportStatus("");
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-ink-muted text-body-sm">
          {rows.length} application{rows.length === 1 ? "" : "s"}
        </p>
        <Action
          tone="quiet"
          disabled={exporting}
          onClick={() => void exportCycle()}
        >
          {exporting ? "Exporting..." : "Export CSV"}
        </Action>
      </div>
      {exportStatus && (
        <p className="text-ink-muted text-body-sm mb-4">{exportStatus}</p>
      )}

      {rows.length === 0 ? (
        <p className="text-ink-muted text-body">
          Nobody has applied this cycle yet.
        </p>
      ) : (
        <>
          <ul className="grid gap-4 md:hidden">
            {rows.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/portal/admin/committees/${row.id}`}
                  className="border-hairline bg-paper/80 block rounded-xl border p-5 shadow-xs"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-display text-navy text-base font-bold">
                        {row.name ?? row.email}
                      </p>
                      <p className="text-ink-muted text-body-sm mt-0.5 break-all">
                        {row.email}
                      </p>
                    </div>
                    <StatusBadge status={row.status} />
                  </div>
                  <p className="text-ink-muted text-body-sm mt-2.5">
                    {committeePhrase(row)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>

          <div className="hidden md:block">
            <div className="border-hairline bg-paper/50 overflow-hidden rounded-xl border shadow-xs">
              <Table label="Committee applications">
                <TableHeader className="bg-cream/40 border-hairline border-b">
                  <TableRow>
                    <TableHead className="text-ink-muted font-semibold">
                      Applicant
                    </TableHead>
                    <TableHead className="text-ink-muted font-semibold">
                      Committees
                    </TableHead>
                    <TableHead className="text-ink-muted font-semibold">
                      Status
                    </TableHead>
                    <TableHead className="text-ink-muted font-semibold">
                      Submitted
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow
                      key={row.id}
                      className={cn("hover:bg-cream/30 transition-colors")}
                    >
                      <TableCell className="py-4 whitespace-normal">
                        <Link
                          href={`/portal/admin/committees/${row.id}`}
                          className="text-navy font-semibold hover:underline"
                        >
                          {row.name ?? row.email}
                        </Link>
                        <p className="text-ink-muted text-body-sm mt-0.5">
                          {row.email}
                        </p>
                        <p className="text-ink-muted text-body-sm mt-0.5">
                          {row.discordHandle}
                        </p>
                      </TableCell>
                      <TableCell className="text-navy font-medium">
                        {committeePhrase(row)}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={row.status} />
                      </TableCell>
                      <TableCell className="text-ink-muted text-body-sm">
                        {formatDate(row.submittedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
