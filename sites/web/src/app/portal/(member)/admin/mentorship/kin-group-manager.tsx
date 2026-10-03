"use client";

import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "~/app/portal/_components/confirm-dialog";
import { seatsLabel } from "~/app/portal/(member)/mentorship/kin-groups";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import { semesterLabel } from "@buzz/api/terms";
import { api, type RouterOutputs } from "~/trpc/react";

type Group = RouterOutputs["mentorship"]["groups"][number];

const text = (value: FormDataEntryValue | null) =>
  typeof value === "string" ? value.trim() : "";

function useRefresh() {
  const utils = api.useUtils();
  return () =>
    Promise.all([
      utils.mentorship.groups.invalidate(),
      utils.mentorship.list.invalidate(),
    ]);
}

function GroupForm({ group, onDone }: { group?: Group; onDone: () => void }) {
  const refresh = useRefresh();
  const create = api.mentorship.createGroup.useMutation({
    onSuccess: async () => {
      toast.success("Group created.");
      await refresh();
      onDone();
    },
    onError: (error) => toast.error(error.message),
  });
  const update = api.mentorship.updateGroup.useMutation({
    onSuccess: async () => {
      toast.success("Changes saved.");
      await refresh();
      onDone();
    },
    onError: (error) => toast.error(error.message),
  });
  const pending = create.isPending || update.isPending;

  return (
    <form
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const capacity = text(data.get("capacity"));
        const values = {
          name: text(data.get("name")),
          description: text(data.get("description")) || undefined,
          capacity: capacity ? Number(capacity) : null,
          isOpen: data.get("isOpen") === "on",
        };
        if (group) update.mutate({ ...values, id: group.id });
        else create.mutate(values);
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="kin-name">Group name</Label>
        <Input
          id="kin-name"
          name="name"
          required
          maxLength={80}
          defaultValue={group?.name ?? ""}
          className="text-base"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="kin-description">Description</Label>
        <Textarea
          id="kin-description"
          name="description"
          rows={3}
          maxLength={600}
          defaultValue={group?.description ?? ""}
          placeholder="Who it's for, when it meets"
          className="text-base"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="kin-capacity">Seats (blank for no limit)</Label>
        <Input
          id="kin-capacity"
          name="capacity"
          type="number"
          min={1}
          max={100}
          defaultValue={group?.capacity ?? ""}
          className="text-base tabular-nums"
        />
      </div>
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          name="isOpen"
          defaultChecked={group?.isOpen ?? true}
          className="accent-navy size-4"
        />
        <span className="text-body-sm">
          Open — members can join on their own
        </span>
      </label>
      <DialogFooter className="mt-2 gap-2 sm:gap-2">
        <DialogClose asChild>
          <Button type="button" variant="outline" className="min-h-11">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending} className="min-h-11">
          {pending ? "Saving..." : group ? "Save changes" : "Create group"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function GroupDialog({ group }: { group?: Group }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {group ? (
          <Button size="sm" variant="ghost" className="min-h-11">
            Edit
          </Button>
        ) : (
          <Button className="bg-navy hover:bg-navy-deep min-h-11 text-white">
            New kin group
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {group ? `Edit ${group.name}` : "New group"}
          </DialogTitle>
          <DialogDescription>
            Members see the name, description, seats, and mentor names.
          </DialogDescription>
        </DialogHeader>
        <GroupForm group={group} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function DeleteGroup({ group }: { group: Group }) {
  const refresh = useRefresh();
  const remove = api.mentorship.deleteGroup.useMutation({
    onSuccess: async () => {
      toast.success("Group deleted.");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive min-h-11"
          disabled={remove.isPending}
        >
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {group.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {group.memberCount > 0
              ? `${group.memberCount} ${group.memberCount === 1 ? "member goes" : "members go"} back to signed up. Their KIN points stay.`
              : "Nobody is in this group."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => remove.mutate({ id: group.id })}
            className="bg-destructive hover:bg-destructive/90 text-white"
          >
            Delete group
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function KinGroupManager({
  semester,
  readOnly,
}: {
  semester: string;
  readOnly: boolean;
}) {
  const refresh = useRefresh();
  const groups = api.mentorship.groups.useQuery({ semester });
  const award = api.mentorship.awardGroupPoints.useMutation({
    onSuccess: async ({ awarded }) => {
      toast.success(
        `+5 to ${awarded} ${awarded === 1 ? "member" : "members"}.`,
      );
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  if (groups.isPending) {
    return <Skeleton className="h-24 w-full rounded-xl" />;
  }
  if (groups.error) {
    return <p className="text-destructive">{groups.error.message}</p>;
  }

  const all = groups.data ?? [];

  return (
    <section aria-labelledby="kin-groups-admin">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id="kin-groups-admin"
          className="font-display text-navy text-h3 font-bold tracking-tight"
        >
          Groups
        </h2>
        {!readOnly && <GroupDialog />}
      </div>

      {all.length === 0 ? (
        <p className="text-ink-muted text-body mt-4">
          {readOnly
            ? `No groups in ${semesterLabel(semester)}.`
            : "No groups yet this semester. Create one and members can join it from SASE KIN."}
        </p>
      ) : (
        <ul className="mt-5 grid gap-4 md:grid-cols-2">
          {all.map((group) => (
            <li
              key={group.id}
              className="border-hairline bg-paper/80 rounded-xl border p-5 shadow-xs"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="font-display text-navy text-lg font-bold">
                  {group.name}
                </p>
                <Badge variant="secondary" className="shrink-0">
                  {group.isOpen ? "Open" : "Invite-only"}
                </Badge>
              </div>
              {group.description && (
                <p className="text-ink-muted text-body-sm mt-2">
                  {group.description}
                </p>
              )}
              <p className="text-ink-muted text-body-sm mt-3">
                {seatsLabel(group)} ·{" "}
                <span className="text-navy font-semibold tabular-nums">
                  {group.points} pts
                </span>
              </p>
              {group.mentors.length > 0 && (
                <p className="text-ink-muted text-body-sm mt-1">
                  Mentors: {group.mentors.join(", ")}
                </p>
              )}
              {!readOnly && (
                <div className="border-hairline mt-4 flex flex-wrap gap-2 border-t pt-3">
                  <ConfirmDialog
                    title={`Give everyone in ${group.name} 5 KIN points?`}
                    body={`Adds 5 points to each of the ${group.memberCount} members. There is no undo.`}
                    action="Award points"
                    onConfirm={() =>
                      award.mutate({ groupId: group.id, points: 5 })
                    }
                  >
                    <Button
                      size="sm"
                      variant="outline"
                      className="min-h-11"
                      disabled={award.isPending || group.memberCount === 0}
                    >
                      +5 whole group
                    </Button>
                  </ConfirmDialog>
                  <GroupDialog group={group} />
                  <DeleteGroup group={group} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
