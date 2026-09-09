"use client";

import { useState } from "react";
import { toast } from "sonner";

import { KinCard } from "~/app/portal/_components/kin-card";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import { api, type RouterOutputs } from "~/trpc/react";

const roles = [
  {
    value: "mentee" as const,
    title: "Mentee",
    body: "First- or second-year looking for an upperclassman in your corner.",
  },
  {
    value: "mentor" as const,
    title: "Mentor",
    body: "Upperclassman who can take a little to coffee and read a resume.",
  },
];

type Signup = RouterOutputs["mentorship"]["mine"];

export function MentorshipSignup({ name }: { name: string }) {
  const mine = api.mentorship.mine.useQuery();

  if (mine.isPending) {
    return (
      <div
        aria-busy="true"
        aria-live="polite"
        className="mx-auto w-full max-w-lg px-5 py-10 sm:px-6 sm:py-14"
      >
        <span className="sr-only">Loading SASE KIN signup.</span>
        <Skeleton className="h-4 w-24 rounded-full" />
        <Skeleton className="mt-3 h-10 w-64 rounded-lg" />
        <Skeleton className="mt-4 h-16 w-full rounded-lg" />
        <Skeleton className="mt-8 h-28 w-full rounded-lg" />
      </div>
    );
  }

  return <MentorshipSignupForm name={name} row={mine.data ?? null} />;
}

function MentorshipSignupForm({
  name,
  row,
}: {
  name: string;
  row: Signup;
}) {
  const utils = api.useUtils();
  const [role, setRole] = useState<"mentor" | "mentee">(row?.role ?? "mentee");
  const [note, setNote] = useState(row?.note ?? "");

  const enroll = api.mentorship.expressInterest.useMutation({
    onSuccess: async () => {
      toast.success("You're on the list.");
      await utils.mentorship.mine.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const withdraw = api.mentorship.withdraw.useMutation({
    onSuccess: async () => {
      toast.success("Signup withdrawn.");
      await utils.mentorship.mine.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const locked = row?.status === "enrolled";

  return (
    <div className="mx-auto w-full max-w-lg px-5 py-10 sm:px-6 sm:py-14">
      <p className="text-eyebrow tracking-caps text-gold-ink font-semibold uppercase">
        SASE KIN
      </p>
      <h1 className="font-display text-navy text-h2 mt-3 font-bold tracking-tight">
        Sign up for SASE KIN.
      </h1>
      <p className="text-ink-muted text-body mt-4">
        Event check-ins stay on your event card. KIN points live on their own
        card — an officer adds them after you actually meet.
      </p>

      {row && row.status !== "withdrawn" && (
        <div className="mt-8">
          <KinCard name={name} role={row.role} points={row.points} />
          <p className="text-ink-muted text-body-sm mt-3">
            {row.status === "interested"
              ? "Interested — waiting for an officer to enroll you."
              : "Enrolled in a kin group."}
          </p>
        </div>
      )}

      {locked ? (
        <p className="text-ink-muted text-body-sm mt-8">
          An officer enrolled you. If that should change, ask them — you cannot
          withdraw from here once you are in a kin group.
        </p>
      ) : (
        <form
          className="mt-8 grid gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = note.trim();
            enroll.mutate({ role, note: trimmed ? trimmed : undefined });
          }}
        >
          <fieldset className="grid gap-3">
            <legend className="text-eyebrow tracking-caps text-ink-muted font-semibold uppercase">
              I want to be a
            </legend>
            {roles.map((option) => (
              <label
                key={option.value}
                className="border-hairline has-[:checked]:border-navy has-[:checked]:bg-cream flex cursor-pointer gap-3 rounded-lg border p-4"
              >
                <input
                  type="radio"
                  name="role"
                  value={option.value}
                  checked={role === option.value}
                  onChange={() => setRole(option.value)}
                  className="accent-navy mt-1 size-4"
                />
                <span>
                  <span className="text-navy block font-semibold">
                    {option.title}
                  </span>
                  <span className="text-ink-muted text-body-sm mt-1 block">
                    {option.body}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <div>
            <Label htmlFor="mentorship-note">
              Anything the board should know
            </Label>
            <Textarea
              id="mentorship-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={400}
              rows={3}
              placeholder="Major, year, what you want out of it"
              className="border-hairline mt-2 text-base"
            />
          </div>

          <Button
            type="submit"
            disabled={enroll.isPending}
            className="bg-navy hover:bg-navy-deep h-12 w-full rounded-md font-semibold text-white sm:w-auto"
          >
            {enroll.isPending ? "Saving..." : "I'm interested"}
          </Button>
        </form>
      )}

      {row?.status === "interested" && (
        <Button
          type="button"
          variant="ghost"
          disabled={withdraw.isPending}
          onClick={() => withdraw.mutate()}
          className="text-ink-muted mt-4 h-11 px-0"
        >
          Withdraw signup
        </Button>
      )}

      {enroll.error && (
        <Alert variant="destructive" className="border-hairline mt-6">
          <AlertDescription>{enroll.error.message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
