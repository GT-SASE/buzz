import Image from "next/image";

import {
  BoardRow,
  Button,
  Card,
  EventCard,
  Eyebrow,
  Icon,
  Marquee,
  PhotoFrame,
  PhotoMosaic,
  PillarGrid,
  Section,
  StatValue,
  TextLink,
} from "~/components/site";
import { JsonLd } from "~/components/site/json-ld";
import { Badge } from "~/components/ui/badge";
import {
  Card as UiCard,
  CardContent,
  CardDescription,
  CardHeader,
} from "~/components/ui/card";
import { getChapterEvents } from "~/data/chapter-events";
import {
  board,
  firstMonth,
  marqueeItems,
  meeting,
  missionPillars,
  programs,
  stats,
} from "~/data/content";
import { galleryPhotos, homePhotos } from "~/data/photos-home";
import { site } from "~/data/site";
import { pageMetadata } from "~/lib/seo";

// The hero and calendar band read the live event table, so a prerendered build
// would otherwise pin this page to whatever the calendar held at deploy time.
export const revalidate = 3600;

export const metadata = pageMetadata({
  title: `${site.name} — ${site.tagline}`,
  description:
    "The Georgia Tech chapter of the Society of Asian Scientists and Engineers. Mentor families, recruiter resume workshops, semester-long technical projects, and Taste of SASE — open to every Georgia Tech student, any major, any year.",
  path: "/",
});

