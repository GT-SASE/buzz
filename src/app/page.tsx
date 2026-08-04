import Image from "next/image";

import { Icon } from "~/app/_components/icons";
import { JsonLd } from "~/app/_components/json-ld";
import {
  BoardRow,
  Button,
  Card,
  EventCard,
  Eyebrow,
  Marquee,
  PhotoFrame,
  PhotoMosaic,
  PillarGrid,
  Section,
  StatValue,
  TextLink,
  ThemeBadge,
} from "~/app/_components/ui";
import {
  board,
  firstMonth,
  marqueeItems,
  meeting,
  missionPillars,
  programs,
  stats,
  upcomingEvents,
} from "~/data/content";
import { galleryPhotos, photos } from "~/data/photos";
import { site } from "~/data/site";
import { pageMetadata } from "~/lib/seo";

// `~/data/content` splits upcoming from past against `Date.now()` at module
// scope, so a fully prerendered build freezes that split at build time and a
// finished event keeps rendering as upcoming — here in both the hero card and
// the calendar band — until someone redeploys. Hourly rerendering bounds it.
export const revalidate = 3600;

export const metadata = pageMetadata({
  title: `${site.name} — ${site.tagline}`,
  description:
    "The Georgia Tech chapter of the Society of Asian Scientists and Engineers. Mentor families, recruiter resume workshops, semester-long technical projects, and Taste of SASE — open to every Georgia Tech student, any major, any year.",
  path: "/",
});

