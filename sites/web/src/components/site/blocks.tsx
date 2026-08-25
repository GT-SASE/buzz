import { Badge } from "~/components/ui/badge";
import { InitialDisc } from "~/components/site/brand";
import { Card } from "~/components/site/layout";
import type { BoardMember } from "~/data/content";
import { cn } from "~/lib/utils";

/**
 * One board seat, as a roster row rather than a card with an empty photo frame.
 * The disc waits for a real name: a monogram derived from the role renders "PR"
 * beside a heading that already spells out "President".
 */
export function BoardRow({ member }: { member: BoardMember }) {
  return (
    <li
      className={cn(
        "border-hairline border-b transition duration-200",
        member.email && "hover:bg-cream",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-5 sm:px-6">
        {member.name && <InitialDisc label={member.name} />}
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-navy text-h3 font-bold">
            {member.role}
          </h3>
          <p className="text-ink-muted text-body-sm mt-1 flex flex-wrap items-center gap-2">
            {member.name ? (
              <>
                {member.name} · {member.major}
              </>
            ) : (
              <>
                {member.major}
                <Badge
                  variant="secondary"
                  className="text-eyebrow tracking-caps uppercase"
                >
                  Seat open
                </Badge>
              </>
            )}
          </p>
        </div>
        {member.email && (
          <a
            href={`mailto:${member.email}`}
            className="text-navy decoration-gold hover:text-gold-ink text-body-sm min-h-11 py-3 font-semibold break-all underline decoration-2 underline-offset-4 transition"
          >
            {member.email}
          </a>
        )}
      </div>
    </li>
  );
}

/**
 * One calendar entry. Identical on the homepage and /events. Location and body
 * are nullable because the calendar comes from the officer tools, where both
 * columns are optional.
 */
export function EventCard({
  event,
}: {
  event: {
    title: string;
    displayDate: string;
    location: string | null;
    description: string | null;
  };
}) {
  return (
    <Card className="flex h-full flex-col">
      <p className="text-gold-ink text-eyebrow tracking-masthead font-semibold uppercase">
        {event.displayDate}
      </p>
      <h3 className="font-display text-navy text-h3 mt-5 font-bold">
        {event.title}
      </h3>
      {event.location && (
        <p className="text-gold-ink text-body-sm mt-2 font-semibold">
          {event.location}
        </p>
      )}
      {event.description && (
        <p className="text-ink-muted text-body-sm mt-4">{event.description}</p>
      )}
    </Card>
  );
}

/** The three mission pillars. Used on / and /about. */
export function PillarGrid({
  pillars,
}: {
  pillars: readonly { title: string; body: string }[];
}) {
  return (
    <div className="stagger grid gap-x-10 gap-y-12 md:grid-cols-3">
      {pillars.map((pillar) => (
        <div key={pillar.title}>
          <p
            aria-hidden="true"
            className="hex-face bg-gold-bright size-3"
          />
          <span className="bg-gold/40 mt-5 block h-px w-full" />
          <h3 className="font-display text-navy text-h3 mt-6 font-bold">
            {pillar.title}
          </h3>
          <p className="text-ink-muted text-body mt-3">{pillar.body}</p>
        </div>
      ))}
    </div>
  );
}
