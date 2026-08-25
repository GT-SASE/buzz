"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { CheckInQr } from "~/app/portal/_components/check-in-qr";
import { Honeycomb } from "~/app/portal/_components/honeycomb";
import { Badge } from "~/components/ui/badge";
import { api } from "~/trpc/react";

export function PresentScreen({ eventId }: { eventId: string }) {
  const router = useRouter();
  const eventPath = `/portal/admin/events/${eventId}`;

  // Nobody touches a projector for the length of a GBM, which is precisely what
  // a screen blank waits for — and a slept screen takes the door down with it.
  // Re-requested on `visibilitychange` because the browser drops the lock
  // whenever the tab is hidden and does not hand it back on its own.
  useEffect(() => {
    if (!("wakeLock" in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || document.visibilityState !== "visible") return;
      try {
        sentinel = await navigator.wakeLock.request("screen");
      } catch {
        // Refused by the platform or the battery state. The wall still shows
        // the QR; it just dims on the usual timer.
      }
    };

    const reacquire = () => void acquire();

    void acquire();
    document.addEventListener("visibilitychange", reacquire);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", reacquire);
      void sentinel?.release().catch(() => undefined);
    };
  }, []);

  // Escape is the way out of every other full-screen thing on a computer, and
  // the officer at the lectern is driving with a clicker, not a mouse.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") router.push(eventPath);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, eventPath]);

  // Polled: the count on the wall is the only feedback an officer gets that the
  // door is working, and a stale zero looks like a broken QR.
  const detail = api.event.getById.useQuery(
    { id: eventId },
    { refetchInterval: 10_000 },
  );

  const event = detail.data?.event;

  // The same three facts `event.checkIn` tests, so the wall cannot advertise a
  // QR the door has already started refusing.
  const open =
    event?.archivedAt === null &&
    event.checkInEnabled &&
    detail.data?.isPast === false;

  const closed = detail.data !== undefined && !open;

  return (
    // A nested layout renders inside its parents, so covering the viewport is
    // the only way to be rid of the site header and the portal tab rail.
    <div className="bg-navy navy-wash fixed inset-0 z-50 flex flex-col overflow-hidden px-8 py-7 sm:px-12 sm:py-9">
      <Honeycomb className="text-gold-bright/[0.10] absolute inset-0 h-full w-full" />

      <header className="relative flex shrink-0 flex-wrap items-baseline justify-between gap-x-8 gap-y-3">
        <h1 className="font-display text-[clamp(1.75rem,3vw,3.25rem)] leading-none font-bold text-white">
          {event?.title ?? "Loading"}
        </h1>
        {detail.data && (
          <Badge className="bg-gold-bright text-navy border-transparent px-5 py-1.5 text-[clamp(1.125rem,1.9vw,2.25rem)] leading-none font-bold tabular-nums">
            {`${detail.data.roster.length} checked in`}
          </Badge>
        )}
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col items-stretch justify-center py-6">
        {closed ? (
          <div className="text-center">
            <p className="font-display text-[clamp(2.5rem,6vw,6rem)] leading-none font-bold text-white">
              Check-in is closed.
            </p>
            <p className="mt-8 text-[clamp(1.125rem,1.8vw,2rem)] font-semibold text-white/75">
              {event?.archivedAt
                ? "This event is archived. This QR will not admit anyone."
                : detail.data?.isPast
                  ? "Check-in closed automatically 24 hours after this event started."
                  : "Check-in is closed. This QR will not admit anyone."}
            </p>
          </div>
        ) : event ? (
          <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-4 sm:gap-5">
            <div className="flex min-h-0 w-full flex-1 items-center justify-center">
              <CheckInQr
                code={event.checkInCode}
                className="aspect-square h-full max-h-[min(70vh,40rem)] w-auto max-w-full p-3 sm:p-5"
              />
            </div>
            <p className="text-gold-bright tracking-masthead shrink-0 text-[clamp(1rem,2vw,2rem)] font-semibold uppercase">
              Scan to check in
            </p>
          </div>
        ) : null}
      </div>

      <footer className="relative flex shrink-0 items-center justify-end">
        <Link
          href={eventPath}
          className="text-body-sm inline-flex min-h-11 items-center font-semibold text-white/50 transition hover:text-white"
        >
          Leave the projector view
          <span className="ml-2 hidden font-normal text-white/35 sm:inline">
            (Esc)
          </span>
        </Link>
      </footer>
    </div>
  );
}