export default function Home() {
  const nextUp = upcomingEvents[0];
  // The hero already prints the soonest event, so the calendar band starts at
  // the one after it — otherwise the same event ran twice on one page.
  const upcoming = upcomingEvents.slice(1, 4);

  return (
    <>
      {/* Sitelinks search box + the site node the other graphs hang off. */}
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "WebSite",
          "@id": `${site.url}/#website`,
          url: site.url,
          name: site.name,
          alternateName: site.shortName,
          description: site.description,
          publisher: { "@id": `${site.url}/#organization` },
          inLanguage: "en-US",
        }}
      />
      {/* Hero. No photo frame: the second column carries the answer to the
          question a prospective member actually arrives with. */}
      <section className="bg-cream paper-wash aurora relative overflow-hidden">
        <div className="max-w-content relative mx-auto grid gap-14 px-5 pt-20 pb-24 sm:px-6 lg:grid-cols-[1.15fr_0.85fr] lg:items-center lg:pt-28 lg:pb-32">
          <div className="rise">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
              <ThemeBadge />
              <Eyebrow tone="gold" rule={false}>
                Georgia Tech Chapter
              </Eyebrow>
            </div>
            <h1 className="font-display text-navy text-hero mt-7 font-bold tracking-tight">
              <span className="line-mask">
                <span>Find your people</span>
              </span>
              <span className="line-mask">
                <span className="text-gradient">in STEM.</span>
              </span>
            </h1>
            <p className="text-lead text-ink-muted max-w-measure mt-7">
              We are the Georgia Tech chapter of the Society of Asian Scientists
              and Engineers. Mentor families, recruiter workshops, semester-long
              build teams, and Taste of SASE — open to every student on campus,
              any major, any background.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-4">
              <Button href="/join">Become a member</Button>
              <Button href="/programs" variant="outline">
                What we do
              </Button>
            </div>
          </div>

          {/* Photo carries the column; the meeting card overlaps its lower
              edge so the answer to "when do you meet" rides on top of it. */}
          <div className="rise" style={{ animationDelay: "140ms" }}>
            <PhotoFrame
              photo={photos.conventionDelegation}
              priority
              sizes="(min-width: 1024px) 42vw, 100vw"
              className="aspect-[4/3] lg:aspect-[5/4]"
            />
            <Card className="bg-paper relative z-10 mx-4 -mt-14 sm:mx-8 lg:mx-6">
              <Eyebrow tone="muted" rule={false}>
                Come to a meeting
              </Eyebrow>
              <p className="font-display text-navy text-h2 mt-4 font-bold">
                {meeting.cadence}
              </p>
              <p className="text-ink-muted text-body mt-2">
                {meeting.day}s at {meeting.time} during the semester.
              </p>
              <p className="text-ink-muted text-body-sm mt-1">
                {meeting.location}
              </p>

              {nextUp && (
                <div className="border-hairline mt-7 border-t pt-6">
                  <Eyebrow tone="gold" rule={false}>
                    Next up
                  </Eyebrow>
                  <p className="font-display text-navy text-h3 mt-3 font-bold">
                    {nextUp.title}
                  </p>
                  <p className="text-ink-muted text-body-sm mt-1">
                    {nextUp.displayDate} · {nextUp.location}
                  </p>
                </div>
              )}

              <div className="mt-7">
                <TextLink href="/events">See the full calendar</TextLink>
              </div>
            </Card>
          </div>
        </div>
      </section>

      <Marquee items={marqueeItems} />

      {/* Stats, over a photograph of the membership they describe. The image is
          decorative here — the figures themselves carry the information — so it
          takes an empty alt and sits behind a heavy scrim that keeps the gold
          numerals above 6:1. */}
      <section className="bg-navy relative overflow-hidden px-5 py-20 sm:px-6">
        <Image
          src={photos.generalBody.src}
          alt=""
          fill
          sizes="100vw"
          placeholder="blur"
          className="object-cover object-center opacity-25"
        />
        <div className="bg-navy/85 navy-wash absolute inset-0" />
        <dl className="max-w-content relative mx-auto grid gap-10 text-center sm:grid-cols-3 sm:text-left">
          {stats.map((stat) => (
            // Column-reverse keeps the figure above its label on screen while
            // the term still precedes its definition in the DOM, which is the
            // pairing assistive tech reads.
            <div
              key={stat.label}
              className="flex flex-col-reverse sm:border-l sm:border-white/15 sm:pl-6 sm:first:border-l-0 sm:first:pl-0"
            >
              <dt className="text-eyebrow tracking-caps mt-3 font-semibold text-white/70 uppercase">
                {stat.label}
              </dt>
              <dd className="font-display text-gold-bright text-stat font-bold">
                <StatValue value={stat.value} />
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <Section
        eyebrow="Our mission"
        title="Three commitments we hold each other to."
        lead="SASE's national mission, run at chapter scale on the Flats."
      >
        <PillarGrid pillars={missionPillars} />
        {/* /about owns these three pillars in full; without this link the
            homepage never reaches the page it is quoting. */}
        <div className="mt-12">
          <TextLink href="/about">More about the chapter</TextLink>
        </div>
      </Section>

      <Section
        eyebrow="What we do"
        title="What membership actually gets you."
        tone="cream"
      >
        <ul
          role="list"
          className="stagger grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
        >
          {programs.map((program) => (
            <li key={program.slug}>
              <Card className="flex h-full flex-col">
                <Icon
                  name={program.icon}
                  className="text-gold-ink h-8 w-8 shrink-0"
                />
                <h3 className="font-display text-navy text-h3 mt-6 font-bold">
                  {program.title}
                </h3>
                <p className="text-ink-muted text-body-sm mt-3">
                  {program.body}
                </p>
              </Card>
            </li>
          ))}
        </ul>
        <div className="mt-12">
          <TextLink href="/programs">Read about each program</TextLink>
        </div>
      </Section>

      {/* The hesitation this page has to answer is not "what is SASE" but
          "what happens if I show up alone". */}
      <Section
        eyebrow="Your first month"
        title="What happens if you just show up."
        lead="You do not need a friend already in it, a technical major, or a plan."
      >
        <ol
          role="list"
          className="stagger grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4"
        >
          {firstMonth.map((step, i) => (
            <li key={step.when} className="border-gold/60 border-t-2 pt-6">
              <div className="flex items-baseline gap-3">
                <span
                  aria-hidden="true"
                  className="font-display text-gold text-h2 font-bold"
                >
                  0{i + 1}
                </span>
                <Eyebrow tone="muted" rule={false}>
                  {step.when}
                </Eyebrow>
              </div>
              <h3 className="font-display text-navy text-h3 mt-4 font-bold">
                {step.title}
              </h3>
              <p className="text-ink-muted text-body-sm mt-3">{step.body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-12">
          <Button href="/join">Start at the next meeting</Button>
        </div>
      </Section>

      <Section
        eyebrow="Life in the chapter"
        title="A year of it, roughly."
        lead="Convention delegations, campus tabling, service nights, Hawks games, and the trips in between."
        tone="cream"
      >
        <PhotoMosaic photos={galleryPhotos} />
      </Section>

      <Section
        layout="split"
        eyebrow="Leadership"
        title="The people running the chapter."
        lead="Every seat is elected by the membership each spring."
      >
        <ul role="list" className="stagger border-hairline border-t">
          {board.slice(0, 4).map((member) => (
            <BoardRow key={member.role} member={member} />
          ))}
        </ul>
        <div className="mt-10">
          <TextLink href="/board">See the full board</TextLink>
        </div>
      </Section>

      <Section eyebrow="Calendar" title="What's coming up." tone="cream">
        {upcoming.length > 0 ? (
          <>
            <ul role="list" className="stagger grid gap-6 md:grid-cols-3">
              {upcoming.map((event) => (
                <li key={event.title}>
                  <EventCard event={event} />
                </li>
              ))}
            </ul>
            <div className="mt-12">
              <TextLink href="/events">Every event, past and upcoming</TextLink>
            </div>
          </>
        ) : (
          <Card>
            <p className="text-ink-muted text-body">
              {nextUp
                ? "Nothing else is on the books past the meeting above yet. Instagram gets new dates first."
                : "The calendar for next semester goes up before classes start. Instagram gets it first."}
            </p>
            <div className="mt-5">
              <TextLink href="/events">Past highlights</TextLink>
            </div>
          </Card>
        )}
      </Section>

      {/* Partners. An invitation, not a wall of empty logo tiles. */}
      <Section eyebrow="Partners" title="Recruit from this chapter.">
        <Card tone="navy" className="lg:p-12">
          <div className="grid gap-10 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
            <div>
              <h3 className="font-display text-h2 font-bold text-balance text-white">
                Partner slots are open for 2026&ndash;2027.
              </h3>
              <p className="mt-5 text-white/75">
                Sponsorship runs from a single info session to a named signature
                event. Every tier includes access to the member resume book and
                a direct line to Georgia Tech engineers, scientists, and
                business students.
              </p>
              <div className="mt-8">
                <Button href="/sponsors">See sponsorship tiers</Button>
              </div>
            </div>
            <ul role="list" className="space-y-4">
              {[
                "Info sessions and technical workshops",
                "Resume book access",
                "Named signature events",
                "Logo on chapter apparel",
              ].map((perk) => (
                <li
                  key={perk}
                  className="flex items-start gap-3 border-b border-white/10 pb-4 text-white/85"
                >
                  <span
                    aria-hidden="true"
                    className="bg-gold-bright mt-2 h-1.5 w-1.5 shrink-0 rounded-full"
                  />
                  {perk}
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </Section>

      <section className="px-5 pb-20 sm:px-6 sm:pb-28">
        <div className="bg-parchment rounded-panel max-w-content reveal mx-auto px-8 py-16 text-center sm:px-16">
          <h2 className="font-display text-navy text-h2 font-bold text-balance">
            Every major. Every year. Everyone welcome.
          </h2>
          <p className="text-ink-muted max-w-measure mx-auto mt-5">
            Show up to one general body meeting. Membership is free, and you
            will know by the end of it whether this is your crowd.
          </p>
          <div className="mt-9 flex flex-wrap justify-center gap-4">
            <Button href="/join">Join SASE GT</Button>
            <Button href="/contact" variant="outline">
              Ask us anything
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
