"use client";

import { toast } from "sonner";

import { Badge } from "~/components/ui/badge";
import { Action } from "~/app/portal/_components/controls";
import { ConfirmDialog } from "~/app/portal/_components/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
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
import { semesterLabel } from "@buzz/api/terms";
import { api, type RouterOutputs } from "~/trpc/react";

type Row = RouterOutputs["mentorship"]["list"][number];
type Group = RouterOutputs["mentorship"]["groups"][number];

const NO_GROUP = "none";

function GroupPicker({
  row,
  groups,
  busy,
  onAssign,
}: {
  row: Row;
  groups: Group[];
  busy: boolean;
  onAssign: (groupId: string | null) => void;
}) {
  if (row.status === "withdrawn") return null;
  return (
    <Select
      value={row.groupId ?? NO_GROUP}
      disabled={busy || groups.length === 0}
      onValueChange={(value) => onAssign(value === NO_GROUP ? null : value)}
    >
      <SelectTrigger
        aria-label={`Kin group for ${row.name ?? row.email}`}
        className="h-auto min-h-11 w-full min-w-40 text-sm md:w-44"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_GROUP}>No group</SelectItem>
        {groups.map((group) => (
          <SelectItem key={group.id} value={group.id}>
            {group.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

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
        <Action tone="solid" disabled={busy} onClick={onEnroll}>
          Enroll
        </Action>
      )}
      {row.status === "enrolled" && (
        <>
          <Action tone="quiet" disabled={busy} onClick={onAward}>
            +5 pts
          </Action>
          <ConfirmDialog
            title={`Remove ${row.name ?? row.email} from SASE KIN?`}
            body="They come off the roster and out of their kin group. They can sign up again from the portal."
            action="Remove"
            danger
            onConfirm={onRemove}
          >
            <Action tone="quiet" disabled={busy}>
              Remove
            </Action>
          </ConfirmDialog>
        </>
      )}
    </div>
  );
}

export function MentorshipRoster({
  semester,
  readOnly,
}: {
  semester: string;
  readOnly: boolean;
}) {
  const utils = api.useUtils();
  const listing = api.mentorship.list.useQuery({ semester });
  const groups = api.mentorship.groups.useQuery({ semester });
  const assign = api.mentorship.assignGroup.useMutation({
    onSuccess: async () => {
      toast.success("Group updated.");
      await Promise.all([
        utils.mentorship.list.invalidate(),
        utils.mentorship.groups.invalidate(),
      ]);
    },
    onError: (error) => toast.error(error.message),
  });
  const setStatus = api.mentorship.setStatus.useMutation({
    onSuccess: async () => {
      toast.success("Updated.");
      await Promise.all([
        utils.mentorship.list.invalidate(),
        utils.mentorship.groups.invalidate(),
      ]);
    },
    onError: (error) => toast.error(error.message),
  });
  const award = api.mentorship.awardPoints.useMutation({
    onSuccess: async (row) => {
      toast.success(`Now ${row?.points ?? 0} KIN points.`);
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
        {readOnly
          ? `Nobody signed up in ${semesterLabel(semester)}.`
          : "Nobody has signed up yet this year. Members use SASE KIN in the portal."}
      </p>
    );
  }

  const busy = (row: Row) =>
    [setStatus, award, assign].some(
      (mutation) =>
        mutation.isPending && mutation.variables?.userId === row.userId,
    );
  const groupList = groups.data ?? [];
  const groupName = (row: Row) =>
    groupList.find((group) => group.id === row.groupId)?.name ?? "No group";
  const picker = (row: Row) =>
    readOnly ? (
      <span className="text-navy text-body-sm font-medium">
        {groupName(row)}
      </span>
    ) : (
      <GroupPicker
        row={row}
        groups={groupList}
        busy={busy(row)}
        onAssign={(groupId) => assign.mutate({ userId: row.userId, groupId })}
      />
    );
  const actions = (row: Row) =>
    readOnly ? null : (
      <RowActions
        row={row}
        busy={busy(row)}
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
            className="border-hairline bg-paper/80 rounded-xl border p-5 shadow-xs transition"
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
              <Badge
                variant={row.status === "enrolled" ? "default" : "secondary"}
                className={cn(
                  "font-semibold capitalize",
                  row.status === "enrolled" &&
                    "border-emerald-600/30 bg-emerald-600/15 text-emerald-800",
                )}
              >
                {row.status}
              </Badge>
            </div>
            <p className="text-ink-muted text-body-sm mt-2.5 font-medium capitalize">
              {row.role} ·{" "}
              <span className="text-navy font-semibold tabular-nums">
                {row.points} pts
              </span>
            </p>
            {row.note && (
              <p className="text-ink-muted/80 text-body-sm mt-1 italic">
                {row.note}
              </p>
            )}
            <div className="border-hairline mt-4 grid gap-3 border-t pt-3">
              {picker(row)}
              {actions(row)}
            </div>
          </li>
        ))}
      </ul>

      <div className="hidden md:block">
        <div className="border-hairline bg-paper/50 overflow-hidden rounded-xl border shadow-xs">
          <Table label="SASE KIN">
            <TableHeader className="bg-cream/40 border-hairline border-b">
              <TableRow>
                <TableHead className="text-ink-muted font-semibold">
                  Member
                </TableHead>
                <TableHead className="text-ink-muted font-semibold">
                  Role
                </TableHead>
                <TableHead className="text-ink-muted font-semibold">
                  Status
                </TableHead>
                <TableHead className="text-ink-muted font-semibold">
                  Group
                </TableHead>
                <TableHead className="text-ink-muted font-semibold">
                  Points
                </TableHead>
                <TableHead className="text-ink-muted text-right font-semibold">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.userId}
                  className="hover:bg-cream/30 transition-colors"
                >
                  <TableCell className="py-4 whitespace-normal">
                    <p className="text-navy font-semibold">
                      {row.name ?? row.email}
                    </p>
                    <p className="text-ink-muted text-body-sm mt-0.5">
                      {row.email}
                    </p>
                    {row.note && (
                      <p className="text-ink-muted/80 text-body-sm mt-1 italic">
                        {row.note}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="text-navy font-medium capitalize">
                    {row.role}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        row.status === "enrolled" ? "default" : "secondary"
                      }
                      className={cn(
                        "font-semibold capitalize",
                        row.status === "enrolled" &&
                          "border-emerald-600/30 bg-emerald-600/15 text-emerald-800",
                      )}
                    >
                      {row.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{picker(row)}</TableCell>
                  <TableCell className="text-navy font-bold tabular-nums">
                    {row.points}
                  </TableCell>
                  <TableCell>{actions(row)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </>
  );
}
