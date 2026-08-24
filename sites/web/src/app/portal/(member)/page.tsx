import { ArrowRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { EventRows } from "~/app/portal/_components/event-rows";
import { Leaderboard } from "~/app/portal/_components/leaderboard";
import { MemberCard } from "~/app/portal/_components/member-card";
import { SignOutButton } from "~/app/portal/_components/portal-ui";
import { formatMonth } from "~/app/portal/_lib/format";
import { requireSession } from "~/app/portal/_lib/session";
import { Card } from "~/components/ui/card";
import { Separator } from "~/components/ui/separator";
import { api } from "~/trpc/server";

export const metadata: Metadata = {
  title: "My card",
};

/**
 * The whole member portal, on one screen: the card is the heading, the check-in
 * is the one loud control, everything else is rows.
 */
export default async function PortalDashboard() {
  const session = await requireSession("/portal");
  const isOfficer = session.user.role === "ADMIN";

  const [stats, attended, upcoming] = await Promise.all([
    api.event.myStats(),
    api.event.myEvents(),
    api.event.upcoming(),
  ]);

  const open = upcoming.filter((event) => event.checkInEnabled);

  return (
    <div className="max-w-content mx-auto px-5 py-10 sm:px-6 sm:py-14">
      <div className="grid gap-10 lg:grid-cols-[26rem_minmax(0,1fr)] lg:items-start lg:gap-14">
        <MemberCard
          name={session.user.name ?? session.user.email ?? "Member"}
          memberSince={
            stats.memberSince ? formatMonth(stats.memberSince) : null
          }
          totalPoints={stats.totalPoints}
          totalEvents={stats.totalEvents}
        />

        <div>
          <Card className="bg-navy hover:bg-navy-deep group gap-0 rounded-lg border-0 py-0 transition-colors duration-300">
            <Link
              href={isOfficer ? "/portal/admin" : "/portal/check-in"}
              className="flex items-center justify-between gap-6 px-5 py-5 sm:px-7 sm:py-6"
            >
              <span>
                <span className="font-display block text-xl font-bold text-white">
                  {isOfficer ? "Open check-in" : "Check in"}
                </span>
                <span className="mt-1 block text-white/70">
                  {isOfficer
                    ? "Put the QR on a screen. Check yourself in from the event."
                    : "Scan the QR on the screen, or type the code"}
                </span>
              </span>
              <ArrowRight
                aria-hidden="true"
                className="text-gold-bright size-6 shrink-0 transition-transform duration-300 group-hover:translate-x-1"
              />
            </Link>
          </Card>

          <Card className="border-hairline mt-3 gap-0 rounded-lg py-0 shadow-none">
            <Link
              href={
                isOfficer ? "/portal/admin/mentorship" : "/portal/mentorship"
              }
              className="flex items-center justify-between gap-6 px-5 py-5 sm:px-7"
            >
              <span>
                <span className="font-display text-navy block text-lg font-bold">
                  Mentor families
                </span>
                <span className="text-ink-muted mt-1 block text-sm">
                  Sign up as a mentor or mentee. Family points stay off your
                  event card.
                </span>
              </span>
              <ArrowRight
                aria-hidden="true"
                className="text-gold-ink size-5 shrink-0"
              />
            </Link>
          </Card>

          <EventRows
            title="Open now"
            empty={
              <p className="text-ink-muted text-body-sm text-center">
                Nothing is open at the moment. Check-in opens when an officer
                starts an event.
              </p>
            }
            rows={open.map((event) => ({
              key: event.id,
              title: event.title,
              at: event.startsAt,
              location: event.location,
              points: event.pointsValue,
              done: event.attendedAt !== null,
            }))}
          />

          <EventRows
            title="Where you have been"
            count={
              stats.totalEvents > 0
                ? `${stats.totalEvents} · ${stats.totalPoints} pts`
                : undefined
            }
            empty={
              <div className="text-center">
                <p className="font-display text-navy text-h3 font-bold">
                  No check-ins yet.
                </p>
                <p className="text-ink-muted text-body max-w-measure mx-auto mt-3">
                  Your first one takes about ten seconds.{" "}
                  {open.length > 0
                    ? `${open.length} ${open.length === 1 ? "event is" : "events are"} open right now — check into one and it lands here.`
                    : "Check-in opens when an officer starts an event."}
                </p>
              </div>
            }
            totalCount={stats.totalEvents}
            rows={attended.map((event) => ({
              key: event.id,
              title: event.title,
              at: event.startsAt,
              location: event.location,
              points: event.pointsEarned,
              note: event.method === "manual" ? "Added by an officer" : null,
            }))}
          />

          <Leaderboard />

          <Separator className="mt-12" />
          <div className="flex flex-wrap items-center justify-between gap-4 pt-6">
            <p className="text-ink-muted text-body-sm">
              {session.user.email}
            </p>
            <SignOutButton />
          </div>
        </div>
      </div>
    </div>
  );
}
