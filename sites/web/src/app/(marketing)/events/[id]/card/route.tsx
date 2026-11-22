import { ImageResponse } from "next/og";

import { getChapterEvent, getChapterEvents } from "~/data/chapter-events";
import { formatClockWithZone, formatLongDate } from "~/lib/event-time";
import { ogColors, ogDino, ogFonts } from "~/lib/og";
import { clipText } from "~/lib/seo";

/**
 * This is a route handler, not an `opengraph-image` file, on purpose: Next
 * serves a file in a dynamic segment at a hashed URL it does not expose
 * (`/opengraph-image-4s1jwf`), and the page's JSON-LD and Twitter tag both
 * need to name the card. `/events/<id>/card` is a URL the page can build.
 */
const size = { width: 1200, height: 630 };

// Prerendered and refreshed like the page it belongs to.
export const dynamic = "force-static";
export const revalidate = 3600;

export async function generateStaticParams() {
  const { upcoming } = await getChapterEvents();
  return upcoming.map((event) => ({ id: event.id }));
}

const { navy, gold, ink, muted, desk } = ogColors;

/** Shorter titles get more of the card. */
function titleSize(title: string) {
  if (title.length <= 28) return 92;
  if (title.length <= 56) return 72;
  return 56;
}

/**
 * The share card for one event: what it is, when, and where, on the chapter's
 * card. Satori supports a flexbox subset of CSS only, so every element with
 * more than one child sets `display: flex`.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const event = await getChapterEvent(id);
  if (!event) return new Response("Not found", { status: 404 });

  const [dino, fonts] = await Promise.all([ogDino(), ogFonts()]);
  // Satori has no line clamp, so long copy is cut before it is laid out.
  const title = clipText(event.title, 90);
  const when = event.reminder
    ? formatLongDate(event.startsAt)
    : `${formatLongDate(event.startsAt)}, ${formatClockWithZone(event.startsAt)}`;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        backgroundColor: desk,
        fontFamily: "Archivo",
      }}
    >
      <div style={{ width: 28, display: "flex", backgroundColor: gold }} />
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 80px 64px 72px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- Satori renders plain <img> only */}
          <img src={dino} width={67} height={80} alt="" />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              marginLeft: 18,
            }}
          >
            <div style={{ fontSize: 30, fontWeight: 800, color: navy }}>
              SASE
            </div>
            <div style={{ fontSize: 20, color: muted }}>Georgia Tech</div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: titleSize(title),
              fontWeight: 800,
              color: navy,
              lineHeight: 1.05,
              letterSpacing: -2,
            }}
          >
            {title}
          </div>
          <div style={{ fontSize: 34, color: ink, marginTop: 30 }}>{when}</div>
          {event.location && (
            <div style={{ fontSize: 30, color: muted, marginTop: 10 }}>
              {clipText(event.location, 70)}
            </div>
          )}
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts,
      // ImageResponse's own default revalidates on every request; this is the
      // page's window, so the CDN serves the card and refreshes it hourly.
      headers: {
        "Cache-Control": "s-maxage=3600, stale-while-revalidate=86400",
      },
    },
  );
}
