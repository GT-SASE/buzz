import { Button, PageHeader, Section } from "~/components/site";
import { Disclosure } from "~/components/site/disclosure";
import { JsonLd } from "~/components/site/json-ld";
import { faqs } from "~/data/faq";
import { joinHref, site } from "~/data/site";
import { breadcrumbSchema, faqSchema, pageMetadata } from "~/lib/seo";
import { withOwnShareImage } from "~/lib/own-share-image";

export const metadata = withOwnShareImage(
  pageMetadata({
    title: "FAQ | SASE at Georgia Tech",
    description:
      "Answers about SASE at Georgia Tech: how to join, dues, when and where we meet, what to bring, and how chapter points work.",
    path: "/faq",
  }),
);

export default function FaqPage() {
  return (
    <>
      <JsonLd data={breadcrumbSchema("FAQ", "/faq")} />
      <JsonLd data={faqSchema(faqs)} />
      <PageHeader
        title="Questions, answered."
        body="How to join, what it costs, when we meet, what to bring, and how points work."
      />

      <Section size="sm">
        <h2 className="sr-only">Frequently asked questions</h2>
        <div className="border-hairline border-t">
          {faqs.map((faq) => (
            <Disclosure
              key={faq.id}
              id={faq.id}
              name="faq"
              summary={faq.q}
              className="border-hairline last:border-b"
              summaryClassName="font-display text-navy text-h3 gap-8 rounded-none py-6 font-bold"
              panelClassName="text-ink-muted text-body max-w-measure pb-8 leading-relaxed"
            >
              {faq.a}
            </Disclosure>
          ))}
        </div>
      </Section>

      <Section
        size="sm"
        tone="paper"
        title="Still stuck?"
        lead="Email the chapter. Someone on the board reads it."
      >
        <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-8 sm:gap-y-4">
          <Button
            href={`mailto:${site.email}`}
            className="w-full justify-center sm:w-auto"
          >
            Email {site.email}
          </Button>
          <Button
            href={joinHref}
            variant="outline"
            className="w-full justify-center sm:w-auto"
          >
            Join SASE
          </Button>
        </div>
      </Section>
    </>
  );
}
