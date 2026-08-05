"use client";

import { useState } from "react";

import { Eyebrow } from "~/app/_components/ui";
import { EmptyState } from "~/app/portal/_components/portal-ui";
import { formatEventTime } from "~/app/portal/_lib/format";
import { site } from "~/data/site";
import { api } from "~/trpc/react";

/** What officers read out. Bare host, because it goes on a slide. */
const checkInHost = site.url.replace(/^https?:\/\//, "");

/** RFC 4180: wrap in quotes, and double any quote already inside. */
function csvCell(value: string | number | null) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function EventAttendance({ eventId }: { eventId: string }) {
  const utils = api.useUtils();
  const [email, setEmail] = useState("");
  const detail = api.event.getById.useQuery({ id: eventId });

  const invalidate = async () => {
    await Promise.all([
      utils.event.getById.invalidate({ id: eventId }),
      utils.event.listAll.invalidate(),
    ]);
  };

  const manual = api.event.manualCheckIn.useMutation({
    onSuccess: async () => {
      setEmail("");
      await invalidate();
    },
  });
  const remove = api.event.removeCheckIn.useMutation({ onSuccess: invalidate });
  const rotate = api.event.regenerateCode.useMutation({
    onSuccess: invalidate,
  });

  if (detail.isPending) {
    return <p className="text-ink-muted text-body-sm">Loading event...</p>;
  }
  if (detail.error) {
    return (
      <p className="text-sm font-medium text-red-900">{detail.error.message}</p>
    );
  }

  const { event, roster } = detail.data;

  const downloadCsv = () => {
    const rows = [
      ["Name", "Email", "Method", "Points", "Checked in"],
      ...roster.map((row) => [
        row.name ?? "",
        row.email,
        row.method,
        row.pointsEarned,
        row.checkedInAt.toISOString(),
      ]),
    ];
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${event.title.replace(/[^\w-]+/g, "-")}-attendance.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <h1 className="font-display text-navy text-h1 text-balance font-bold tracking-tight">
        {event.title}
      </h1>
      <p className="text-ink-muted text-lead mt-3">
        {formatEventTime(event.startsAt)}
        {event.location ? ` · ${event.location}` : ""}
      </p>

      {/* The projector panel. Sized to be read from the back of a lecture hall,
          which is the entire reason the code alphabet has no I, L, O, U, 0 or 1. */}
      <div className="rounded-panel bg-navy navy-wash mt-10 px-6 py-10 text-center sm:px-12">
        <Eyebrow tone="onNavy" rule={false} className="justify-center">
          Check in at {checkInHost}/portal
        </Eyebrow>
        <p className="font-display text-gold-bright mt-5 text-5xl font-bold tracking-[0.18em] sm:text-7xl">
          {event.checkInCode}
        </p>
        <p className="mt-6 text-white/70">
          {event.checkInEnabled
            ? "Check-in is open."
            : "Check-in is closed — members entering this code will be turned away."}
        </p>
        <button
          type="button"
          onClick={() => rotate.mutate({ id: event.id })}
          disabled={rotate.isPending}
          className="text-body-sm mt-6 font-semibold text-white/70 underline underline-offset-4 transition hover:text-white disabled:opacity-50"
        >
          Rotate the code
        </button>
      </div>
      <p className="text-ink-muted text-body-sm mt-3">
        Anyone holding this code can check in. Rotating it revokes a
        photographed slide immediately.
      </p>

      <div className="mt-12 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow tone="gold">Attendance</Eyebrow>
          <h2 className="font-display text-navy text-h2 mt-4 font-bold">
            {roster.length} checked in
            {event.maxCheckIns !== null ? ` of ${event.maxCheckIns}` : ""}
          </h2>
        </div>
        {roster.length > 0 && (
          <button
            type="button"
            onClick={downloadCsv}
            className="ring-hairline text-navy rounded-full px-6 py-2.5 text-sm font-semibold ring-1 transition"
          >
            Export CSV
          </button>
        )}
      </div>

      <form
        className="mt-8 flex flex-wrap items-end gap-3"
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          if (!email.trim()) return;
          manual.mutate({ eventId: event.id, email });
        }}
      >
        <div className="min-w-64 flex-1">
          <label
            htmlFor="manual-email"
            className="text-eyebrow tracking-caps text-ink-muted font-semibold uppercase"
          >
            Add someone by email
          </label>
          <input
            id="manual-email"
            type="email"
            value={email}
            onChange={(changeEvent) => setEmail(changeEvent.target.value)}
            placeholder="member@gatech.edu"
            className="border-hairline bg-paper text-ink text-body-sm mt-2 w-full rounded-xl border px-4 py-2.5"
          />
        </div>
        <button
          type="submit"
          disabled={manual.isPending}
          className="bg-navy hover:bg-navy-deep rounded-full px-6 py-2.5 text-sm font-semibold text-white transition disabled:opacity-50"
        >
          {manual.isPending ? "Adding..." : "Add"}
        </button>
      </form>
      {manual.error && (
        <p className="mt-3 text-sm font-medium text-red-900">
          {manual.error.message}
        </p>
      )}
      <p className="text-ink-muted text-body-sm mt-3">
        They have to have signed in to the portal at least once, and they earn
        the same {event.pointsValue} points as everyone who used the code.
      </p>

      <div className="mt-10">
        {roster.length > 0 ? (
          <ul role="list" className="border-hairline border-t">
            {roster.map((row) => (
              <li
                key={row.userId}
                className="border-hairline flex flex-wrap items-center gap-x-6 gap-y-2 border-b py-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-navy font-semibold">
                    {row.name ?? row.email}
                  </p>
                  <p className="text-ink-muted text-body-sm mt-0.5">
                    {row.email} · {formatEventTime(row.checkedInAt)}
                    {row.method === "manual" ? " · added by an officer" : ""}
                  </p>
                </div>
                <span className="text-gold-ink text-body-sm font-semibold">
                  +{row.pointsEarned}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    remove.mutate({ eventId: event.id, userId: row.userId })
                  }
                  disabled={remove.isPending}
                  className="text-ink-muted text-body-sm font-semibold transition hover:text-red-900 disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="Nobody has checked in yet."
            body="Put the code on the screen and it will fill in as members enter it."
          />
        )}
      </div>
    </div>
  );
}
