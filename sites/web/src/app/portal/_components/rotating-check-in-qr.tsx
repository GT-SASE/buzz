"use client";

import { useEffect, useRef, useState } from "react";

import { CheckInQr } from "~/app/portal/_components/check-in-qr";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";

/** Asks just after the server's window flips, so the new code is already there. */
const REFETCH_SLACK_MS = 400;

/** "ABCD2345EFGH6789" as "ABCD 2345 EFGH 6789", for reading aloud and typing. */
export function groupCode(code: string) {
  return code.replace(/(.{4})(?=.)/g, "$1 ");
}

/**
 * The check-in QR that changes every 30 seconds. The code comes from the server
 * (it is signed with a secret the browser never sees), so this asks again when
 * each window ends. The clock it counts down on is the server's: a laptop
 * running a minute fast would otherwise ask for the next code early and
 * flicker.
 *
 * A code stays valid for the window after the one it was shown in, so a
 * request that is a second late, or a member who scans just as it flips, still
 * gets in.
 */
export function RotatingCheckInQr({
  eventId,
  className,
  showCode = false,
  codeClassName,
  barClassName,
}: {
  eventId: string;
  className?: string;
  /** Also print the code, for a member who cannot scan. */
  showCode?: boolean;
  codeClassName?: string;
  barClassName?: string;
}) {
  const query = api.event.presentCode.useQuery(
    { id: eventId },
    {
      // Re-fetched on a timer set below, not on an interval: the interval has
      // to follow the server's window, not the browser's.
      refetchInterval: false,
      refetchOnWindowFocus: true,
      staleTime: 0,
      retry: true,
    },
  );
  const { data, refetch } = query;

  // Milliseconds the server's clock is ahead of this one, from the reply.
  const skew = useRef(0);
  const [draining, setDraining] = useState(false);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!data) return;
    skew.current = data.serverNow - Date.now();
    const left = Math.max(data.windowEndsAt - (Date.now() + skew.current), 0);
    setRemaining(left);
    setDraining(false);
    // One frame at full width, then the transition to empty.
    const frame = requestAnimationFrame(() => setDraining(true));
    const timer = window.setTimeout(
      () => void refetch(),
      left + REFETCH_SLACK_MS,
    );
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [data, refetch]);

  if (!data) {
    return (
      <Skeleton
        className={cn("aspect-square rounded-none bg-white/10", className)}
      />
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <CheckInQr code={data.code} className={className} />
      <div
        role="presentation"
        className={cn(
          "h-1.5 w-full max-w-[min(72vh,42rem)] overflow-hidden rounded-full bg-white/15",
          barClassName,
        )}
      >
        <div
          data-testid="qr-timer"
          className="bg-gold-bright h-full rounded-full ease-linear"
          style={{
            width: draining ? "0%" : "100%",
            transitionProperty: "width",
            transitionDuration: draining ? `${remaining}ms` : "0ms",
          }}
        />
      </div>
      {showCode && (
        <p
          className={cn(
            "font-mono text-lg font-semibold tracking-widest tabular-nums",
            codeClassName,
          )}
        >
          <span className="sr-only">Code to type: </span>
          {groupCode(data.code)}
        </p>
      )}
    </div>
  );
}
