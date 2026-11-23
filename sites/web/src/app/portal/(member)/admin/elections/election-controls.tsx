"use client";

import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "~/app/portal/_components/confirm-dialog";
import { Action } from "~/app/portal/_components/controls";
import { downloadCsv, toCsv } from "~/app/portal/_lib/csv";
import {
  formatDeadline,
  fromLocalInputValue,
  toLocalInputValue,
} from "~/app/portal/_lib/format";
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
import { api, type RouterOutputs } from "~/trpc/react";

type Election = RouterOutputs["election"]["list"][number];

const text = (value: FormDataEntryValue | null) =>
  typeof value === "string" ? value : "";

function useRefresh() {
  const utils = api.useUtils();
  return () =>
    Promise.all([
      utils.election.list.invalidate(),
      utils.election.years.invalidate(),
    ]);
}

/** The schedule inputs: Atlanta wall-clock times, blank for "flip by hand". */
export function ScheduleFields({
  idPrefix,
  defaults,
  only,
}: {
  idPrefix: string;
  defaults?: {
    opensAt: Date | null;
    closesAt: Date | null;
    minCheckIns: number;
  };
  /** While voting, only the closing time can change. */
  only?: "closesAt";
}) {
  return (
    <>
      {only !== "closesAt" && (
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-opens`}>
            Voting opens (Atlanta time, optional)
          </Label>
          <Input
            id={`${idPrefix}-opens`}
            name="opensAt"
            type="datetime-local"
            defaultValue={
              defaults?.opensAt ? toLocalInputValue(defaults.opensAt) : ""
            }
            className="text-base"
          />
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-closes`}>
          Voting closes (Atlanta time, optional)
        </Label>
        <Input
          id={`${idPrefix}-closes`}
          name="closesAt"
          type="datetime-local"
          defaultValue={
            defaults?.closesAt ? toLocalInputValue(defaults.closesAt) : ""
          }
          className="text-base"
        />
        <p className="text-ink-muted text-body-sm">
          Left blank, you open and close voting by hand. Set, the phase flips
          the first time anyone opens elections or votes after that moment, and
          a daily run catches the rest. Members are emailed like a manual flip.
          Ballots stop at the closing time itself.
        </p>
      </div>
      {only !== "closesAt" && (
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-min`}>
            Check-ins needed to vote this school year
          </Label>
          <Input
            id={`${idPrefix}-min`}
            name="minCheckIns"
            type="number"
            min={1}
            max={50}
            required
            defaultValue={defaults?.minCheckIns ?? 1}
            className="text-base"
          />
          <p className="text-ink-muted text-body-sm">
            The voter list is frozen from this rule the moment voting opens.
          </p>
        </div>
      )}
    </>
  );
}

export function readSchedule(data: FormData) {
  const when = (name: string) => {
    const value = text(data.get(name));
    return value ? fromLocalInputValue(value) : null;
  };
  const min = Number(text(data.get("minCheckIns")));
  return {
    opensAt: when("opensAt"),
    closesAt: when("closesAt"),
    ...(Number.isInteger(min) && min > 0 ? { minCheckIns: min } : {}),
  };
}

export function ScheduleDialog({
  election,
  disabled,
}: {
  election: Election;
  disabled: boolean;
}) {
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const configure = api.election.configure.useMutation({
    onSuccess: async () => {
      toast.success("Schedule saved.");
      setOpen(false);
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const voting = election.phase === "voting";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Action tone="quiet" disabled={disabled}>
          {voting ? "Change closing time" : "Schedule and eligibility"}
        </Action>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {voting ? "Closing time" : "Schedule and eligibility"}
          </DialogTitle>
          <DialogDescription>
            {voting
              ? "The voter list is frozen. Only the closing time can change."
              : "Set when voting opens and closes, and how many check-ins a member needs."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            const data = readSchedule(new FormData(event.currentTarget));
            configure.mutate({
              electionId: election.id,
              closesAt: data.closesAt,
              ...(voting
                ? {}
                : { opensAt: data.opensAt, minCheckIns: data.minCheckIns }),
            });
          }}
        >
          <ScheduleFields
            idPrefix={`schedule-${election.id}`}
            defaults={election}
            only={voting ? "closesAt" : undefined}
          />
          <DialogFooter className="gap-2 sm:gap-2">
            <DialogClose asChild>
              <Action tone="quiet" type="button">
                Cancel
              </Action>
            </DialogClose>
            <Action tone="primary" type="submit" disabled={configure.isPending}>
              {configure.isPending ? "Saving..." : "Save schedule"}
            </Action>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PositionRow({
  position,
  last,
}: {
  position: Election["positions"][number];
  last: boolean;
}) {
  const refresh = useRefresh();
  const onError = (error: { message: string }) => toast.error(error.message);
  const [title, setTitle] = useState(position.title);
  const rename = api.election.renamePosition.useMutation({
    onSuccess: async () => {
      toast.success("Position renamed.");
      await refresh();
    },
    onError,
  });
  const remove = api.election.removePosition.useMutation({
    onSuccess: async () => {
      toast.success("Position removed.");
      await refresh();
    },
    onError,
  });
  const busy = rename.isPending || remove.isPending;

  return (
    <li className="flex flex-wrap items-center gap-2">
      <Input
        aria-label={`Name of ${position.title}`}
        value={title}
        maxLength={80}
        onChange={(event) => setTitle(event.target.value)}
        className="min-w-0 flex-1 text-base"
      />
      <Action
        tone="quiet"
        disabled={busy || !title.trim() || title.trim() === position.title}
        onClick={() =>
          rename.mutate({ positionId: position.id, title: title.trim() })
        }
      >
        Rename
      </Action>
      <ConfirmDialog
        title={`Remove ${position.title}?`}
        body={
          position.candidates.length > 0
            ? "Its nominations are removed with it. This cannot be undone."
            : "This cannot be undone."
        }
        action="Remove position"
        danger
        onConfirm={() => remove.mutate({ positionId: position.id })}
      >
        <Action tone="danger" disabled={busy || last}>
          Remove
        </Action>
      </ConfirmDialog>
    </li>
  );
}

export function PositionsDialog({
  election,
  disabled,
}: {
  election: Election;
  disabled: boolean;
}) {
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const add = api.election.addPosition.useMutation({
    onSuccess: async () => {
      toast.success("Position added.");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Action tone="quiet" disabled={disabled}>
          Edit positions
        </Action>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Positions</DialogTitle>
          <DialogDescription>
            Positions can change until voting opens, then they are locked.
          </DialogDescription>
        </DialogHeader>
        <ul className="grid gap-3">
          {election.positions.map((position) => (
            <PositionRow
              key={`${position.id}-${position.title}`}
              position={position}
              last={election.positions.length <= 1}
            />
          ))}
        </ul>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const title = text(new FormData(form).get("title")).trim();
            if (!title) return;
            add.mutate(
              { electionId: election.id, title },
              { onSuccess: () => form.reset() },
            );
          }}
        >
          <div className="grid min-w-0 flex-1 gap-2">
            <Label htmlFor={`add-position-${election.id}`}>New position</Label>
            <Input
              id={`add-position-${election.id}`}
              name="title"
              maxLength={80}
              className="text-base"
            />
          </div>
          <Action tone="solid" type="submit" disabled={add.isPending}>
            Add
          </Action>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Action tone="quiet" type="button">
              Done
            </Action>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ExportTally({ election }: { election: Election }) {
  const utils = api.useUtils();
  const [busy, setBusy] = useState(false);
  return (
    <Action
      tone="quiet"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          // Every click is a fresh, logged export, never a cached one.
          const { rows, title, year } = await utils.election.exportTally.fetch(
            { electionId: election.id },
            { staleTime: 0 },
          );
          const slug = `${title}-${year}`
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
          downloadCsv(`election-tally-${slug}.csv`, toCsv(rows));
          toast.success("Tally exported.");
        } catch (error) {
          toast.error(
            error instanceof Error ? error.message : "Could not export.",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Exporting..." : "Export tally (CSV)"}
    </Action>
  );
}

export function Schedule({ election }: { election: Election }) {
  const { opensAt, closesAt, minCheckIns, rollSize } = election;
  return (
    <ul className="text-ink-muted text-body-sm mt-2 grid gap-0.5">
      <li>Voting opens: {opensAt ? formatDeadline(opensAt) : "by hand"}</li>
      <li>Voting closes: {closesAt ? formatDeadline(closesAt) : "by hand"}</li>
      <li>
        {rollSize === null
          ? `Voters: ${minCheckIns}+ check-in${minCheckIns === 1 ? "" : "s"} this school year, list frozen when voting opens`
          : `${rollSize} eligible voter${rollSize === 1 ? "" : "s"}, list frozen`}
      </li>
    </ul>
  );
}
