"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { Honeycomb } from "~/app/portal/_components/honeycomb";
import { EmptyState } from "~/app/portal/_components/portal-ui";
import { downloadCsv, toCsv } from "~/app/portal/_lib/csv";
import { formatEventTime } from "~/app/portal/_lib/format";
import { Eyebrow } from "~/components/site";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { site } from "~/data/site";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";
import { EventQr } from "./event-qr";

type RosterRow = RouterOutputs["event"]["getById"]["roster"][number];
type DoorState = "open" | "closed" | "archived";

/** What officers read out. Bare host, because it goes on a slide. */
const checkInHost = site.url.replace(/^https?:\/\//, "");

const columnHeading =
  "text-eyebrow tracking-caps text-ink-muted h-auto py-3 font-semibold uppercase";

/**
 * The door, as a state rather than a sentence. A filled disc and a hollow one
 * differ without relying on colour.
 */
function CheckInStatus({ state }: { state: DoorState }) {
  const open = state === "open";

  return (
    <Badge
      variant="outline"
      className={cn(
        "text-eyebrow tracking-caps gap-2.5 px-4 py-1.5 font-semibold uppercase",
        open
          ? "bg-gold-bright/15 text-gold-bright border-gold-bright/45"
          : "border-white/25 text-white/70",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2.5 rounded-full",
          open ? "bg-gold-bright" : "border border-white/60",
        )}
      />
      {open
        ? "Check-in open"
        : state === "archived"
          ? "Archived"
          : "Check-in closed"}
    </Badge>
  );
}

function RosterRows({
  rows,
  onRemove,
  removing,
}: {
  rows: RosterRow[];
  onRemove: (userId: string) => void;
  removing: boolean;
}) {
  return (
    <>
      {rows.map((row) => (
        <TableRow key={row.userId} className="border-hairline align-top">
          <TableCell className="py-4 pr-6 whitespace-normal">
            <p className="text-navy font-semibold">{row.name ?? row.email}</p>
            <p className="text-ink-muted text-body-sm mt-0.5">{row.email}</p>
          </TableCell>
          <TableCell className="py-4 pr-6">
            <Badge
              variant={row.method === "manual" ? "secondary" : "outline"}
              className="text-body-sm border-hairline font-semibold"
            >
              {row.method === "manual" ? "Officer" : "Code"}
            </Badge>
          </TableCell>
          <TableCell className="text-gold-ink py-4 pr-6 text-right font-semibold tabular-nums">
            +{row.pointsEarned}
          </TableCell>
          <TableCell className="text-ink-muted text-body-sm py-4 pr-6 text-right tabular-nums">
            {formatEventTime(row.checkedInAt)}
          </TableCell>
          <TableCell className="py-4 text-right">
            {/* Removing takes a member's points back, so it asks first. */}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={removing}
                  className="text-ink-muted text-body-sm font-semibold hover:text-red-900"
                >
                  Remove
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Remove {row.name ?? row.email}?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    Their check-in and the {row.pointsEarned} points it earned
                    are taken back.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive hover:bg-destructive/90 text-white"
                    onClick={() => onRemove(row.userId)}
                  >
                    Yes, remove
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }, (_, index) => (
        <TableRow key={index} className="border-hairline">
          <TableCell className="py-4 pr-6">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-2 h-3 w-56" />
          </TableCell>
          <TableCell className="py-4 pr-6">
            <Skeleton className="h-5 w-16 rounded-full" />
          </TableCell>
          <TableCell className="py-4 pr-6">
            <Skeleton className="ml-auto h-4 w-8" />
          </TableCell>
          <TableCell className="py-4 pr-6">
            <Skeleton className="ml-auto h-4 w-28" />
          </TableCell>
          <TableCell className="py-4">
            <Skeleton className="ml-auto h-4 w-16" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function RosterTable({ children }: { children: React.ReactNode }) {
  return (
    <Table label="Attendance" className="min-w-[34rem] text-left">
      <TableHeader>
        <TableRow className="border-hairline">
          {/* w-full on the one elastic column; the rest hug their text. */}
          <TableHead className={cn(columnHeading, "w-full pr-6")}>
            Name
          </TableHead>
          <TableHead className={cn(columnHeading, "pr-6")}>Method</TableHead>
          <TableHead className={cn(columnHeading, "pr-6 text-right")}>
            Points
          </TableHead>
          <TableHead className={cn(columnHeading, "pr-6 text-right")}>
            Checked in
          </TableHead>
          <TableHead className={columnHeading}>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

function EventSkeleton() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Loading event...</span>
      <Skeleton className="h-9 w-2/3" />
      <Skeleton className="mt-3 h-4 w-72" />
      <Skeleton className="mt-8 h-64 w-full rounded-lg" />
      <div className="mt-14">
        <Skeleton className="h-6 w-48" />
      </div>
      <div className="mt-6">
        <RosterTable>
          <SkeletonRows />
        </RosterTable>
      </div>
    </div>
  );
}

export function EventAttendance({ eventId }: { eventId: string }) {
  const utils = api.useUtils();
  const [email, setEmail] = useState("");

  /** The origin, without touching `window` during render. */
  const origin = useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => "",
  );
  const detail = api.event.getById.useQuery({ id: eventId });

  const invalidate = async () => {
    await Promise.all([
      utils.event.getById.invalidate({ id: eventId }),
      utils.event.listAll.invalidate(),
      utils.chapter.overview.invalidate(),
      utils.member.list.invalidate(),
      utils.member.byId.invalidate(),
      utils.member.leaderboard.invalidate(),
    ]);
  };

  const manual = api.event.manualCheckIn.useMutation({
    onSuccess: async (member) => {
      setEmail("");
      toast.success(`${member.name ?? member.email} added to the roster.`);
      await invalidate();
    },
  });
  const remove = api.event.removeCheckIn.useMutation({
    onSuccess: async () => {
      toast.success("Check-in removed.");
      await invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  // Never echo the new code into the toast: it is a bearer credential and
  // toasts outlive the screen they were raised on.
  const rotate = api.event.regenerateCode.useMutation({
    onSuccess: async () => {
      toast.success("Code rotated. The old one no longer admits anyone.");
      await invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  if (detail.isPending) {
    return <EventSkeleton />;
  }
  if (detail.error) {
    return (
      <Alert variant="destructive" className="border-hairline">
        <AlertDescription>{detail.error.message}</AlertDescription>
      </Alert>
    );
  }

  const { event, roster, rosterTotal, isPast } = detail.data;

  // Built from the live origin rather than site.url: on a laptop at the event
  // that is localhost or a LAN address, and a QR pointing at the production
  // domain would send everyone in the room somewhere the event does not exist.
  // Fragment keeps the bearer out of server logs and Referer headers.
  const checkInUrl = origin
    ? `${origin}/portal/check-in#code=${event.checkInCode}`
    : null;

  // The same three facts the check-in procedure tests before it lets anyone in,
  // so the panel cannot advertise a door the server has already shut.
  const state: DoorState = event.archivedAt
    ? "archived"
    : event.checkInEnabled && !isPast
      ? "open"
      : "closed";

  const overCapacity =
    event.maxCheckIns != null && event.currentCheckIns > event.maxCheckIns;

  const exportAttendance = async () => {
    try {
      const { rows, truncated } = await utils.event.exportAttendance.fetch({
        id: eventId,
      });
      const csv = toCsv([
        ["Name", "Email", "Method", "Points", "Checked in"],
        ...rows.map((row) => [
          row.name ?? "",
          row.email,
          row.method,
          row.pointsEarned,
          row.checkedInAt.toISOString(),
        ]),
      ]);
      downloadCsv(
        `${event.title.replace(/[^\w-]+/g, "-")}-attendance.csv`,
        csv,
      );
      toast.success(
        truncated
          ? `Exported the first ${rows.length} check-ins.`
          : `Exported ${rows.length} check-in${rows.length === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not export attendance.",
      );
    }
  };

  return (
    <div>
      {/* No <Toaster /> here — the officer layout already mounts one for this
          whole subtree, and two mounted Toasters render every toast twice. */}

      {/* Deliberately an h2-sized h1: on this screen the title is the label and
          the code is the content. */}
      <h1 className="font-display text-navy text-h2 font-bold tracking-tight text-balance">
        {event.title}
      </h1>
      <p className="text-ink-muted text-body mt-2">
        {formatEventTime(event.startsAt)}
        {event.location ? ` · ${event.location}` : ""}
      </p>

      {/* The projector panel. Sized to be read from the back of a lecture hall,
          which is why the code alphabet has no I, L, O, U, 0 or 1. */}
      <div className="bg-navy navy-wash border-navy-deep relative mt-8 overflow-hidden rounded-lg border">
        <Honeycomb className="text-gold-bright/[0.13] absolute inset-0 h-full w-full" />

        <div className="relative px-5 py-10 sm:px-10 sm:py-14">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
            <Eyebrow tone="onNavy" rule={false}>
              Check in at
            </Eyebrow>
            <CheckInStatus state={state} />
          </div>

          {/* A preview of what goes on the wall. Members scan; the code beneath
              is an officer's reference for adding somebody by hand. */}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-10 gap-y-8">
            <div className="min-w-0">
              <p className="text-lead font-semibold text-white">
                {checkInHost}/portal
              </p>

              <p
                className={cn(
                  "mt-6 font-mono text-2xl font-bold tracking-[0.2em] tabular-nums",
                  state === "open" ? "text-gold-bright" : "text-white/55",
                )}
              >
                {event.checkInCode}
              </p>
            </div>

            {/* Only while the door is open: a scannable code on a dead event
                sends people to an error, which is worse than no code at all. */}
            {state === "open" && checkInUrl && (
              <EventQr url={checkInUrl} code={event.checkInCode} />
            )}
          </div>

          {state !== "open" && (
            <p className="text-body max-w-measure mt-6 text-white/75">
              {state === "archived"
                ? "This event is archived. The code will not admit anyone."
                : isPast
                  ? "Check-in closed automatically 24 hours after this event started. The code will not admit anyone."
                  : "Check-in is closed — members entering this code will be turned away."}
            </p>
          )}
        </div>
      </div>

      {/* What an officer reaches for first at the start of an event. */}
      <div className="mt-6">
        <Button
          asChild
          size="lg"
          className="bg-gold-bright text-navy hover:bg-gold rounded-full font-semibold"
        >
          <Link href={`/portal/admin/events/${event.id}/present`}>
            Open the projector view
          </Link>
        </Button>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p className="text-ink-muted text-body-sm max-w-measure">
          Anyone holding this code can check in. Rotating it revokes a
          photographed slide immediately.
        </p>

        {/* Asks first, unlike the other quiet controls here: rotating mid-event
            invalidates the code the room is looking at, and there is no undo. */}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              disabled={rotate.isPending}
              className="border-hairline text-navy hover:bg-cream rounded-full font-semibold"
            >
              {rotate.isPending ? "Rotating..." : "Rotate the code"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Replace the code on screen?</AlertDialogTitle>
              <AlertDialogDescription>
                Every slide, poster and photograph carrying the current code
                stops working the moment you do this, and the old code cannot be
                brought back.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive hover:bg-destructive/90 text-white"
                onClick={() => rotate.mutate({ id: event.id })}
              >
                Yes, rotate
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <div className="mt-14 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow tone="gold">Attendance</Eyebrow>
          <h2 className="font-display text-navy text-h3 mt-4 font-bold tabular-nums">
            {rosterTotal} checked in
            {event.maxCheckIns !== null ? ` of ${event.maxCheckIns}` : ""}
          </h2>
          {overCapacity && (
            <p className="text-destructive text-body-sm mt-2">
              Over capacity — officers added check-ins past the listed limit.
            </p>
          )}
        </div>
        {rosterTotal > 0 && (
          <Button
            variant="outline"
            onClick={() => void exportAttendance()}
            className="border-hairline text-navy hover:bg-cream rounded-full font-semibold"
          >
            Export CSV
          </Button>
        )}
      </div>

      <div className="mt-6">
        {roster.length > 0 ? (
          <RosterTable>
            <RosterRows
              rows={roster}
              removing={remove.isPending}
              onRemove={(userId) =>
                remove.mutate({ eventId: event.id, userId })
              }
            />
          </RosterTable>
        ) : (
          <EmptyState
            title="Nobody has checked in yet."
            body="Put the code on the screen and it will fill in as members enter it."
          >
            <Button
              asChild
              className="bg-navy hover:bg-navy-deep rounded-full font-semibold text-white"
            >
              <Link href={`/portal/admin/events/${event.id}/present`}>
                Open the projector view
              </Link>
            </Button>
          </EmptyState>
        )}
      </div>

      <Card className="border-hairline mt-10 rounded-lg shadow-none">
        <CardHeader className="border-hairline border-b">
          <CardTitle className="font-display text-navy text-h3 font-bold">
            Manual check-in
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(submitEvent) => {
              submitEvent.preventDefault();
              if (!email.trim()) return;
              manual.mutate({ eventId: event.id, email });
            }}
          >
            <div className="min-w-64 flex-1">
              <Label
                htmlFor="manual-email"
                className="text-eyebrow tracking-caps text-ink-muted font-semibold uppercase"
              >
                Member email
              </Label>
              <Input
                id="manual-email"
                type="email"
                value={email}
                onChange={(changeEvent) => setEmail(changeEvent.target.value)}
                placeholder="member@gatech.edu"
                className="border-hairline bg-cream/60 focus-visible:bg-paper mt-2 h-11 rounded-lg"
              />
            </div>
            <Button
              type="submit"
              disabled={manual.isPending}
              className="bg-gold-bright text-navy hover:bg-gold h-11 rounded-full font-semibold"
            >
              {manual.isPending ? "Adding..." : "Add to roster"}
            </Button>
          </form>

          <p className="text-ink-muted text-body-sm max-w-measure mt-4">
            They have to have signed in to the portal at least once, and they
            earn the same{" "}
            <span className="tabular-nums">{event.pointsValue}</span> points as
            everyone who used the code.
          </p>

          {manual.error && (
            <Alert variant="destructive" className="border-hairline mt-4">
              <AlertDescription>{manual.error.message}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
