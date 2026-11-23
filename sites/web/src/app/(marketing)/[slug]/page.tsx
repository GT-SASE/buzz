import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";

import { PageHeader, Section } from "~/components/site";
import { JsonLd } from "~/components/site/json-ld";
import { Markdown } from "~/components/site/markdown";
import { getPageRedirect, getPublishedPage } from "~/data/pages";
import { withOwnShareImage } from "~/lib/own-share-image";
import { breadcrumbSchema, pageMetadata } from "~/lib/seo";
import { site } from "~/data/site";

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const page = await getPublishedPage(slug);
  if (!page) return {};
  return withOwnShareImage(
    pageMetadata({
      title: `${page.title} | ${site.name}`,
      description: page.description || site.description,
      path: `/${slug}`,
    }),
  );
}

export default async function PublishedPage({ params }: Params) {
  const { slug } = await params;
  const page = await getPublishedPage(slug);
  if (!page) {
    // A page that moved: its old address answers 308 to the new one.
    const moved = await getPageRedirect(slug);
    if (moved) permanentRedirect(`/${moved}`);
    notFound();
  }

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
