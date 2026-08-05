import Link from "next/link";

import { Button, Card, Eyebrow, Section, TextLink } from "~/app/_components/ui";
import { MemberCard } from "~/app/portal/_components/member-card";
import {
  EmptyState,
  PointsPill,
  PortalHeader,
  SignOutButton,
} from "~/app/portal/_components/portal-ui";
import {
  formatDate,
  formatEventTime,
  formatMonth,
} from "~/app/portal/_lib/format";
import { requireSession } from "~/app/portal/_lib/session";
import { api } from "~/trpc/server";

export default async function PortalDashboard() {
  const session = await requireSession("/portal");

  const [stats, attended, upcoming] = await Promise.all([
    api.event.myStats(),
    api.event.myEvents(),
    api.event.upcoming(),
  ]);

  const firstName = session.user.name?.split(/\s+/)[0];
  const recent = attended.slice(0, 3);
  const open = upcoming.filter((event) => event.checkInEnabled);

  return (
    <>
      <PortalHeader
        eyebrow="Member portal"
        title={firstName ? `Welcome back, ${firstName}.` : "Welcome back."}
        body="Every event you attend is worth points. Check in at the door with the code the officers put on the screen."
        aside={
          <MemberCard
            name={session.user.name ?? session.user.email ?? "Member"}
            memberSince={
              stats.memberSince ? formatMonth(stats.memberSince) : null
            }
            totalPoints={stats.totalPoints}
            totalEvents={stats.totalEvents}
          />
        }
      />

      <Section
        size="sm"
        eyebrow="Next up"
        title="What is open right now."
        lead="Events still accepting check-ins. Anything you have already been to is marked."
      >
        {open.length > 0 ? (
          <ul role="list" className="stagger grid gap-6 md:grid-cols-2">
            {open.map((event) => (
              <li key={event.id}>
                <Card className="flex h-full flex-col">
                  <div className="flex items-start justify-between gap-4">
                    <p className="bg-parchment text-navy text-eyebrow tracking-caps inline-flex w-fit rounded-full px-3.5 py-1.5 font-semibold uppercase">
                      {formatEventTime(event.startsAt)}
                    </p>
                    {event.attendedAt ? (
                      <span className="text-gold-ink text-body-sm font-semibold">
                        Checked in
                      </span>
                    ) : (
                      <PointsPill points={event.pointsValue} />
                    )}
                  </div>
                  <h3 className="font-display text-navy text-h3 mt-5 font-bold">
                    {event.title}
                  </h3>
                  {event.location && (
                    <p className="text-gold-ink text-body-sm mt-2 font-semibold">
                      {event.location}
                    </p>
                  )}
                  {event.description && (
                    <p className="text-ink-muted text-body-sm mt-4">
                      {event.description}
                    </p>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="Nothing open at the moment."
            body="Check-in opens when an officer starts an event. The public calendar has what is coming this semester."
          >
            <Button href="/events" variant="outline">
              See the calendar
            </Button>
          </EmptyState>
        )}

        <div className="mt-10">
          <Button href="/portal/check-in">I have a check-in code</Button>
        </div>
      </Section>

      <Section
        size="sm"
        className="bg-cream border-hairline border-y"
        eyebrow="Your history"
        title="Where you have been."
      >
        {recent.length > 0 ? (
          <>
            <ul role="list" className="border-hairline border-t">
              {recent.map((event) => (
                <li
                  key={event.id}
                  className="border-hairline flex flex-wrap items-center gap-x-5 gap-y-2 border-b px-1 py-5"
                >
                  <div className="min-w-0 flex-1">
                    <h3 className="font-display text-navy text-h3 font-bold">
                      {event.title}
                    </h3>
                    <p className="text-ink-muted text-body-sm mt-1">
                      {formatDate(event.startsAt)}
                      {event.location ? ` · ${event.location}` : ""}
                    </p>
                  </div>
                  <PointsPill points={event.pointsEarned} />
                </li>
              ))}
            </ul>
            <div className="mt-8">
              <TextLink href="/portal/events">
                All {stats.totalEvents} events you have attended
              </TextLink>
            </div>
          </>
        ) : (
          <EmptyState
            title="No check-ins yet."
            body="Your first one takes about ten seconds — an officer reads out a code at the start of the meeting."
          >
            <Button href="/events" variant="outline">
              Find a meeting
            </Button>
          </EmptyState>
        )}
      </Section>

      <section className="max-w-content mx-auto flex flex-wrap items-center justify-between gap-4 px-5 py-10 sm:px-6">
        <div>
          <Eyebrow tone="muted" rule={false}>
            Signed in as
          </Eyebrow>
          <p className="text-ink-muted text-body-sm mt-2">
            {session.user.email}
            {session.user.role === "ADMIN" && (
              <>
                {" · "}
                <Link href="/portal/admin" className="text-navy font-semibold">
                  Officer tools
                </Link>
              </>
            )}
          </p>
        </div>
        <SignOutButton />
      </section>
    </>
  );
}
