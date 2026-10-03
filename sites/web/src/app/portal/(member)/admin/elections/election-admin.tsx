"use client";

import { useState } from "react";
import { toast } from "sonner";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import { api, type RouterOutputs } from "~/trpc/react";

type Election = RouterOutputs["election"]["list"][number];

const text = (value: FormDataEntryValue | null) =>
  typeof value === "string" ? value : "";
type Phase = Election["phase"];

const phaseLabel: Record<Phase, string> = {
  nominating: "Nominations open",
  voting: "Voting open",
  closed: "Voting closed",
  published: "Results published",
};

const advance: Partial<
  Record<Phase, { to: Phase; label: string; body: string }>
> = {
  nominating: {
    to: "voting",
    label: "Open voting",
    body: "Only approved candidates go on the ballot, and the ballot is locked once voting opens.",
  },
  voting: {
    to: "closed",
    label: "Close voting",
    body: "No more ballots are accepted. You will see the counts; members will not until you publish.",
  },
  closed: {
    to: "published",
    label: "Publish results",
    body: "Every member will see the counts for each position.",
  },
};

function useRefresh() {
  const utils = api.useUtils();
  return () =>
    Promise.all([
      utils.election.list.invalidate(),
      utils.election.years.invalidate(),
    ]);
}

function CreateElection() {
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const create = api.election.create.useMutation({
    onSuccess: async () => {
      toast.success("Election created. Nominations are open.");
      setOpen(false);
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-navy hover:bg-navy-deep min-h-11 text-white">
          New election
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New election</DialogTitle>
          <DialogDescription>
            Nominations open as soon as you create it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const title = text(data.get("title")).trim();
            const positions = text(data.get("positions"))
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean);
            create.mutate({ title, positions });
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="election-title">Title</Label>
            <Input
              id="election-title"
              name="title"
              required
              maxLength={120}
              defaultValue="Executive board election"
              className="text-base"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="election-positions">Positions, one per line</Label>
            <Textarea
              id="election-positions"
              name="positions"
              required
              rows={6}
              placeholder={"President\nVice President\nTreasurer\nSecretary"}
              className="text-base"
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline" className="min-h-11">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={create.isPending}
              className="min-h-11"
            >
              {create.isPending ? "Creating..." : "Create election"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Confirm({
  trigger,
  title,
  body,
  action,
  onConfirm,
  disabled,
  danger,
}: {
  trigger: string;
  title: string;
  body: string;
  action: string;
  onConfirm: () => void;
  disabled: boolean;
  danger?: boolean;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          variant={danger ? "ghost" : "outline"}
          className={danger ? "text-destructive min-h-11" : "min-h-11"}
          disabled={disabled}
        >
          {trigger}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={
              danger
                ? "bg-destructive hover:bg-destructive/90 text-white"
                : undefined
            }
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ElectionPanel({
  election,
  readOnly,
}: {
  election: Election;
  readOnly: boolean;
}) {
  const refresh = useRefresh();
  const onError = (error: { message: string }) => toast.error(error.message);
  const setPhase = api.election.setPhase.useMutation({
    onSuccess: async () => {
      toast.success("Election updated.");
      await refresh();
    },
    onError,
  });
  const review = api.election.setCandidateStatus.useMutation({
    onSuccess: refresh,
    onError,
  });
  const remove = api.election.delete.useMutation({
    onSuccess: async () => {
      toast.success("Election deleted.");
      await refresh();
    },
    onError,
  });

  const busy = setPhase.isPending || review.isPending || remove.isPending;
  const next = advance[election.phase];
  const showCounts =
    election.phase === "closed" || election.phase === "published";

  return (
    <li className="border-hairline bg-paper/80 rounded-xl border p-5 shadow-xs sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-navy text-lg font-bold">
            {election.title}
          </h2>
          <p className="text-ink-muted text-body-sm">{election.year}</p>
        </div>
        <Badge variant="secondary">{phaseLabel[election.phase]}</Badge>
      </div>

      <div className="mt-5 grid gap-6">
        {election.positions.map((position) => {
          const top = Math.max(
            0,
            ...position.candidates.map((candidate) => candidate.votes ?? 0),
          );
          return (
            <div key={position.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-navy font-semibold">{position.title}</h3>
                {election.phase !== "nominating" && (
                  <p className="text-ink-muted text-body-sm tabular-nums">
                    {position.voters}{" "}
                    {position.voters === 1 ? "ballot" : "ballots"}
                  </p>
                )}
              </div>
              {position.candidates.length === 0 ? (
                <p className="text-ink-muted text-body-sm mt-2">
                  No nominations yet.
                </p>
              ) : (
                <ul className="border-hairline divide-hairline mt-2 divide-y rounded-lg border">
                  {position.candidates.map((candidate) => (
                    <li key={candidate.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-navy font-semibold">
                            {candidate.name ?? candidate.email}
                            {showCounts &&
                              top > 0 &&
                              candidate.votes === top && (
                                <Badge className="bg-gold-bright text-navy ml-2 border-transparent">
                                  Leading
                                </Badge>
                              )}
                          </p>
                          <p className="text-ink-muted text-body-sm break-all">
                            {candidate.email}
                          </p>
                        </div>
                        {showCounts ? (
                          <span className="text-navy font-bold tabular-nums">
                            {candidate.votes} votes
                          </span>
                        ) : (
                          <Badge variant="secondary" className="capitalize">
                            {candidate.status}
                          </Badge>
                        )}
                      </div>
                      <p className="text-ink-muted text-body-sm mt-2 italic">
                        {candidate.statement}
                      </p>
                      {!readOnly && election.phase === "nominating" && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {candidate.status !== "approved" && (
                            <Button
                              size="sm"
                              className="min-h-11"
                              disabled={busy}
                              onClick={() =>
                                review.mutate({
                                  candidateId: candidate.id,
                                  status: "approved",
                                })
                              }
                            >
                              Approve
                            </Button>
                          )}
                          {candidate.status !== "rejected" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="min-h-11"
                              disabled={busy}
                              onClick={() =>
                                review.mutate({
                                  candidateId: candidate.id,
                                  status: "rejected",
                                })
                              }
                            >
                              Reject
                            </Button>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {!readOnly && (next ?? election.phase === "voting") && (
        <div className="border-hairline mt-5 flex flex-wrap gap-2 border-t pt-4">
          {next && (
            <Confirm
              trigger={next.label}
              title={`${next.label}?`}
              body={next.body}
              action={next.label}
              disabled={busy}
              onConfirm={() =>
                setPhase.mutate({ electionId: election.id, phase: next.to })
              }
            />
          )}
          {election.phase === "voting" && (
            <Confirm
              trigger="Back to nominations"
              title="Reopen nominations?"
              body="Only possible while nobody has voted. The ballot unlocks for edits."
              action="Reopen nominations"
              disabled={busy}
              onConfirm={() =>
                setPhase.mutate({
                  electionId: election.id,
                  phase: "nominating",
                })
              }
            />
          )}
          {election.phase === "nominating" && (
            <Confirm
              danger
              trigger="Delete"
              title={`Delete ${election.title}?`}
              body="Positions and nominations are removed. This cannot be undone."
              action="Delete election"
              disabled={busy}
              onConfirm={() => remove.mutate({ electionId: election.id })}
            />
          )}
        </div>
      )}
    </li>
  );
}

export function ElectionAdmin({ currentYear }: { currentYear: string }) {
  const [year, setYear] = useState(currentYear);
  const years = api.election.years.useQuery();
  const list = api.election.list.useQuery({ year });
  const readOnly = year !== currentYear;

  return (
    <>
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Label htmlFor="election-year">School year</Label>
          <Select value={year} onValueChange={setYear}>
            <SelectTrigger id="election-year" className="h-auto min-h-11 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(years.data ?? [currentYear]).map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {readOnly && (
            <p className="text-ink-muted text-body-sm">
              Past year — read only.
            </p>
          )}
        </div>
        {!readOnly && <CreateElection />}
      </div>

      {list.isPending ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : list.error ? (
        <p className="text-destructive">{list.error.message}</p>
      ) : list.data.length === 0 ? (
        <p className="text-ink-muted text-body">
          {readOnly
            ? `No elections in ${year}.`
            : "No election this school year yet. Create one to open nominations."}
        </p>
      ) : (
        <ul className="grid gap-5">
          {list.data.map((election) => (
            <ElectionPanel
              key={election.id}
              election={election}
              readOnly={readOnly}
            />
          ))}
        </ul>
      )}
    </>
  );
}
