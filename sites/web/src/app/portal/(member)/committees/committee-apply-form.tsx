"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import {
  committeeCycle,
  committeeExpectations,
  committees,
} from "~/data/committees";
import { formatDate } from "~/app/portal/_lib/format";
import { api, type RouterOutputs } from "~/trpc/react";

type Mine = RouterOutputs["committee"]["mine"];
type Application = NonNullable<Mine["application"]>;

const statusLabel: Record<Application["status"], string> = {
  submitted: "Submitted",
  interviewing: "Interviewing",
  accepted: "Accepted",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

export function CommitteeApplyForm() {
  const mine = api.committee.mine.useQuery();

  if (mine.isPending) {
    return (
      <div
        aria-busy="true"
        aria-live="polite"
        className="mx-auto w-full max-w-lg px-5 py-10 sm:px-6 sm:py-14"
      >
        <span className="sr-only">Loading committee application.</span>
        <Skeleton className="h-4 w-24 rounded-full" />
        <Skeleton className="mt-3 h-10 w-64 rounded-lg" />
        <Skeleton className="mt-4 h-16 w-full rounded-lg" />
        <Skeleton className="mt-8 h-28 w-full rounded-lg" />
      </div>
    );
  }

  if (mine.error) {
    return (
      <p className="text-destructive mx-auto max-w-lg px-5 py-10">
        {mine.error.message}
      </p>
    );
  }

  return <CommitteeApplyFields data={mine.data} />;
}

function CommitteeApplyFields({ data }: { data: Mine }) {
  const utils = api.useUtils();
  const row = data.application;
  const locked =
    row?.status === "interviewing" ||
    row?.status === "accepted" ||
    row?.status === "declined";

  const [discordHandle, setDiscordHandle] = useState(row?.discordHandle ?? "");
  const [wantsEvents, setWantsEvents] = useState(row?.wantsEvents ?? false);
  const [wantsMarketing, setWantsMarketing] = useState(
    row?.wantsMarketing ?? false,
  );
  const [wantsTreasury, setWantsTreasury] = useState(
    row?.wantsTreasury ?? false,
  );
  const [eventsWhy, setEventsWhy] = useState(row?.eventsWhy ?? "");
  const [eventsCollabs, setEventsCollabs] = useState(row?.eventsCollabs ?? "");
  const [marketingWhy, setMarketingWhy] = useState(row?.marketingWhy ?? "");
  const [marketingConnections, setMarketingConnections] = useState(
    row?.marketingConnections ?? "",
  );
  const [treasuryWhy, setTreasuryWhy] = useState(row?.treasuryWhy ?? "");
  const [otherOrgs, setOtherOrgs] = useState(row?.otherOrgs ?? "");
  const [comments, setComments] = useState(row?.comments ?? "");

  const apply = api.committee.submit.useMutation({
    onSuccess: async () => {
      toast.success("Application saved.");
      await utils.committee.mine.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const withdraw = api.committee.withdraw.useMutation({
    onSuccess: async () => {
      toast.success("Application withdrawn.");
      await utils.committee.mine.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const canEdit = data.open && !locked;
  const closes = formatDate(data.closesAt);

  return (
    <div className="mx-auto w-full max-w-lg px-5 py-10 sm:px-6 sm:py-14">
      <p className="text-eyebrow tracking-caps text-gold-ink font-semibold uppercase">
        {committeeCycle.label}
      </p>
      <h1 className="font-display text-navy text-h2 mt-3 font-bold tracking-tight">
        Apply to a committee.
      </h1>
      <p className="text-ink-muted text-body mt-4">
        Membership stays free and open. This is only for Events, Marketing, or
        Treasury. Closes {committeeCycle.closesLabel}. We will reach out
        afterwards to schedule a call.
      </p>

      {row && (
        <div className="border-hairline bg-cream mt-8 rounded-lg border px-5 py-5">
          <Badge
            variant={
              row.status === "accepted"
                ? "default"
                : row.status === "declined"
                  ? "destructive"
                  : "secondary"
            }
          >
            {statusLabel[row.status]}
          </Badge>
          <p className="text-ink-muted text-body-sm mt-3">
            Saved {formatDate(row.submittedAt)}. Name and email come from the
            Google account you signed in with.
          </p>
        </div>
      )}

      {!data.open && (
        <p className="text-ink-muted text-body-sm mt-8">
          This cycle closed {closes}.{" "}
          {row
            ? "Your answers are still on file."
            : "The next recruiting cycle will open here."}
        </p>
      )}

      {locked && (
        <p className="text-ink-muted text-body-sm mt-8">
          An officer has this in review. If something should change, ask them —
          you cannot edit from here once a callback is underway.
        </p>
      )}

      <ul className="text-ink-muted text-body-sm mt-8 grid gap-2">
        {committeeExpectations.map((item) => (
          <li key={item} className="flex gap-3">
            <span
              aria-hidden="true"
              className="bg-gold-bright mt-1.5 size-1.5 shrink-0 rounded-full"
            />
            <span>{item}</span>
          </li>
        ))}
      </ul>

      <form
        className="mt-8 grid gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          apply.mutate({
            discordHandle,
            wantsEvents,
            wantsMarketing,
            wantsTreasury,
            eventsWhy,
            eventsCollabs,
            marketingWhy,
            marketingConnections,
            treasuryWhy,
            otherOrgs,
            comments,
          });
        }}
      >
        <div>
          <Label htmlFor="committee-discord">Discord handle</Label>
          <Input
            id="committee-discord"
            value={discordHandle}
            onChange={(event) => setDiscordHandle(event.target.value)}
            required
            maxLength={80}
            disabled={!canEdit}
            placeholder="name or name#0000"
            className="border-hairline mt-2 text-base"
          />
          <p className="text-ink-muted text-body-sm mt-1.5">
            We will use a Discord channel for the committee.{" "}
            <a
              href={committeeCycle.discordHref}
              target="_blank"
              rel="noopener noreferrer"
              className="text-navy decoration-gold font-semibold underline decoration-2 underline-offset-4"
            >
              Join the server
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            .
          </p>
        </div>

        <fieldset className="grid gap-3">
          <legend className="text-eyebrow tracking-caps text-ink-muted font-semibold uppercase">
            Which committee(s)
          </legend>
          {committees.map((committee) => {
            const checked =
              committee.id === "events"
                ? wantsEvents
                : committee.id === "marketing"
                  ? wantsMarketing
                  : wantsTreasury;
            const onChange =
              committee.id === "events"
                ? setWantsEvents
                : committee.id === "marketing"
                  ? setWantsMarketing
                  : setWantsTreasury;

            return (
              <label
                key={committee.id}
                className="border-hairline has-[:checked]:border-navy has-[:checked]:bg-cream flex cursor-pointer gap-3 rounded-lg border p-4"
              >
                <input
                  type="checkbox"
                  name="committees"
                  value={committee.id}
                  checked={checked}
                  disabled={!canEdit}
                  onChange={(event) => onChange(event.target.checked)}
                  className="accent-navy mt-1 size-4"
                />
                <span>
                  <span className="text-navy block font-semibold">
                    {committee.title}
                  </span>
                  <span className="text-ink-muted text-body-sm mt-1 block">
                    {committee.blurb}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>

        {wantsEvents && (
          <>
            <div>
              <Label htmlFor="events-why">
                Why Events, and what would you run?
              </Label>
              <Textarea
                id="events-why"
                value={eventsWhy}
                onChange={(event) => setEventsWhy(event.target.value)}
                required
                maxLength={2000}
                rows={5}
                disabled={!canEdit}
                className="border-hairline mt-2 text-base"
              />
            </div>
            <div>
              <Label htmlFor="events-collabs">
                Clubs you would like to collaborate with
              </Label>
              <Textarea
                id="events-collabs"
                value={eventsCollabs}
                onChange={(event) => setEventsCollabs(event.target.value)}
                maxLength={1000}
                rows={3}
                disabled={!canEdit}
                className="border-hairline mt-2 text-base"
              />
            </div>
          </>
        )}

        {wantsMarketing && (
          <>
            <div>
              <Label htmlFor="marketing-why">Why Marketing?</Label>
              <Textarea
                id="marketing-why"
                value={marketingWhy}
                onChange={(event) => setMarketingWhy(event.target.value)}
                required
                maxLength={2000}
                rows={5}
                disabled={!canEdit}
                className="border-hairline mt-2 text-base"
              />
            </div>
            <div>
              <Label htmlFor="marketing-connections">
                Classes, clubs, or orgs you can advertise SASE or National
                Conference to
              </Label>
              <Textarea
                id="marketing-connections"
                value={marketingConnections}
                onChange={(event) =>
                  setMarketingConnections(event.target.value)
                }
                maxLength={1000}
                rows={3}
                disabled={!canEdit}
                className="border-hairline mt-2 text-base"
              />
            </div>
          </>
        )}

        {wantsTreasury && (
          <div>
            <Label htmlFor="treasury-why">Why Treasury?</Label>
            <Textarea
              id="treasury-why"
              value={treasuryWhy}
              onChange={(event) => setTreasuryWhy(event.target.value)}
              required
              maxLength={2000}
              rows={5}
              disabled={!canEdit}
              className="border-hairline mt-2 text-base"
            />
          </div>
        )}

        <div>
          <Label htmlFor="other-orgs">
            What other orgs will you be in this year?
          </Label>
          <Textarea
            id="other-orgs"
            value={otherOrgs}
            onChange={(event) => setOtherOrgs(event.target.value)}
            maxLength={1000}
            rows={3}
            disabled={!canEdit}
            className="border-hairline mt-2 text-base"
          />
        </div>

        <div>
          <Label htmlFor="committee-comments">Anything else</Label>
          <Textarea
            id="committee-comments"
            value={comments}
            onChange={(event) => setComments(event.target.value)}
            maxLength={1000}
            rows={3}
            disabled={!canEdit}
            className="border-hairline mt-2 text-base"
          />
        </div>

        {canEdit && (
          <Button
            type="submit"
            disabled={apply.isPending}
            className="bg-navy hover:bg-navy-deep h-12 w-full rounded-md font-semibold text-white sm:w-auto"
          >
            {apply.isPending
              ? "Saving..."
              : row
                ? "Update application"
                : "Submit application"}
          </Button>
        )}
      </form>

      {canEdit && row?.status === "submitted" && (
        <Button
          type="button"
          variant="ghost"
          disabled={withdraw.isPending}
          onClick={() => withdraw.mutate()}
          className="text-ink-muted mt-4 h-11 px-0"
        >
          Withdraw application
        </Button>
      )}

      {apply.error && (
        <Alert variant="destructive" className="border-hairline mt-6">
          <AlertDescription>{apply.error.message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
