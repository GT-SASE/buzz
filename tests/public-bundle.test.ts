import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = join(import.meta.dir, "../sites/web/src");

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

describe("public client bundle", () => {
  it.each(lean)("%s imports no icon library, cn or ui kit", (file) => {
    expect(readFileSync(join(src, file), "utf8")).not.toMatch(heavy);
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
