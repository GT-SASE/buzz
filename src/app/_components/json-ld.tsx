import { jsonLd } from "~/lib/seo";

/** Emits one schema.org graph as a JSON-LD script tag. */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd(data)} />
  );
}
