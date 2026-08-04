"use client";

import Link from "next/link";
import { useState } from "react";

import { EmptyState } from "~/app/portal/_components/portal-ui";
import {
  formatEventTime,
  fromLocalInputValue,
  toLocalInputValue,
} from "~/app/portal/_lib/format";
import { api, type RouterOutputs } from "~/trpc/react";

type AdminEvent = RouterOutputs["event"]["listAll"][number];

const filters = ["Open", "Past", "Archived", "All"] as const;
type Filter = (typeof filters)[number];

/** FormData entries are `string | File`; only the string case is ever real here. */
const text = (value: FormDataEntryValue | null) =>
  typeof value === "string" ? value.trim() : "";

const field =
  "border-hairline bg-paper text-ink mt-2 w-full rounded-xl border px-4 py-2.5 text-body-sm";
const label =
  "text-eyebrow tracking-caps text-ink-muted font-semibold uppercase";

/**
 * Create and edit. The points field is the reason this form exists in its own
 * component rather than inline: an event whose value is never set is an event
 * that quietly awards the default forever.
 */
function EventForm({
  event,
  onDone,
}: {
  event?: AdminEvent;
  onDone: () => void;
}) {
  const utils = api.useUtils();
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    await utils.event.listAll.invalidate();
    onDone();
  };

  const create = api.event.create.useMutation({
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });
  const update = api.event.update.useMutation({
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });

  const pending = create.isPending || update.isPending;

  return (
    <form
      className="rounded-card ring-hairline bg-paper shadow-soft p-6 ring-1"
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault();
        setError(null);

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
      <h3 className="font-display text-navy text-h3 font-bold">
        {event ? "Edit event" : "New event"}
      </h3>

      <div className="mt-6 grid gap-5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={label} htmlFor="title">
            Title
          </label>
          <input
            id="title"
            name="title"
            required
            maxLength={200}
            defaultValue={event?.title ?? ""}
            className={field}
          />
        </div>

        <div>
          <label className={label} htmlFor="startsAt">
            Starts (Atlanta time)
          </label>
          <input
            id="startsAt"
            name="startsAt"
            type="datetime-local"
            required
            defaultValue={event ? toLocalInputValue(event.startsAt) : undefined}
            className={field}
          />
        </div>

        <div>
          <label className={label} htmlFor="location">
            Location
          </label>
          <input
            id="location"
            name="location"
            maxLength={200}
            defaultValue={event?.location ?? ""}
            className={field}
          />
        </div>

        <div>
          <label className={label} htmlFor="pointsValue">
            Points for attending
          </label>
          <input
            id="pointsValue"
            name="pointsValue"
            type="number"
            min={0}
            max={100}
            required
            defaultValue={event?.pointsValue ?? 10}
            className={field}
          />
        </div>

        <div>
          <label className={label} htmlFor="maxCheckIns">
            Capacity (blank for none)
          </label>
          <input
            id="maxCheckIns"
            name="maxCheckIns"
            type="number"
            min={1}
            defaultValue={event?.maxCheckIns ?? ""}
            className={field}
          />
        </div>

        <div className="sm:col-span-2">
          <label className={label} htmlFor="description">
            Description
          </label>
          <textarea
            id="description"
            name="description"
            rows={3}
            maxLength={1000}
            defaultValue={event?.description ?? ""}
            className={field}
          />
        </div>
      </div>

      {/* Editing the value re-prices future attendance only. Rows already
          written keep what they were stamped with, and officers should know
          that before they change a number. */}
      {event && (
        <p className="text-ink-muted text-body-sm mt-5">
          Changing the points here affects check-ins from now on. Members who
          already attended keep what they earned.
        </p>
      )}

      {error && (
        <p className="mt-5 text-sm font-medium text-red-900">{error}</p>
      )}

      <div className="mt-7 flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={pending}
          className="bg-gold-bright text-navy hover:bg-gold rounded-full px-6 py-2.5 text-sm font-semibold transition disabled:opacity-50"
        >
          {pending ? "Saving..." : event ? "Save changes" : "Create event"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="ring-hairline text-navy rounded-full px-6 py-2.5 text-sm font-semibold ring-1 transition"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function EventRow({ event }: { event: AdminEvent }) {
  const utils = api.useUtils();
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const invalidate = () => utils.event.listAll.invalidate();
  const toggle = api.event.setCheckInEnabled.useMutation({
    onSuccess: invalidate,
  });
  const rotate = api.event.regenerateCode.useMutation({
    onSuccess: invalidate,
  });
  const archive = api.event.setArchived.useMutation({ onSuccess: invalidate });

  if (editing) {
    return (
      <li className="py-5">
        <EventForm event={event} onDone={() => setEditing(false)} />
      </li>
    );
  }

  const archived = event.archivedAt !== null;

  return (
    <li className="border-hairline border-b py-6">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-navy text-h3 font-bold">
            {event.title}
          </h3>
          <p className="text-ink-muted text-body-sm mt-1.5">
            {formatEventTime(event.startsAt)}
            {event.location ? ` · ${event.location}` : ""}
          </p>
          <p className="text-ink-muted text-body-sm mt-1">
            {event.pointsValue} pts · {event.attendees} checked in
            {event.maxCheckIns !== null ? ` of ${event.maxCheckIns}` : ""}
          </p>
        </div>

        <div className="text-right">
          <p className={label}>{archived ? "Archived" : "Check-in code"}</p>
          <p className="font-display text-navy mt-1.5 text-xl font-bold tracking-[0.2em]">
            {event.checkInCode}
          </p>
          <p
            className={`text-body-sm mt-1 font-semibold ${
              event.checkInEnabled && !archived
                ? "text-gold-ink"
                : "text-ink-muted"
            }`}
          >
            {archived
              ? "Hidden from members"
              : event.checkInEnabled
                ? "Open"
                : "Closed"}
          </p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2">
        <Link
          href={`/portal/admin/events/${event.id}`}
          className="text-navy text-body-sm font-semibold"
        >
          Attendance
        </Link>
        <button
          type="button"
          onClick={() =>
            toggle.mutate({ id: event.id, enabled: !event.checkInEnabled })
          }
          disabled={toggle.isPending}
          className="text-ink-muted hover:text-navy text-body-sm font-semibold transition disabled:opacity-50"
        >
          {event.checkInEnabled ? "Close check-in" : "Open check-in"}
        </button>
        <button
          type="button"
          onClick={() => rotate.mutate({ id: event.id })}
          disabled={rotate.isPending}
          className="text-ink-muted hover:text-navy text-body-sm font-semibold transition disabled:opacity-50"
        >
          New code
        </button>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-ink-muted hover:text-navy text-body-sm font-semibold transition"
        >
          Edit
        </button>

        {/* Archiving is the only destructive action here, and it is reversible
            on purpose: an event with attendance is chapter history and must
            never be deletable from this screen. */}
        {confirmArchive ? (
          <span className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                archive.mutate({ id: event.id, archived: !archived });
                setConfirmArchive(false);
              }}
              className="text-body-sm font-semibold text-red-900"
            >
              {archived ? "Yes, restore" : "Yes, archive"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmArchive(false)}
              className="text-ink-muted text-body-sm font-semibold"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmArchive(true)}
            className="text-ink-muted hover:text-navy text-body-sm font-semibold transition"
          >
            {archived ? "Restore" : "Archive"}
          </button>
        )}
      </div>
    </li>
  );
}

