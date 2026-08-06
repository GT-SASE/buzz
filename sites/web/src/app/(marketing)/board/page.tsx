import {
  BoardRow,
  Button,
  CtaPanel,
  PageHeader,
  PhotoFrame,
  Section,
  TextLink,
} from "~/components/site";
import { JsonLd } from "~/components/site/json-ld";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { board } from "~/data/content";
import { photos } from "~/data/photos";
import { site } from "~/data/site";
import { breadcrumbSchema, pageMetadata } from "~/lib/seo";

export const metadata = pageMetadata({
  title: "Board",
  description:
    "The elected executive board of SASE at Georgia Tech for 2026-2027, what each officer handles, and how to reach them.",
  path: "/board",
});

export default function BoardPage() {
  const openSeats = board.filter((member) => !member.name).length;

  return (
    <>
      <JsonLd data={breadcrumbSchema("Board", "/board")} />
      <PageHeader
        eyebrow="Leadership"
        title="Meet the board."
        body="The students who run SASE GT. Reach out to any of us — we would rather answer a question than have you guess."
      />

      <Section size="sm">
        <PhotoFrame
          photo={photos.boardPortrait}
          sizes="(min-width: 1280px) 72rem, 100vw"
          className="aspect-[16/9] sm:aspect-[21/9]"
        />
      </Section>

      <Section
        size="sm"
        eyebrow="2026-2027"
        title="Executive board."
        lead="Elected each spring. Every role is open to any Georgia Tech student."
      >
        {openSeats > 0 && (
          <Alert
            role="note"
            className="border-hairline bg-cream border-t-rule max-w-measure mb-10 gap-y-3 rounded-none border-t-2 px-6 py-7"
          >
            <AlertTitle className="font-display text-navy text-h3 line-clamp-none font-bold">
              {openSeats === board.length
                ? "The roster is set at spring elections."
                : "Some seats are still open."}
            </AlertTitle>
            <AlertDescription className="text-ink-muted text-body-sm gap-3 leading-relaxed">
              <p>
                {openSeats} of {board.length} roles have no name announced yet.
                Those rows are open seats, not missing data — every one of them
                is a position a Georgia Tech student can run for.
              </p>
              <TextLink href="/join">Get involved</TextLink>
            </AlertDescription>
          </Alert>
        )}

        {/* A roster, not a grid of empty headshot frames. */}
        <ul role="list" className="stagger border-hairline border-t">
          {board.map((member) => (
            <BoardRow key={member.role} member={member} />
          ))}
        </ul>
      </Section>

      <Section size="sm">
        <CtaPanel
          title="Not sure who to ask?"
          body="One address reaches the whole board. Questions about joining, partnering, or a specific program all land in the same inbox."
        >
          <Button href={`mailto:${site.email}`} variant="solid">
            Email the board
          </Button>
        </CtaPanel>
      </Section>
    </>
  );
}
