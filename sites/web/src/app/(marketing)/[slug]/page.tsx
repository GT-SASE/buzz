import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader, Section } from "~/components/site";
import { JsonLd } from "~/components/site/json-ld";
import { Markdown } from "~/components/site/markdown";
import { getPublishedPage } from "~/data/pages";
import { breadcrumbSchema, pageMetadata } from "~/lib/seo";
import { site } from "~/data/site";

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const page = await getPublishedPage(slug);
  if (!page) return {};
  return pageMetadata({
    title: `${page.title} | ${site.name}`,
    description: page.description || site.description,
    path: `/${slug}`,
  });
}

export default async function PublishedPage({ params }: Params) {
  const { slug } = await params;
  const page = await getPublishedPage(slug);
  if (!page) notFound();

  return (
    <>
      <JsonLd data={breadcrumbSchema(page.title, `/${slug}`)} />
      <PageHeader title={page.title} body={page.description || undefined} />
      <Section size="sm">
        <Markdown className="max-w-narrow">{page.body}</Markdown>
      </Section>
    </>
  );
}
