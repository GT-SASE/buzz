import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = join(import.meta.dir, "../../sites/web/src");

/**
 * These client files load on every public page: the nav shell and the
 * marketing error boundary in the page's own JS, the sign-in card and the
 * portal error boundary because every Join link prefetches that route. `cn` brings tailwind-merge (~28 kB decoded), `Button`
 * and `Alert` bring cva and Slot, lucide-react brings its icon runtime, and the
 * `~/components/site` barrel brings all of them. Static markup belongs on the
 * server, passed in as a prop, as `SiteNav` and the sign-in page do.
 */
const lean = [
  "components/site/site-nav-shell.tsx",
  "components/site/error-alert.tsx",
  "app/(marketing)/error.tsx",
  "app/portal/error.tsx",
  "app/portal/signin/sign-in-card.tsx",
];
const heavy =
  /from "(lucide-react|~\/lib\/utils|~\/components\/ui\/[^"]+|~\/components\/site)"/;

/**
 * Public additions that must stay server markup: the announcement banner (its
 * dismiss is an inline script, not a client component), the sponsor wall and
 * the pages that carry them. A "use client" here would ship them, and their
 * imports, to every visitor.
 */
const serverOnly = [
  "components/site/announcement.tsx",
  "components/site/announcement-slot.tsx",
  "components/site/sponsor-wall.tsx",
  "app/(marketing)/layout.tsx",
  "app/(marketing)/faq/page.tsx",
  "app/(marketing)/sponsors/page.tsx",
];

describe("public client bundle", () => {
  it.each(lean)("%s imports no icon library, cn or ui kit", (file) => {
    expect(readFileSync(join(src, file), "utf8")).not.toMatch(heavy);
  });

  it.each(serverOnly)("%s is not a client module", (file) => {
    expect(readFileSync(join(src, file), "utf8")).not.toMatch(
      /^\s*["']use client["']/m,
    );
  });
});

/**
 * The RSVP island ships on every /events page. It talks to the tRPC endpoint
 * with `fetch`, so none of the portal's data layer may come with it, and it
 * may import nothing beyond React and its own fetch helpers.
 */
describe("RSVP island", () => {
  const specifiers = (file: string) =>
    [
      ...readFileSync(join(src, file), "utf8").matchAll(
        /(?:from|import)\s+"([^"]+)"/g,
      ),
    ].map((match) => match[1]);

  it("imports only React and its fetch helpers", () => {
    expect(specifiers("components/site/rsvp.tsx").sort()).toEqual([
      "react",
      "~/lib/rsvp-client",
    ]);
  });

  it("keeps the fetch helpers free of imports", () => {
    expect(specifiers("lib/rsvp-client.ts")).toEqual([]);
  });
});
