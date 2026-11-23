"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { api } from "~/trpc/react";

export function LeaderboardSettings() {
  const mine = api.member.leaderboardPreference.useQuery();

  if (mine.isPending) {
    return (
      <div className="mx-auto w-full max-w-lg px-5 pb-14 sm:px-6">
        <Skeleton className="h-28 w-full rounded-lg" />
      </div>
    );
  }
  if (mine.error) {
    return (
      <p className="text-destructive mx-auto max-w-lg px-5 pb-14">
        {mine.error.message}
      </p>
    );
  }
  return <LeaderboardFields saved={mine.data.hideName} />;
}

function LeaderboardFields({ saved }: { saved: boolean }) {
  const utils = api.useUtils();
  const [hideName, setHideName] = useState(saved);

  const save = api.member.setLeaderboardPreference.useMutation({
    onSuccess: async (next) => {
      toast.success("Leaderboard setting saved.");
      setHideName(next.hideName);
      await Promise.all([
        utils.member.leaderboardPreference.invalidate(),
        utils.member.leaderboard.invalidate(),
      ]);
    },
    onError: (error) => toast.error(error.message),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate({ hideName });
  }

  return (
    <div className="mx-auto w-full max-w-lg px-5 pb-14 sm:px-6">
      <h2 className="font-display text-navy text-h3 font-bold tracking-tight">
        Leaderboard.
      </h2>
      <form className="mt-4 grid gap-4" onSubmit={onSubmit}>
        <label className="border-hairline has-[:focus-visible]:ring-navy flex min-h-11 cursor-pointer gap-3 rounded-lg border p-4 has-[:focus-visible]:ring-2">
          <input
            type="checkbox"
            name="hideName"
            checked={hideName}
            disabled={save.isPending}
            onChange={(event) => setHideName(event.target.checked)}
            className="accent-navy mt-1 size-4 shrink-0"
          />
          <span>
            <span className="text-navy block font-semibold">Hide my name</span>
            <span className="text-ink-muted text-body-sm mt-1 block">
              Other members see &quot;Anonymous member&quot; in your place. You
              keep your rank, and you still see yourself on the board.
            </span>
          </span>
        </label>
        <Button
          type="submit"
          disabled={save.isPending || hideName === saved}
          className="bg-navy hover:bg-navy-deep h-12 w-full rounded-md font-semibold text-white sm:w-auto"
        >
          {save.isPending ? "Saving..." : "Save leaderboard setting"}
        </Button>
      </form>
    </div>
  );
}
