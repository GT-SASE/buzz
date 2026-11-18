import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "~/lib/utils";

const heading = "font-display text-navy font-bold tracking-tight text-balance";

/**
 * The page title is the only h1, so a `#` in the body renders as an h2.
 * Raw HTML in the source is not rendered: react-markdown escapes it, and
 * `javascript:` URLs are stripped by its default URL transform.
 */
const components: Components = {
  h1: ({ node: _node, ...props }) => (
    <h2 {...props} className={cn(heading, "text-h2 mt-14 mb-5 first:mt-0")} />
  ),
  h2: ({ node: _node, ...props }) => (
    <h2 {...props} className={cn(heading, "text-h2 mt-14 mb-5 first:mt-0")} />
  ),
  h3: ({ node: _node, ...props }) => (
    <h3 {...props} className={cn(heading, "text-h3 mt-10 mb-3 first:mt-0")} />
  ),
  h4: ({ node: _node, ...props }) => (
    <h4 {...props} className={cn(heading, "text-body mt-8 mb-2 first:mt-0")} />
  ),
  p: ({ node: _node, ...props }) => (
    <p {...props} className="text-ink text-body my-5 first:mt-0" />
  ),
  ul: ({ node: _node, ...props }) => (
    <ul
      {...props}
      className="text-ink text-body my-5 list-disc space-y-2 pl-6"
    />
  ),
  ol: ({ node: _node, ...props }) => (
    <ol
      {...props}
      className="text-ink text-body my-5 list-decimal space-y-2 pl-6"
    />
  ),
  blockquote: ({ node: _node, ...props }) => (
    <blockquote
      {...props}
      className="border-gold text-ink-muted my-6 border-l-4 pl-5"
    />
  ),
  hr: ({ node: _node, ...props }) => (
    <hr {...props} className="border-hairline my-10" />
  ),
  a: ({ node: _node, href, ...props }) => {
    const external = href !== undefined && /^(https?:)?\/\//i.test(href);
    return (
      <a
        {...props}
        href={href}
        rel={external ? "noopener noreferrer" : undefined}
        className="text-navy font-semibold underline underline-offset-4"
      />
    );
  },
  code: ({ node: _node, ...props }) => (
    <code {...props} className="bg-cream rounded px-1.5 py-0.5 text-[0.9em]" />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre
      {...props}
      className="bg-cream my-6 overflow-x-auto rounded-lg p-4 text-sm [&_code]:bg-transparent [&_code]:p-0"
    />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="my-6 overflow-x-auto">
      <table {...props} className="text-body-sm w-full border-collapse" />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th
      {...props}
      className="border-hairline text-navy border-b px-3 py-2 text-left font-semibold"
    />
  ),
  td: ({ node: _node, ...props }) => (
    <td {...props} className="border-hairline border-b px-3 py-2" />
  ),
};

/** Officer-written page body. Shared by the public page and the editor preview. */
export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("[&_img]:h-auto [&_img]:max-w-full", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
