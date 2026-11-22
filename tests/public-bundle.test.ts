import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = join(import.meta.dir, "../sites/web/src");

/**
 * These client files load on every public page: the nav shell and the error
 * boundary in the page's own JS, the sign-in card because every Join link
 * prefetches that route. `cn` brings tailwind-merge (~28 kB decoded), `Button`
 * and `Alert` bring cva and Slot, lucide-react brings its icon runtime, and the
 * `~/components/site` barrel brings all of them. Static markup belongs on the
 * server, passed in as a prop, as `SiteNav` and the sign-in page do.
 */
const lean = [
  "components/site/site-nav-shell.tsx",
  "app/(marketing)/error.tsx",
  "app/portal/signin/sign-in-card.tsx",
];
const heavy =
  /from "(lucide-react|~\/lib\/utils|~\/components\/ui\/[^"]+|~\/components\/site)"/;

describe("public client bundle", () => {
  it.each(lean)("%s imports no icon library, cn or ui kit", (file) => {
    expect(readFileSync(join(src, file), "utf8")).not.toMatch(heavy);
  });
});
