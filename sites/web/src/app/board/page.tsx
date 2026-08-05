import {
  BoardRow,
  Button,
  PageHeader,
  PhotoFrame,
  Section,
} from "~/app/_components/ui";
import { JsonLd } from "~/app/_components/json-ld";
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
        {/* A roster, not a grid of empty headshot frames: the chapter has no
            photos yet, and a directory reads finished without them. */}
        <ul role="list" className="stagger border-hairline border-t">
          {board.map((member) => (
            <BoardRow key={member.role} member={member} />
          ))}
        </ul>
      </Section>

      <Section size="sm" className="bg-cream border-hairline border-y">
        <div className="max-w-measure mx-auto text-center">
          <h2 className="font-display text-navy text-h2 text-balance font-bold">
            Not sure who to ask?
          </h2>
          <p className="text-lead text-ink-muted mt-4">
            One address reaches the whole board. Questions about joining,
            partnering, or a specific program all land in the same inbox.
          </p>
          <Button href={`mailto:${site.email}`} className="mt-9">
            Email the board
          </Button>
        </div>
      </Section>
    </>
  );
}
