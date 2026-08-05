"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { PointsPill } from "~/app/portal/_components/portal-ui";
import { api } from "~/trpc/react";

export function CheckInForm({ initialCode }: { initialCode: string }) {
  // Prefilled from `?code=` but never auto-submitted: the mutation fires only
  // on an explicit tap, so a link preview or a prefetch cannot check anyone in.
  const [code, setCode] = useState(initialCode.toUpperCase());
  const router = useRouter();
  const utils = api.useUtils();

  const checkIn = api.event.checkIn.useMutation({
    onSuccess: async () => {
      setCode("");
      // The dashboard and history are server-rendered, so both the cache and
      // the RSC payload have to be told the totals moved.
      await Promise.all([
        utils.event.myStats.invalidate(),
        utils.event.myEvents.invalidate(),
        utils.event.upcoming.invalidate(),
      ]);
      router.refresh();
    },
  });

  return (
    <div>
      <form
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          if (!code.trim()) return;
          checkIn.mutate({ code });
        }}
      >
        <label
          htmlFor="check-in-code"
          className="text-eyebrow tracking-caps text-ink-muted font-semibold uppercase"
        >
          Check-in code
        </label>
        <input
          id="check-in-code"
          name="code"
          value={code}
          onChange={(changeEvent) =>
            setCode(changeEvent.target.value.toUpperCase())
          }
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={16}
          placeholder="ABCD2345"
          aria-describedby={checkIn.error ? "check-in-error" : undefined}
          className="border-hairline bg-paper text-navy font-display placeholder:text-ink-muted/40 mt-3 w-full rounded-2xl border px-5 py-4 text-2xl font-bold uppercase tracking-[0.25em]"
        />

        <button
          type="submit"
          disabled={checkIn.isPending || code.trim().length === 0}
          className="bg-gold-bright text-navy hover:bg-gold shadow-soft mt-5 w-full rounded-full px-7 py-3.5 font-semibold transition duration-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {checkIn.isPending ? "Checking in..." : "Check in"}
        </button>
      </form>

      {/* Both states are announced: the member is usually looking at the
          officer, not the screen, when this resolves. */}
      <div aria-live="polite" className="mt-6">
        {checkIn.error && (
          <p
            id="check-in-error"
            className="rounded-card border border-red-800/25 bg-red-50 px-5 py-4 text-sm font-medium text-red-900"
          >
            {checkIn.error.message}
          </p>
        )}

        {checkIn.data && (
          <div className="rounded-card ring-gold/45 bg-cream px-5 py-5 ring-1">
            <div className="flex items-center justify-between gap-4">
              <p className="font-display text-navy text-h3 font-bold">
                You are in.
              </p>
              <PointsPill points={checkIn.data.pointsEarned} />
            </div>
            <p className="text-ink-muted text-body-sm mt-2">
              {checkIn.data.eventTitle}
            </p>
            <p className="text-gold-ink text-body mt-4 font-semibold">
              {checkIn.data.totalPoints} points across{" "}
              {checkIn.data.totalEvents}{" "}
              {checkIn.data.totalEvents === 1 ? "event" : "events"}.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