export default async function Home() {
  const { upcoming } = await getChapterEvents();
  const nextUp = upcoming[0];
  // The hero already prints the soonest event, so the band starts after it.
  const calendar = upcoming.slice(1, 4);

  return (
    <>
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

      <section className="px-5 sm:px-6">
        <div className="max-w-content mx-auto">
          <div className="text-eyebrow tracking-masthead text-ink-muted border-rule flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b-2 pt-6 pb-3 font-semibold uppercase sm:pt-8 sm:pb-4">
            <span className="text-navy">{site.name}</span>
            <span className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
              <span className="hidden sm:inline">{site.theme}</span>
              <span>2026&ndash;2027</span>
            </span>
          </div>

          <div className="grid gap-x-16 gap-y-10 pt-8 pb-14 lg:grid-cols-[1.3fr_0.7fr] lg:gap-y-14 lg:pt-16 lg:pb-28">
            <div className="rise">
              <h1 className="font-display text-navy text-hero optical-left font-bold tracking-tight">
                <span className="line-mask">
                  <span>Find your people</span>
                </span>
                <span className="line-mask">
                  <span>in STEM.</span>
                </span>
              </h1>
              <p className="text-lead text-ink-muted max-w-measure mt-6 sm:mt-8">
                We are the Georgia Tech chapter of the Society of Asian
                Scientists and Engineers. Mentor families, recruiter workshops,
                semester-long build teams, and Taste of SASE — open to every
                student on campus, any major, any background.
              </p>
              <div className="mt-8 flex flex-col items-stretch gap-4 sm:mt-10 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-8 sm:gap-y-5">
                <Button
                  href="/join"
                  className="w-full justify-center sm:w-auto"
                >
                  Become a member
                </Button>
                <Button
                  href="/programs"
                  variant="outline"
                  className="w-full justify-center sm:w-auto"
                >
                  What we do
                </Button>
              </div>
            </div>

            <div className="rise" style={{ animationDelay: "140ms" }}>
              <PhotoFrame
                photo={homePhotos.conventionDelegation}
                priority
                sizes="(min-width: 1024px) 42vw, 100vw"
                className="aspect-[4/3] lg:aspect-[4/5]"
              />
              <Card className="mt-6 sm:mt-10">
                <Eyebrow tone="muted" rule={false}>
                  Come to a meeting
                </Eyebrow>
                <p className="font-display text-navy text-h2 mt-4 font-bold">
                  General body meetings
                </p>
                <p className="text-ink-muted text-body mt-3">
                  {meeting.summary}
                </p>
                <p className="text-ink-muted text-body-sm mt-1">
                  {meeting.location}
                </p>

                {nextUp && (
                  <div className="border-hairline mt-7 border-t pt-6">
                    <Badge className="bg-gold-bright text-navy text-eyebrow tracking-masthead rounded-none font-semibold uppercase">
                      Next up
                    </Badge>
                    <p className="font-display text-navy text-h3 mt-3 font-bold">
                      {nextUp.title}
                    </p>
                    <p className="text-ink-muted text-body-sm mt-1">
                      {nextUp.displayDate}
                      {nextUp.location ? ` · ${nextUp.location}` : ""}
                    </p>
                  </div>
                )}

                <div className="mt-7">
                  <TextLink href="/events">See the full calendar</TextLink>
                </div>
              </Card>
            </div>
          </div>
        </div>
      </section>

      <Marquee items={marqueeItems} />

      {/* The photograph is decorative — the figures carry the information — so
          it takes an empty alt and sits behind a scrim that holds the gold at
          AA for large text. */}
      <section className="bg-navy relative overflow-hidden px-5 py-14 sm:px-6 sm:py-24">
        <Image
          src={homePhotos.generalBody.src}
          alt=""
          fill
          sizes="100vw"
          placeholder="blur"
          className="object-cover object-center opacity-25"
        />
        <div className="bg-navy/85 navy-wash absolute inset-0" />
        <dl className="max-w-content relative mx-auto grid border-t-2 border-white/70 sm:grid-cols-3">
          {stats.map((stat) => (
            // Column-reverse keeps the figure above its label on screen while
            // the term still precedes its definition in the DOM.
            <div
              key={stat.label}
              className="flex flex-col-reverse border-b border-white/15 py-8 last:border-b-0 sm:border-b-0 sm:border-l sm:py-12 sm:pl-10 sm:first:border-l-0 sm:first:pl-0"
            >
              <Eyebrow as="dt" tone="onNavy" rule={false} className="mt-4">
                {stat.label}
              </Eyebrow>
              <dd className="font-display text-gold-bright text-stat font-bold">
                <StatValue value={stat.value} />
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <Section
        number="01"
        eyebrow="Our mission"
        title="Three commitments we hold each other to."
        lead="SASE's national mission, run at chapter scale on the Flats."
      >
        <PillarGrid pillars={missionPillars} />
        <div className="mt-12">
          <TextLink href="/about">More about the chapter</TextLink>
        </div>
      </Section>

      <Section
        number="02"
        eyebrow="What we do"
        title="What membership actually gets you."
      >
        <ul
          role="list"
          className="stagger grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-3"
        >
          {programs.map((program) => (
            <li key={program.slug} className="h-full">
              <UiCard className="border-hairline hover:border-rule hover:bg-cream h-full gap-0 rounded-none bg-transparent py-8 shadow-none transition duration-200">
                <CardHeader className="gap-0">
                  <Icon
                    name={program.icon}
                    className="text-gold-ink h-8 w-8 shrink-0"
                  />
                  <h3 className="font-display text-navy text-h3 mt-6 font-bold">
                    {program.title}
                  </h3>
                </CardHeader>
                <CardContent>
                  <CardDescription className="text-ink-muted text-body-sm mt-3">
                    {program.body}
                  </CardDescription>
                </CardContent>
              </UiCard>
            </li>
          ))}
        </ul>
        <div className="mt-12">
          <TextLink href="/programs">Read about each program</TextLink>
        </div>
      </Section>

      {/* The hesitation to answer is not "what is SASE" but "what happens if I
          show up alone". */}
      <Section
        number="03"
        eyebrow="Your first month"
        title="What happens if you just show up."
        lead="You do not need a friend already in it, a technical major, or a plan."
      >
        <ol
          role="list"
          className="stagger grid gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-4"
        >
          {firstMonth.map((step, i) => (
            <li key={step.when} className="border-rule border-t-2 pt-6">
              <div className="flex items-center gap-4">
                <span
                  aria-hidden="true"
                  className="font-display text-gold-ink text-numeral font-bold"
                >
                  0{i + 1}
                </span>
                <Badge
                  variant="secondary"
                  className="text-eyebrow tracking-masthead rounded-none font-semibold uppercase"
                >
                  {step.when}
                </Badge>
              </div>
              <h3 className="font-display text-navy text-h3 mt-5 font-bold">
                {step.title}
              </h3>
              <p className="text-ink-muted text-body-sm mt-3">{step.body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-12">
          <Button href="/join" className="w-full justify-center sm:w-auto">
            Start at the next meeting
          </Button>
        </div>
      </Section>

      <Section
        number="04"
        eyebrow="Life in the chapter"
        title="A year of it, roughly."
        lead="Convention delegations, campus tabling, service nights, Hawks games, and the trips in between."
        tone="cream"
      >
        <PhotoMosaic photos={galleryPhotos} />
      </Section>

      <Section
        number="05"
        layout="split"
        eyebrow="Leadership"
        title="The people running the chapter."
        lead="Every seat is elected by the membership each spring."
      >
        <ul role="list" className="stagger border-hairline border-t">
          {board.slice(0, 4).map((member) => (
            <BoardRow key={member.name ?? member.role} member={member} />
          ))}
        </ul>
        <div className="mt-10">
          <TextLink href="/board">See the full board</TextLink>
        </div>
      </Section>

      <Section number="06" eyebrow="Calendar" title="What's coming up.">
        {calendar.length > 0 ? (
          <>
            <ul
              role="list"
              className="stagger grid gap-x-10 gap-y-12 md:grid-cols-3"
            >
              {calendar.map((event) => (
                <li key={event.id}>
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
      <Section
        number="07"
        eyebrow="Partners"
        title="Recruit from this chapter."
      >
        <Card tone="navy">
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
                <Button
                  href="/sponsors"
                  variant="solid"
                  className="w-full justify-center sm:w-auto"
                >
                  See sponsorship tiers
                </Button>
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
                    className="bg-gold-bright mt-2 h-1.5 w-1.5 shrink-0"
                  />
                  {perk}
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </Section>

      {/* Deliberately outside the numbered sequence: the last thing on the page
          is the invitation, not another section. */}
      <section className="px-5 pt-4 pb-20 sm:px-6 sm:pb-28">
        <div className="max-w-content reveal mx-auto">
          <div className="rule-heavy grid gap-x-16 gap-y-6 pt-10 lg:grid-cols-[1.35fr_1fr] lg:items-end">
            <h2 className="font-display text-navy text-h1 optical-left font-bold tracking-tight text-balance">
              Every major. Every year. Everyone welcome.
            </h2>
            <p className="text-ink-muted text-lead max-w-measure lg:pb-2">
              Show up to one general body meeting. Membership is free, and you
              will know by the end of it whether this is your crowd.
            </p>
          </div>
          <div className="mt-10 flex flex-col items-stretch gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-8 sm:gap-y-5">
            <Button href="/join" className="w-full justify-center sm:w-auto">
              Join SASE GT
            </Button>
            <Button
              href="/contact"
              variant="outline"
              className="w-full justify-center sm:w-auto"
            >
              Ask us anything
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
