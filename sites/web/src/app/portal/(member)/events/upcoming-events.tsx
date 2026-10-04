"use client";

import { toast } from "sonner";

import { formatEventTime } from "~/app/portal/_lib/format";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { api, type RouterOutputs } from "~/trpc/react";

type Upcoming = RouterOutputs["event"]["upcoming"][number];

function EventRow({ event }: { event: Upcoming }) {
  const utils = api.useUtils();
  const refresh = () =>
    Promise.all([
      utils.event.upcoming.invalidate(),
      utils.event.home.invalidate(),
    ]);
  const rsvp = api.event.rsvp.useMutation({
    onSuccess: async (result) => {
      toast.success(
        result.invited ? "You're in. Calendar invite sent." : "You're in.",
      );
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const cancel = api.event.cancelRsvp.useMutation({
    onSuccess: async (result) => {
      toast.success(
        result.uninvited
          ? "RSVP cancelled and taken off your calendar."
          : "RSVP cancelled.",
      );
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const busy = rsvp.isPending || cancel.isPending;

  return (
    <li className="border-hairline bg-paper/80 rounded-xl border p-5 shadow-xs sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-gold-ink text-eyebrow tracking-caps font-semibold uppercase">
            {formatEventTime(event.startsAt)}
          </p>
          <h2 className="font-display text-navy text-h3 mt-2 font-bold break-words">
            {event.title}
          </h2>
          {event.location && (
            <p className="text-ink-muted text-body-sm mt-1">{event.location}</p>
          )}
        </div>
        {event.attendedAt ? (
          <Badge variant="secondary">Checked in</Badge>
        ) : event.rsvpedAt ? (
          <Badge className="bg-gold-bright text-navy border-transparent">
            Going
          </Badge>
        ) : null}
      </div>

      {event.description && (
        <p className="text-ink-muted text-body-sm mt-3">{event.description}</p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3 empty:hidden">
        {event.rsvpOpen &&
          (event.rsvpedAt ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => cancel.mutate({ eventId: event.id })}
              className="text-ink-muted min-h-11"
            >
              {cancel.isPending ? "Cancelling..." : "Cancel RSVP"}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={busy}
              onClick={() => rsvp.mutate({ eventId: event.id })}
              className="bg-navy hover:bg-navy-deep min-h-11 text-white"
            >
              {rsvp.isPending ? "Saving..." : "RSVP"}
            </Button>
          ))}
      </div>
    </li>
  );
}

export function UpcomingEvents() {
  const upcoming = api.event.upcoming.useQuery();

  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-6 sm:py-14">
      <h1 className="font-display text-navy text-h2 font-bold tracking-tight">
        Upcoming events.
      </h1>
      <p className="text-ink-muted text-body mt-4">
        RSVP and the event goes on your calendar. Cancel and it comes off. You
        still check in at the door for points.
      </p>

      {upcoming.isPending ? (
        <div className="mt-8 grid gap-4">
          <Skeleton className="h-36 w-full rounded-xl" />
          <Skeleton className="h-36 w-full rounded-xl" />
        </div>
      ) : upcoming.error ? (
        <p className="text-destructive mt-8">{upcoming.error.message}</p>
      ) : upcoming.data.length === 0 ? (
        <p className="text-ink-muted text-body mt-10">
          Nothing on the calendar yet.
        </p>
      ) : (
        <ul className="mt-8 grid gap-4">
          {upcoming.data.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </ul>
      )}
    </div>
  );
}
