import { Button, Section } from "~/app/_components/ui";
import { MemberCard } from "~/app/portal/_components/member-card";
import {
  EmptyState,
  PointsPill,
  PortalHeader,
} from "~/app/portal/_components/portal-ui";
import { formatEventTime, formatMonth } from "~/app/portal/_lib/format";
import { requireSession } from "~/app/portal/_lib/session";
import { api } from "~/trpc/server";

export default async function MyEventsPage() {
  const session = await requireSession("/portal/events");

  const [attended, stats] = await Promise.all([
    api.event.myEvents(),
    api.event.myStats(),
  ]);

  return (
    <>
      <PortalHeader
        eyebrow="Your history"
        title="Events you have been to."
        body="Every check-in the chapter has on record for you, newest first, with what each one was worth at the time."
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

      <Section size="sm">
        {attended.length > 0 ? (
          <ul role="list" className="border-hairline border-t">
            {attended.map((event) => (
              <li
                key={event.id}
                className="border-hairline hover:bg-cream flex flex-wrap items-center gap-x-6 gap-y-3 border-b px-1 py-6 transition duration-200 sm:px-3"
              >
                <div className="min-w-0 flex-1">
                  <h2 className="font-display text-navy text-h3 font-bold">
                    {event.title}
                  </h2>
                  <p className="text-ink-muted text-body-sm mt-1.5">
                    {formatEventTime(event.startsAt)}
                    {event.location ? ` · ${event.location}` : ""}
                  </p>
                  {/* Worth saying out loud: a member who was signed in by an
                      officer never saw a code and would otherwise wonder how
                      the row got there. */}
                  {event.method === "manual" && (
                    <p className="text-ink-muted/80 text-body-sm mt-1 italic">
                      Added by an officer
                    </p>
                  )}
                </div>
                <PointsPill points={event.pointsEarned} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="Nothing on your record yet."
            body="Points start the first time you check in at an event. Membership itself is free — this only tracks attendance."
          >
            <Button href="/portal/check-in">Enter a check-in code</Button>
            <Button href="/events" variant="outline">
              See the calendar
            </Button>
          </EmptyState>
        )}
      </Section>
    </>
  );
}
