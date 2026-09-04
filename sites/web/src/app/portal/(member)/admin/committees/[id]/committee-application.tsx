"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Action } from "~/app/portal/_components/controls";
import { formatDate } from "~/app/portal/_lib/format";
import { Badge } from "~/components/ui/badge";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import { interviewScript } from "~/data/committee-interviews";
import {
  committeeExpectations,
  committees,
  selectedCommitteeIds,
} from "~/data/committees";
import { api, type RouterOutputs } from "~/trpc/react";

type Row = RouterOutputs["committee"]["byId"];

const statuses = [
  "submitted",
  "interviewing",
  "accepted",
  "declined",
  "withdrawn",
] as const;

const statusLabel: Record<Row["status"], string> = {
  submitted: "Submitted",
  interviewing: "Interviewing",
  accepted: "Accepted",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

function Answer({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-eyebrow tracking-caps text-ink-muted font-semibold uppercase">
        {label}
      </p>
      <p className="text-ink text-body mt-2 whitespace-pre-wrap">{value}</p>
    </div>
  );
}

export function CommitteeApplication({
  applicationId,
}: {
  applicationId: string;
}) {
  const utils = api.useUtils();
  const query = api.committee.byId.useQuery({ id: applicationId });
  const setStatus = api.committee.setStatus.useMutation({
    onSuccess: async () => {
      toast.success("Status updated.");
      await Promise.all([
        utils.committee.byId.invalidate({ id: applicationId }),
        utils.committee.list.invalidate(),
      ]);
    },
    onError: (error) => toast.error(error.message),
  });
  const setNotes = api.committee.setNotes.useMutation({
    onSuccess: async () => {
      toast.success("Notes saved.");
      await utils.committee.byId.invalidate({ id: applicationId });
    },
    onError: (error) => toast.error(error.message),
  });

  if (query.isPending) {
    return (
      <div className="grid gap-3">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (query.error) {
    return <p className="text-destructive">{query.error.message}</p>;
  }

  const row = query.data;
  return (
    <ApplicationBody
      row={row}
      notesPending={setNotes.isPending}
      statusPending={setStatus.isPending}
      onStatus={(status) => setStatus.mutate({ id: row.id, status })}
      onNotes={(officerNotes) => setNotes.mutate({ id: row.id, officerNotes })}
    />
  );
}

function ApplicationBody({
  row,
  notesPending,
  statusPending,
  onStatus,
  onNotes,
}: {
  row: Row;
  notesPending: boolean;
  statusPending: boolean;
  onStatus: (status: Row["status"]) => void;
  onNotes: (officerNotes: string) => void;
}) {
  const [notes, setNotes] = useState(row.officerNotes ?? "");
  const picked = selectedCommitteeIds(row);
  const script = interviewScript(picked);

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
      <div>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-navy text-h2 font-bold tracking-tight">
              {row.name ?? row.email}
            </h1>
            <p className="text-ink-muted text-body-sm mt-2">
              {row.email}
              <span aria-hidden="true"> · </span>
              {row.discordHandle}
            </p>
            <p className="text-ink-muted text-body-sm mt-1">
              Submitted {formatDate(row.submittedAt)}
            </p>
          </div>
          <Badge
            variant={
              row.status === "accepted"
                ? "default"
                : row.status === "declined"
                  ? "destructive"
                  : "secondary"
            }
            className="font-semibold"
          >
            {statusLabel[row.status]}
          </Badge>
        </div>

        <p className="text-navy mt-6 font-semibold">
          {picked
            .map(
              (id) =>
                committees.find((committee) => committee.id === id)?.title ??
                id,
            )
            .join(" · ")}
        </p>

        <div className="mt-10 grid gap-8">
          <Answer
            label="Why Events, and what would you run?"
            value={row.eventsWhy}
          />
          <Answer label="Clubs to collaborate with" value={row.eventsCollabs} />
          <Answer label="Why Marketing?" value={row.marketingWhy} />
          <Answer
            label="Where they can advertise SASE"
            value={row.marketingConnections}
          />
          <Answer label="Why Treasury?" value={row.treasuryWhy} />
          <Answer label="Other orgs this year" value={row.otherOrgs} />
          <Answer label="Anything else" value={row.comments} />
        </div>
      </div>

      <aside className="grid gap-8">
        <div>
          <p className="text-eyebrow tracking-caps text-ink-muted font-semibold uppercase">
            Status
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {statuses.map((status) => (
              <Action
                key={status}
                tone={status === row.status ? "solid" : "quiet"}
                disabled={statusPending || status === row.status}
                onClick={() => onStatus(status)}
              >
                {statusLabel[status]}
              </Action>
            ))}
          </div>
        </div>

        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onNotes(notes);
          }}
        >
          <Label htmlFor="officer-notes">Interview notes</Label>
          <Textarea
            id="officer-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={4000}
            rows={8}
            className="border-hairline text-base"
          />
          <Action type="submit" tone="primary" disabled={notesPending}>
            {notesPending ? "Saving..." : "Save notes"}
          </Action>
        </form>

        <div>
          <p className="text-eyebrow tracking-caps text-ink-muted font-semibold uppercase">
            Shared expectations
          </p>
          <ul className="text-ink-muted text-body-sm mt-3 grid gap-2">
            {committeeExpectations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        {script.map((block) => (
          <div key={block.id}>
            <p className="text-eyebrow tracking-caps text-ink-muted font-semibold uppercase">
              {block.title} interview
            </p>
            <p className="text-ink-muted text-body-sm mt-3 font-semibold">
              Role
            </p>
            <ul className="text-ink-muted text-body-sm mt-2 grid gap-1">
              {block.responsibilities.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className="text-ink-muted text-body-sm mt-4 font-semibold">
              Questions
            </p>
            <ol className="text-ink text-body-sm mt-2 grid list-decimal gap-2 pl-5">
              {block.questions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ol>
          </div>
        ))}
      </aside>
    </div>
  );
}
