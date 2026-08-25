"use client";

import { toast } from "sonner";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { api, type RouterOutputs } from "~/trpc/react";

type Row = RouterOutputs["mentorship"]["list"][number];

function RowActions({
  row,
  busy,
  onEnroll,
  onAward,
  onRemove,
}: {
  row: Row;
  busy: boolean;
  onEnroll: () => void;
  onAward: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 md:justify-end">
      {row.status !== "enrolled" && (
        <Button
          size="sm"
          className="min-h-11"
          disabled={busy}
          onClick={onEnroll}
        >
          Enroll
        </Button>
      )}
      {row.status === "enrolled" && (
        <>
          <Button
            size="sm"
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={onAward}
          >
            +5 pts
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11"
            disabled={busy}
            onClick={onRemove}
          >
            Remove
          </Button>
        </>
      )}
    </div>
  );
}

export function MentorshipRoster() {
  const utils = api.useUtils();
  const listing = api.mentorship.list.useQuery();
  const setStatus = api.mentorship.setStatus.useMutation({
    onSuccess: async () => {
      toast.success("Updated.");
      await utils.mentorship.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const award = api.mentorship.awardPoints.useMutation({
    onSuccess: async (row) => {
      toast.success(`Now ${row?.points ?? 0} family points.`);
      await utils.mentorship.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

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
  if (rows.length === 0) {
    return (
      <p className="text-ink-muted text-body">
        Nobody has signed up yet. Members use Families in the portal.
      </p>
    );
  }

  const busy = setStatus.isPending || award.isPending;
  const actions = (row: Row) => (
    <RowActions
      row={row}
      busy={busy}
      onEnroll={() =>
        setStatus.mutate({ userId: row.userId, status: "enrolled" })
      }
      onAward={() => award.mutate({ userId: row.userId, points: 5 })}
      onRemove={() =>
        setStatus.mutate({ userId: row.userId, status: "withdrawn" })
      }
    />
  );

  return (
    <>
      <ul className="grid gap-4 md:hidden">
        {rows.map((row) => (
          <li
            key={row.userId}
            className="border-hairline rounded-lg border px-4 py-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-navy font-semibold">
                  {row.name ?? row.email}
                </p>
                <p className="text-ink-muted text-body-sm break-all">
                  {row.email}
                </p>
              </div>
              <Badge
                variant={row.status === "enrolled" ? "default" : "secondary"}
              >
                {row.status}
              </Badge>
            </div>
            <p className="text-ink-muted text-body-sm mt-2 capitalize">
              {row.role} · {row.points} pts
            </p>
            {row.note && (
              <p className="text-ink-muted/80 text-body-sm mt-1 italic">
                {row.note}
              </p>
            )}
            <div className="mt-4">{actions(row)}</div>
          </li>
        ))}
      </ul>

      <div className="hidden md:block">
        <Table label="Mentor families">
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Points</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.userId}>
                <TableCell className="whitespace-normal">
                  <p className="text-navy font-semibold">
                    {row.name ?? row.email}
                  </p>
                  <p className="text-ink-muted text-body-sm">{row.email}</p>
                  {row.note && (
                    <p className="text-ink-muted/80 text-body-sm mt-1 italic">
                      {row.note}
                    </p>
                  )}
                </TableCell>
                <TableCell className="capitalize">{row.role}</TableCell>
                <TableCell>
                  <Badge
                    variant={
                      row.status === "enrolled" ? "default" : "secondary"
                    }
                  >
                    {row.status}
                  </Badge>
                </TableCell>
                <TableCell className="tabular-nums">{row.points}</TableCell>
                <TableCell>{actions(row)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
