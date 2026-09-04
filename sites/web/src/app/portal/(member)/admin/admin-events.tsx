"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import {
  formatEventTime,
  fromLocalInputValue,
  toLocalInputValue,
} from "~/app/portal/_lib/format";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
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
import { Badge } from "~/components/ui/badge";
import { Button, buttonVariants } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";
import { revalidatePublicCalendar } from "./revalidate-calendar";
import {
  adminEventFilters,
  visibleEvents,
  type AdminEventFilter,
} from "./visible-events";

type AdminEvent = RouterOutputs["event"]["listAll"]["events"][number];
type Filter = AdminEventFilter;
const filters = adminEventFilters;

/** FormData entries are `string | File`; only the string case is ever real here. */
const text = (value: FormDataEntryValue | null) =>
  typeof value === "string" ? value.trim() : "";

function EventForm({
  event,
  onDone,
}: {
  event?: AdminEvent;
  onDone: () => void;
}) {
  const utils = api.useUtils();
  const [limited, setLimited] = useState(event?.maxCheckIns != null);

  // Not just the list. The attendance and projector screens read `getById`,
  // and the overview strip on this same page counts events.
  const refresh = async () => {
    await Promise.all([
      utils.event.listAll.invalidate(),
      utils.event.getById.invalidate(),
      utils.chapter.overview.invalidate(),
      utils.chapter.attendance.invalidate(),
      revalidatePublicCalendar(),
    ]);
    onDone();
  };

  const create = api.event.create.useMutation({
    onSuccess: async () => {
      toast.success("Event created.");
      await refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const update = api.event.update.useMutation({
    onSuccess: async () => {
      toast.success("Changes saved.");
      await refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const pending = create.isPending || update.isPending;

  return (
    <form
      className="grid gap-5"
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault();

        const data = new FormData(submitEvent.currentTarget);
        const capacity = text(data.get("maxCheckIns"));
        const description = text(data.get("description"));
        const location = text(data.get("location"));

        const values = {
          title: text(data.get("title")),
          startsAt: fromLocalInputValue(text(data.get("startsAt"))),
          pointsValue: Number(text(data.get("pointsValue"))),
          location: location || undefined,
          description: description || undefined,
          maxCheckIns: capacity ? Number(capacity) : null,
        };

        if (event) {
          update.mutate({ ...values, id: event.id });
        } else {
          create.mutate(values);
        }
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="title">Event title</Label>
        <Input
          id="title"
          name="title"
          required
          maxLength={200}
          defaultValue={event?.title ?? ""}
          className="font-display text-base font-bold"
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="startsAt">Starts (Atlanta time)</Label>
          <Input
            id="startsAt"
            name="startsAt"
            type="datetime-local"
            required
            defaultValue={event ? toLocalInputValue(event.startsAt) : undefined}
            className="text-base tabular-nums"
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="pointsValue">Points for attending</Label>
          <Input
            id="pointsValue"
            name="pointsValue"
            type="number"
            min={0}
            max={100}
            required
            defaultValue={event?.pointsValue ?? 10}
            className="text-base tabular-nums"
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="capacityMode">Capacity</Label>
          <Select
            value={limited ? "limited" : "unlimited"}
            onValueChange={(value) => setLimited(value === "limited")}
          >
            <SelectTrigger
              id="capacityMode"
              className="h-auto min-h-11 w-full text-base"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unlimited">No limit</SelectItem>
              <SelectItem value="limited">Limited</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {limited && (
          <div className="grid gap-2">
            <Label htmlFor="maxCheckIns">Seats</Label>
            <Input
              id="maxCheckIns"
              name="maxCheckIns"
              type="number"
              min={1}
              required
              defaultValue={event?.maxCheckIns ?? ""}
              className="text-base tabular-nums"
            />
          </div>
        )}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="location">Location</Label>
        <Input
          id="location"
          name="location"
          maxLength={200}
          defaultValue={event?.location ?? ""}
          className="text-base"
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          name="description"
          rows={3}
          maxLength={1000}
          defaultValue={event?.description ?? ""}
          className="text-base"
        />
      </div>

      {/* Editing the value re-prices future attendance only. */}
      {event && (
        <p className="border-hairline text-ink-muted text-body-sm border-t pt-4">
          Changing the points here affects check-ins from now on. Members who
          already attended keep what they earned.
        </p>
      )}

      <DialogFooter className="mt-2 gap-2 sm:gap-2">
        <DialogClose asChild>
          <Button type="button" variant="outline" className="min-h-11">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending} className="min-h-11">
          {pending ? "Saving..." : event ? "Save changes" : "Create event"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Create and edit share one dialog; the trigger decides which it is. */
function EventDialog({
  event,
  trigger,
}: {
  event?: AdminEvent;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display text-navy text-h3 font-bold">
            {event ? "Edit event" : "New event"}
          </DialogTitle>
          <DialogDescription>
            {event
              ? "Attendance already recorded keeps the points it was stamped with."
              : "Creating one generates its check-in code straight away."}
          </DialogDescription>
        </DialogHeader>
        <EventForm event={event} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function StatusBadges({ event }: { event: AdminEvent }) {
  const archived = event.archivedAt !== null;
  const full =
    event.maxCheckIns !== null && event.attendees >= event.maxCheckIns;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {archived ? (
        <Badge variant="secondary" className="border-hairline bg-cream/70 text-ink-muted">
          Archived
        </Badge>
      ) : event.checkInEnabled ? (
        <Badge className="bg-emerald-600/10 text-emerald-800 border-emerald-600/30 gap-1.5 font-medium shadow-none">
          <span className="size-1.5 rounded-full bg-emerald-600 animate-pulse" />
          Check-in open
        </Badge>
      ) : (
        <Badge variant="outline" className="border-hairline text-ink-muted">
          Check-in closed
        </Badge>
      )}
      {full && <Badge variant="destructive">At capacity</Badge>}
      {event.isPast && !archived && (
        <Badge variant="outline" className="border-hairline text-ink-muted/80">
          Past
        </Badge>
      )}
    </div>
  );
}

function EventIdentity({ event }: { event: AdminEvent }) {
  const archived = event.archivedAt !== null;

  return (
    <>
      <span
        className={cn(
          "font-display text-base block font-bold leading-snug",
          archived ? "text-ink-muted" : "text-navy",
        )}
      >
        {event.title}
      </span>
      <span className="text-ink-muted text-body-sm mt-1 block">
        {formatEventTime(event.startsAt)}
        {event.location ? ` · ${event.location}` : ""}
      </span>
      {archived && (
        <span className="text-ink-muted/80 text-body-sm mt-1 block italic">
          Hidden from members
        </span>
      )}
    </>
  );
}

function EventActions({ event }: { event: AdminEvent }) {
  const utils = api.useUtils();

  // Not just the list: the attendance screen reads `getById`, so it would
  // otherwise keep serving a check-in code this mutation has just revoked, and
  // archiving moves the counts in the overview strip above the table.
  const invalidate = async () => {
    await Promise.all([
      utils.event.listAll.invalidate(),
      utils.event.getById.invalidate({ id: event.id }),
      utils.chapter.overview.invalidate(),
      utils.chapter.attendance.invalidate(),
      revalidatePublicCalendar(),
    ]);
  };

  const toggle = api.event.setCheckInEnabled.useMutation({
    onSuccess: async (updated) => {
      toast.success(
        updated.checkInEnabled ? "Check-in is open." : "Check-in is closed.",
      );
      await invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const archive = api.event.setArchived.useMutation({
    onSuccess: async (updated) => {
      toast.success(updated.archivedAt ? "Event archived." : "Event restored.");
      await invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const archived = event.archivedAt !== null;

  // A shut door on an event that has not happened yet is the one thing in this
  // row worth a solid button. `isPast` comes from the server.
  const openingIsUrgent = !archived && !event.checkInEnabled && !event.isPast;

  return (
    <div className="flex flex-wrap items-center gap-1.5 md:justify-end">
      <Button
        asChild
        variant="outline"
        size="sm"
        className="h-9 min-h-9 rounded-md border-hairline font-semibold text-navy hover:bg-cream"
      >
        <Link href={`/portal/admin/events/${event.id}`}>Attendance</Link>
      </Button>

      {/* Disabled on an archived event because `event.checkIn` refuses one
          outright. */}
      <Button
        size="sm"
        className="h-9 min-h-9 rounded-md font-semibold"
        variant={openingIsUrgent ? "default" : "outline"}
        disabled={toggle.isPending || archived}
        onClick={() =>
          toggle.mutate({ id: event.id, enabled: !event.checkInEnabled })
        }
      >
        {event.checkInEnabled ? "Close check-in" : "Open check-in"}
      </Button>

      <EventDialog
        event={event}
        trigger={
          <Button
            size="sm"
            className="h-9 min-h-9 rounded-md font-semibold text-ink-muted hover:text-navy"
            variant="ghost"
          >
            Edit
          </Button>
        }
      />

      {/* Archiving is reversible on purpose: an event with attendance is
          chapter history and must never be deletable from this screen. */}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="text-ink-muted hover:bg-cream hover:text-navy h-9 min-h-9 rounded-md font-semibold"
            disabled={archive.isPending}
          >
            {archived ? "Restore" : "Archive"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {archived ? "Restore this event?" : "Archive this event?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {archived
                ? `"${event.title}" goes back on the members' list and its code works again.`
                : `"${event.title}" keeps its ${event.attendees} recorded check-ins, but members stop seeing it and its code stops working.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                !archived && buttonVariants({ variant: "destructive" }),
              )}
              onClick={() =>
                archive.mutate({ id: event.id, archived: !archived })
              }
            >
              {archived ? "Yes, restore" : "Yes, archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EventRow({ event }: { event: AdminEvent }) {
  const archived = event.archivedAt !== null;

  return (
    <TableRow className={cn("hover:bg-cream/30 transition-colors", archived && "bg-cream/60 opacity-80")}>
      <TableCell className="py-4 whitespace-normal">
        <EventIdentity event={event} />
      </TableCell>

      <TableCell className="py-4">
        <StatusBadges event={event} />
      </TableCell>

      <TableCell className="text-navy py-4 font-semibold tabular-nums">
        {event.pointsValue} pts
      </TableCell>

      <TableCell className="text-ink-muted py-4 tabular-nums">
        <span className="font-semibold text-navy">{event.attendees}</span>
        {event.maxCheckIns !== null ? ` of ${event.maxCheckIns}` : ""}
      </TableCell>

      <TableCell className="py-4 whitespace-normal">
        <EventActions event={event} />
      </TableCell>
    </TableRow>
  );
}

function EventCard({ event }: { event: AdminEvent }) {
  const archived = event.archivedAt !== null;

  return (
    <li
      className={cn(
        "border-hairline bg-paper/80 shadow-xs rounded-xl border p-5 transition",
        archived && "bg-cream/60 opacity-80",
      )}
    >
      <EventIdentity event={event} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatusBadges event={event} />
        <span className="text-ink-muted text-body-sm tabular-nums">
          · {event.pointsValue} pts · {event.attendees}
          {event.maxCheckIns !== null ? ` of ${event.maxCheckIns}` : ""} checked in
        </span>
      </div>
      <div className="border-hairline mt-4 border-t pt-3">
        <EventActions event={event} />
      </div>
    </li>
  );
}

export function AdminEvents() {
  const [filter, setFilter] = useState<Filter>("Open");
  // Cap matches the procedure max so the filter still sees the chapter.
  const listing = api.event.listAll.useQuery({ limit: 200, offset: 0 });

  const allEvents = listing.data?.events ?? [];

  // `isPast` is decided server-side against the same cutoff the check-in door
  // uses, so this list never disagrees with what a member can actually enter.
  const visible = visibleEvents(allEvents, filter);

  const createAction = (
    <EventDialog
      trigger={
        <Button className="bg-navy hover:bg-navy-deep min-h-10 rounded-lg px-4 font-semibold text-white shadow-xs">
          + New event
        </Button>
      }
    />
  );

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {/* One track, four positions. */}
        <div
          role="group"
          aria-label="Filter events"
          className="ring-hairline bg-cream flex max-w-full gap-1 overflow-x-auto overscroll-x-contain rounded-xl p-1 ring-1"
        >
          {filters.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={filter === option ? "default" : "ghost"}
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
              className={cn(
                "text-xs min-h-9 shrink-0 rounded-lg px-3.5 font-semibold transition-all",
                filter === option
                  ? "bg-navy text-white shadow-xs"
                  : "text-ink-muted hover:bg-paper hover:text-navy",
              )}
            >
              {option}
            </Button>
          ))}
        </div>

        {createAction}
      </div>

      <div className="mt-8">
        {listing.isPending ? (
          <>
            <p className="sr-only">Loading events.</p>
            <div aria-hidden="true" className="border-hairline border-y">
              {[0, 1, 2].map((row) => (
                <div
                  key={row}
                  className="border-hairline border-b px-3 py-6 last:border-0"
                >
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="mt-3 h-3 w-1/2" />
                </div>
              ))}
            </div>
          </>
        ) : listing.error ? (
          <Alert variant="destructive">
            <AlertTitle>Could not load events.</AlertTitle>
            <AlertDescription>{listing.error.message}</AlertDescription>
          </Alert>
        ) : visible.length > 0 ? (
          <>
            {/* What am I looking at, and how much of it. */}
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <h2 className="text-eyebrow tracking-caps text-ink-muted font-semibold uppercase">
                {filter === "All" ? "All events" : `${filter} events`}
              </h2>
              <p className="text-ink-muted text-body-sm tabular-nums">
                <span className="text-navy font-semibold">
                  {visible.length}
                </span>{" "}
                of {allEvents.length} on record
              </p>
            </div>

            <ul className="mt-4 grid gap-4 md:hidden">
              {visible.map((event) => (
                <EventCard key={event.id} event={event} />
              ))}
            </ul>

            <div className="hidden md:block">
              <div className="border-hairline bg-paper/50 overflow-hidden rounded-xl border shadow-xs">
                <Table label="Events">
                  <TableHeader className="bg-cream/40 border-hairline border-b">
                    <TableRow>
                      <TableHead className="font-semibold text-ink-muted">Event</TableHead>
                      <TableHead className="font-semibold text-ink-muted">Status</TableHead>
                      <TableHead className="font-semibold text-ink-muted">Points</TableHead>
                      <TableHead className="font-semibold text-ink-muted">Checked in</TableHead>
                      <TableHead className="text-right font-semibold text-ink-muted">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((event) => (
                      <EventRow key={event.id} event={event} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </>
        ) : (
          <div className="border-hairline bg-cream rounded-lg border border-dashed px-6 py-14 text-center">
            <h3 className="font-display text-navy text-h3 font-bold text-balance">
              {filter === "All"
                ? "No events yet."
                : `No ${filter.toLowerCase()} events.`}
            </h3>
            <p className="text-ink-muted text-body max-w-measure mx-auto mt-3">
              Creating one generates its check-in code straight away, so it is
              ready to put on a screen.
            </p>
            <div className="mt-7 flex flex-wrap justify-center gap-4">
              {createAction}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