export function AdminEvents() {
  const [filter, setFilter] = useState<Filter>("Open");
  const [creating, setCreating] = useState(false);
  const listing = api.event.listAll.useQuery();

  // `isPast` is decided server-side against the same cutoff the check-in door
  // uses, so this list never disagrees with what a member can actually enter.
  const visible = (listing.data ?? []).filter((event) => {
    const archived = event.archivedAt !== null;
    if (filter === "Archived") return archived;
    if (filter === "All") return true;
    if (archived) return false;
    return filter === "Past" ? event.isPast : !event.isPast;
  });

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap gap-2">
          {filters.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
              className={`text-body-sm rounded-full px-4 py-2 font-semibold transition ${
                filter === option
                  ? "bg-navy text-white"
                  : "ring-hairline text-ink-muted hover:text-navy ring-1"
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="bg-gold-bright text-navy hover:bg-gold rounded-full px-6 py-2.5 text-sm font-semibold transition"
          >
            New event
          </button>
        )}
      </div>

      {creating && (
        <div className="mt-8">
          <EventForm onDone={() => setCreating(false)} />
        </div>
      )}

      <div className="mt-10">
        {listing.isPending ? (
          <p className="text-ink-muted text-body-sm">Loading events...</p>
        ) : listing.error ? (
          <p className="text-sm font-medium text-red-900">
            {listing.error.message}
          </p>
        ) : visible.length > 0 ? (
          <ul role="list" className="border-hairline border-t">
            {visible.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ul>
        ) : (
          <EmptyState
            title={`No ${filter.toLowerCase()} events.`}
            body="Creating one generates its check-in code straight away, so it is ready to put on a screen."
          />
        )}
      </div>
    </div>
  );
}
