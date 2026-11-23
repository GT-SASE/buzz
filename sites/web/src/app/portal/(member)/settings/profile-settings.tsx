"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import { api } from "~/trpc/react";

/** `""` means unset; anything else is a year the router range-checks. */
export function parseYear(text: string) {
  const trimmed = text.trim();
  return trimmed === "" ? null : Number(trimmed);
}

export function ProfileSettings() {
  const mine = api.member.profile.useQuery();

  if (mine.isPending) {
    return (
      <div className="mx-auto w-full max-w-lg px-5 pb-10 sm:px-6">
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    );
  }
  if (mine.error) {
    return (
      <p className="text-destructive mx-auto max-w-lg px-5 pb-10">
        {mine.error.message}
      </p>
    );
  }
  return <ProfileFields saved={mine.data.graduationYear} />;
}

function ProfileFields({ saved }: { saved: number | null }) {
  const utils = api.useUtils();
  const [text, setText] = useState(saved === null ? "" : String(saved));

  const save = api.member.setProfile.useMutation({
    onSuccess: async (next) => {
      toast.success("Profile saved.");
      setText(next.graduationYear === null ? "" : String(next.graduationYear));
      await utils.member.profile.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const year = parseYear(text);
  const invalid =
    year !== null && !(Number.isInteger(year) && year >= 2000 && year <= 2100);
  const changed = year !== saved;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!invalid) save.mutate({ graduationYear: year });
  }

  return (
    <div className="mx-auto w-full max-w-lg px-5 pb-10 sm:px-6">
      <h2 className="font-display text-navy text-h3 font-bold tracking-tight">
        About you.
      </h2>
      <form className="mt-4 grid gap-4" onSubmit={onSubmit}>
        <div className="grid gap-2">
          <Label htmlFor="graduation-year">Graduation year</Label>
          <Input
            id="graduation-year"
            name="graduationYear"
            inputMode="numeric"
            placeholder="2028"
            value={text}
            disabled={save.isPending}
            aria-invalid={invalid}
            onChange={(event) => setText(event.target.value)}
            className="max-w-40 text-base tabular-nums"
          />
          <p className="text-ink-muted text-body-sm">
            Officers see it on the roster. Leave it blank to keep it unset.
          </p>
          {invalid && (
            <p role="alert" className="text-destructive text-body-sm">
              Enter a year from 2000 to 2100.
            </p>
          )}
        </div>
        <Button
          type="submit"
          disabled={save.isPending || !changed || invalid}
          className="bg-navy hover:bg-navy-deep h-12 w-full rounded-md font-semibold text-white sm:w-auto"
        >
          {save.isPending ? "Saving..." : "Save profile"}
        </Button>
      </form>
    </div>
  );
}
