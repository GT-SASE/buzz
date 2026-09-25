import { toString as qrSvg } from "qrcode";

import { Button, Card, PageHeader, Section } from "~/components/site";
import { JsonLd } from "~/components/site/json-ld";
import { discord } from "~/data/site";
import { breadcrumbSchema, pageMetadata } from "~/lib/seo";

export const metadata = pageMetadata({
  title: "Discord",
  description:
    "Join the SASE at Georgia Tech Discord for weekly meeting rooms, project team channels, conference ride shares, and quick answers from the board.",
  path: "/discord",
});

const reasons = [
  {
    title: "Where the meeting is",
    body: "Day, time, and room for each general body meeting go out here every week.",
  },
  {
    title: "Project teams",
    body: "Each build team has its own channel for planning and questions between meetings.",
  },
  {
    title: "Conference rides",
    body: "Ride shares and room plans for the regional and national conventions.",
  },
  {
    title: "Ask the board",
    body: "The fastest way to get an answer from a chair or an officer.",
  },
];

export default async function DiscordPage() {
  const invite = discord?.href ?? "";
  const qr = await qrSvg(invite, {
    type: "svg",
    margin: 0,
    color: { dark: "#003057", light: "#0000" },
  });

  return (
    <>
      <JsonLd data={breadcrumbSchema("Discord", "/discord")} />
      <PageHeader
        eyebrow="Discord"
        title="Join the Discord."
        body="Where the chapter talks between meetings. Open to every Georgia Tech student, no membership needed."
      />

      <Section
        size="sm"
        layout="split"
        title="Get in."
        lead="One tap on your phone, or scan the code from a slide or flyer."
      >
        <div className="grid gap-10 md:grid-cols-[1fr_auto] md:items-start">
          <div>
            <Button href={invite} variant="solid" external>
              Join the server
            </Button>
            <ul role="list" className="stagger border-hairline mt-10 border-t">
              {reasons.map((reason) => (
                <li
                  key={reason.title}
                  className="border-hairline border-b py-5"
                >
                  <h3 className="font-display text-navy text-h3 font-bold">
                    {reason.title}
                  </h3>
                  <p className="text-ink-muted text-body mt-2">{reason.body}</p>
                </li>
              ))}
            </ul>
          </div>

          <Card className="w-full max-w-64 justify-self-center md:justify-self-end">
            <div
              role="img"
              aria-label="QR code that opens the SASE GT Discord invite"
              className="aspect-square w-full [&>svg]:h-full [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: qr }}
            />
            <p className="text-ink-muted text-body-sm mt-4 text-center break-all">
              {invite.replace("https://", "")}
            </p>
          </Card>
        </div>
      </Section>
    </>
  );
}
