"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { api, type RouterOutputs } from "~/trpc/react";

type Prefs = RouterOutputs["notification"]["mine"];

export function NotificationSettings() {
  const mine = api.notification.mine.useQuery();

  if (mine.isPending) {
    return (
      <div
        aria-busy="true"
        aria-live="polite"
        className="mx-auto w-full max-w-lg px-5 pb-10 sm:px-6"
      >
        <span className="sr-only">Loading settings.</span>
        <Skeleton className="h-8 w-48 rounded-lg" />
        <Skeleton className="mt-4 h-24 w-full rounded-lg" />
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

  return <SettingsFields saved={mine.data} />;
}

const switches = [
  {
    name: "eventEmails",
    title: "Event changes",
    body: "When an event you RSVPed to moves, changes place or is cancelled. Turned off, your calendar keeps the old entry.",
  },
  {
    name: "electionEmails",
    title: "Elections",
    body: "When nominations open, voting opens and results are published.",
  },
] as const;

function SettingsFields({ saved }: { saved: Prefs }) {
  const utils = api.useUtils();
  const [prefs, setPrefs] = useState<Prefs>(saved);

  const save = api.notification.save.useMutation({
    onSuccess: async (next) => {
      toast.success("Settings saved.");
      setPrefs(next);
      await utils.notification.mine.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const changed =
    prefs.eventEmails !== saved.eventEmails ||
    prefs.electionEmails !== saved.electionEmails;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate(prefs);
  }

  return (
    <div className="mx-auto w-full max-w-lg px-5 pb-10 sm:px-6">
      <h2 className="font-display text-navy text-h3 font-bold tracking-tight">
        Email from the chapter.
      </h2>
      <p className="text-ink-muted text-body-sm mt-2">
        Choose which updates reach your inbox.
      </p>

      <form className="mt-4 grid gap-4" onSubmit={onSubmit}>
        <fieldset className="grid gap-3">
          <legend className="sr-only">Optional emails</legend>
          {switches.map(({ name, title, body }) => (
            <label
              key={name}
              className="border-hairline has-[:focus-visible]:ring-navy flex min-h-11 cursor-pointer gap-3 rounded-lg border p-4 has-[:focus-visible]:ring-2"
            >
              <input
                type="checkbox"
                name={name}
                checked={prefs[name]}
                disabled={save.isPending}
                onChange={(event) =>
                  setPrefs({ ...prefs, [name]: event.target.checked })
                }
                className="accent-navy mt-1 size-4 shrink-0"
              />
              <span>
                <span className="text-navy block font-semibold">{title}</span>
                <span className="text-ink-muted text-body-sm mt-1 block">
                  {body}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="border-hairline bg-cream rounded-lg border p-4">
          <p className="text-navy font-semibold">Committee application</p>
          <p className="text-ink-muted text-body-sm mt-1">
            You always get the decision on an application you submitted. It
            answers something you did, so it has no switch.
          </p>
        </div>

        <Button
          type="submit"
          disabled={save.isPending || !changed}
          className="bg-navy hover:bg-navy-deep h-12 w-full rounded-md font-semibold text-white sm:w-auto"
        >
          {save.isPending ? "Saving..." : "Save email settings"}
        </Button>
      </form>
    </div>
  );
}
