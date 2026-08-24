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
import { api } from "~/trpc/react";

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

  return (
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
              <p className="text-navy font-semibold">{row.name ?? row.email}</p>
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
                variant={row.status === "enrolled" ? "default" : "secondary"}
              >
                {row.status}
              </Badge>
            </TableCell>
            <TableCell className="tabular-nums">{row.points}</TableCell>
            <TableCell>
              <div className="flex flex-wrap justify-end gap-2">
                {row.status !== "enrolled" && (
                  <Button
                    size="sm"
                    disabled={setStatus.isPending}
                    onClick={() =>
                      setStatus.mutate({
                        userId: row.userId,
                        status: "enrolled",
                      })
                    }
                  >
                    Enroll
                  </Button>
                )}
                {row.status === "enrolled" && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={award.isPending}
                      onClick={() =>
                        award.mutate({ userId: row.userId, points: 5 })
                      }
                    >
                      +5 pts
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={setStatus.isPending}
                      onClick={() =>
                        setStatus.mutate({
                          userId: row.userId,
                          status: "withdrawn",
                        })
                      }
                    >
                      Remove
                    </Button>
                  </>
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
