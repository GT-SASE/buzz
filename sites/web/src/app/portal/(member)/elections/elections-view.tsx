"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import { api, type RouterOutputs } from "~/trpc/react";

type Current = RouterOutputs["election"]["current"];
type Election = Current["elections"][number];
type Position = Election["positions"][number];

const phaseLabel = {
  nominating: "Taking nominations",
  voting: "Voting open",
  closed: "Counting votes",
  published: "Results",
} as const;

const candidacyLabel = {
  pending: "Waiting for officer review",
  approved: "On the ballot",
  rejected: "Not approved",
} as const;

function useRefresh() {
  const utils = api.useUtils();
  return () => utils.election.current.invalidate();
}

function RunForPosition({ position }: { position: Position }) {
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState("");
  const nominate = api.election.nominate.useMutation({
    onSuccess: async () => {
      toast.success("Nomination sent to the officers.");
      setOpen(false);
      setStatement("");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const withdraw = api.election.withdrawNomination.useMutation({
    onSuccess: async () => {
      toast.success("Nomination withdrawn.");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  if (position.mine) {
    return (
      <div className="mt-3">
        <Badge variant="secondary">
          {candidacyLabel[position.mine.status]}
        </Badge>
        <p className="text-ink-muted text-body-sm mt-2 italic">
          {position.mine.statement}
        </p>
        <Button
          type="button"
          variant="ghost"
          disabled={withdraw.isPending}
          onClick={() => withdraw.mutate({ candidateId: position.mine!.id })}
          className="text-ink-muted mt-1 h-11 px-0"
        >
          Withdraw my nomination
        </Button>
      </div>
    );
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
        className="mt-3 min-h-11"
      >
        Run for {position.title}
      </Button>
    );
  }

  const fieldId = `statement-${position.id}`;
  return (
    <form
      className="mt-3 grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        nominate.mutate({ positionId: position.id, statement });
      }}
    >
      <Label htmlFor={fieldId}>Why you, in a few sentences</Label>
      <Textarea
        id={fieldId}
        required
        maxLength={1000}
        rows={4}
        value={statement}
        onChange={(event) => setStatement(event.target.value)}
        className="text-base"
      />
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={nominate.isPending}
          className="bg-navy hover:bg-navy-deep min-h-11 text-white"
        >
          {nominate.isPending ? "Sending..." : "Submit nomination"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setOpen(false)}
          className="min-h-11"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Ballot({
  position,
  eligible,
}: {
  position: Position;
  eligible: boolean;
}) {
  const refresh = useRefresh();
  const [choice, setChoice] = useState<string | null>(null);
  const vote = api.election.vote.useMutation({
    onSuccess: async () => {
      toast.success("Vote recorded.");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  if (position.candidates.length === 0) {
    return (
      <p className="text-ink-muted text-body-sm mt-3">
        Nobody is on the ballot for this position.
      </p>
    );
  }

  const voted = position.myVote;
  return (
    <form
      className="mt-3 grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (choice)
          vote.mutate({ positionId: position.id, candidateId: choice });
      }}
    >
      <fieldset className="grid gap-3" disabled={!!voted || !eligible}>
        <legend className="sr-only">Vote for {position.title}</legend>
        {position.candidates.map((candidate) => (
          <label
            key={candidate.id}
            className="border-hairline has-[:checked]:border-navy has-[:checked]:bg-cream flex cursor-pointer gap-3 rounded-lg border p-4 has-[:disabled]:cursor-default"
          >
            <input
              type="radio"
              name={`vote-${position.id}`}
              value={candidate.id}
              checked={(voted ?? choice) === candidate.id}
              onChange={() => setChoice(candidate.id)}
              className="accent-navy mt-1 size-4"
            />
            <span>
              <span className="text-navy block font-semibold">
                {candidate.name}
              </span>
              <span className="text-ink-muted text-body-sm mt-1 block">
                {candidate.statement}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {voted ? (
        <p className="text-ink-muted text-body-sm">
          You voted. Ballots are final and secret.
        </p>
      ) : (
        eligible && (
          <Button
            type="submit"
            disabled={!choice || vote.isPending}
            className="bg-navy hover:bg-navy-deep min-h-11 w-full text-white sm:w-auto"
          >
            {vote.isPending ? "Voting..." : `Cast vote for ${position.title}`}
          </Button>
        )
      )}
    </form>
  );
}

function Results({ position }: { position: Position }) {
  const sorted = [...position.candidates].sort(
    (a, b) => (b.votes ?? 0) - (a.votes ?? 0),
  );
  const top = sorted[0]?.votes ?? 0;
  const leaders = sorted.filter((candidate) => (candidate.votes ?? 0) === top);
  const tie = top > 0 && leaders.length > 1;

  return (
    <ol className="border-hairline divide-hairline mt-3 divide-y rounded-xl border">
      {sorted.map((candidate) => {
        const won = top > 0 && (candidate.votes ?? 0) === top;
        return (
          <li
            key={candidate.id}
            className="flex items-center justify-between gap-3 px-4 py-3"
          >
            <span className="text-navy min-w-0 font-semibold">
              {candidate.name}
              {won && (
                <Badge className="bg-gold-bright text-navy ml-2 border-transparent">
                  {tie ? "Tied" : "Elected"}
                </Badge>
              )}
            </span>
            <span className="text-navy shrink-0 font-bold tabular-nums">
              {candidate.votes ?? 0}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ElectionCard({
  election,
  eligible,
}: {
  election: Election;
  eligible: boolean;
}) {
  return (
    <section className="border-hairline bg-paper/80 mt-8 rounded-xl border p-5 shadow-xs sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="font-display text-navy text-h3 font-bold tracking-tight">
          {election.title}
        </h2>
        <Badge variant="secondary">{phaseLabel[election.phase]}</Badge>
      </div>

      {election.phase === "voting" && !eligible && (
        <p className="text-ink-muted text-body-sm mt-3">
          Voting needs at least one event check-in this school year. Check in at
          a GBM or event, then come back.
        </p>
      )}
      {election.phase === "closed" && (
        <p className="text-ink-muted text-body-sm mt-3">
          Voting is closed. Officers are counting, and results will show here
          once published.
        </p>
      )}

      <div className="mt-4 grid gap-6">
        {election.positions.map((position) => (
          <div key={position.id}>
            <h3 className="text-navy font-semibold">{position.title}</h3>
            {election.phase === "nominating" && (
              <>
                {position.candidates.length > 0 && (
                  <p className="text-ink-muted text-body-sm mt-1">
                    Running: {position.candidates.map((c) => c.name).join(", ")}
                  </p>
                )}
                <RunForPosition position={position} />
              </>
            )}
            {election.phase === "voting" && (
              <Ballot position={position} eligible={eligible} />
            )}
            {election.phase === "published" && <Results position={position} />}
          </div>
        ))}
      </div>
    </section>
  );
}

export function ElectionsView() {
  const current = api.election.current.useQuery();

  if (current.isPending) {
    return (
      <div className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-6 sm:py-14">
        <Skeleton className="h-10 w-64 rounded-lg" />
        <Skeleton className="mt-8 h-48 w-full rounded-xl" />
      </div>
    );
  }
  if (current.error) {
    return (
      <p className="text-destructive mx-auto max-w-2xl px-5 py-10">
        {current.error.message}
      </p>
    );
  }

  const { year, eligible, elections } = current.data;
  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-6 sm:py-14">
      <p className="text-eyebrow tracking-caps text-gold-ink font-semibold uppercase">
        Elections · {year}
      </p>
      <h1 className="font-display text-navy text-h2 mt-3 font-bold tracking-tight">
        Elect next year&apos;s board.
      </h1>
      <p className="text-ink-muted text-body mt-4">
        Run for a position with a short statement; officers approve the ballot.
        Anyone with an event check-in this school year can vote, once per
        position.{" "}
        {eligible
          ? "You are eligible to vote."
          : "You have no check-in this school year yet, so you cannot vote."}
      </p>

      {elections.length === 0 ? (
        <p className="text-ink-muted text-body mt-10">
          No election is running this school year yet.
        </p>
      ) : (
        elections.map((election) => (
          <ElectionCard
            key={election.id}
            election={election}
            eligible={eligible}
          />
        ))
      )}
    </div>
  );
}
