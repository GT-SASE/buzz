"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";

import { Honeycomb } from "~/app/portal/_components/honeycomb";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { api } from "~/trpc/react";

export function PresentScreen({ eventId }: { eventId: string }) {
  const [qr, setQr] = useState<string | null>(null);

  const origin = useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => "",
  );

  // Polled: the count on the wall is the only feedback an officer gets that the
  // door is working, and a stale zero looks like a broken code.
  const detail = api.event.getById.useQuery(
    { id: eventId },
    { refetchInterval: 10_000 },
  );

  const event = detail.data?.event;

  // The same three facts `event.checkIn` tests, so the wall cannot advertise a
  // code the door has already started refusing.
  const open =
    event?.archivedAt === null &&
    event.checkInEnabled &&
    detail.data?.isPast === false;

  const url =
    origin && event && open
      ? `${origin}/portal/check-in?code=${event.checkInCode}`
      : null;

  useEffect(() => {
    // Clearing matters as much as drawing: holding the last PNG would leave a
    // live-looking code on the wall after an officer closed the door.
    if (!url) {
      setQr(null);
      return;
    }
    let cancelled = false;

    void (async () => {
      const { toDataURL } = await import("qrcode");
      const png = await toDataURL(url, {
        errorCorrectionLevel: "H",
        margin: 1,
        width: 900,
        color: { dark: "#003057ff", light: "#fdfaf4ff" },
      });
      if (!cancelled) setQr(png);
    })();

    return () => {
      cancelled = true;
    };
  }, [url]);

  const code = event?.checkInCode ?? "";
  const groups = code.match(/.{1,4}/g) ?? [];
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

      <div className="relative flex min-h-0 flex-1 items-center justify-center py-6">
        {closed ? (
          <div className="text-center">
            <p className="font-display text-[clamp(2.5rem,6vw,6rem)] leading-none font-bold text-white">
              Check-in is closed.
            </p>
            <p className="mt-8 text-[clamp(1.125rem,1.8vw,2rem)] font-semibold text-white/75">
              {event?.archivedAt
                ? "This event is archived. The code will not admit anyone."
                : detail.data?.isPast
                  ? "Check-in closed automatically 24 hours after this event started."
                  : "Check-in is closed. This code will not admit anyone."}
            </p>
          </div>
        ) : (
          // The QR is the whole flow now, so it gets the whole wall. The code
          // below it is the officer's handle on the event, not something a
          // member is meant to read.
          <div className="flex w-full flex-col items-center justify-center gap-6">
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qr}
                alt=""
                className="bg-paper w-[min(62vh,40rem)] max-w-full p-4"
              />
            ) : (
              <Skeleton className="aspect-square w-[min(62vh,40rem)] max-w-full rounded-none bg-white/10" />
            )}

            <p className="text-gold-bright tracking-masthead text-[clamp(1rem,2vw,2rem)] font-semibold uppercase">
              {open
                ? "Open the portal and point your camera here"
                : "Ask an officer to add you"}
            </p>

            {code && (
              <p className="font-mono text-[clamp(0.875rem,1.1vw,1.25rem)] font-semibold tracking-[0.3em] text-white/40 tabular-nums">
                {groups.join(" ")}
              </p>
            )}
          </div>
        )}
      </div>

      <footer className="relative flex shrink-0 items-center justify-end">
        <Link
          href={`/portal/admin/events/${eventId}`}
          className="text-body-sm font-semibold text-white/50 transition hover:text-white"
        >
          Leave the projector view
        </Link>
      </footer>
    </div>
  );
}
