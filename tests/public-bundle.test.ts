import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = join(import.meta.dir, "../sites/web/src");

/**
 * These client files ship in every public page's JS. `cn` brings tailwind-merge
 * (~28 kB decoded), `Button` and `Alert` bring cva and Slot, and lucide-react
 * brings its icon runtime. Static markup belongs on the server and heavy
 * panels belong behind `lazy`, as `SiteNav` and `error.tsx` do.
 */
const lean = [
  "components/site/site-nav-shell.tsx",
  "app/(marketing)/error.tsx",
];
const heavy = /from "(lucide-react|~\/lib\/utils|~\/components\/ui\/[^"]+)"/;

describe("public client bundle", () => {
  it.each(lean)("%s imports no icon library, cn or ui kit", (file) => {
    expect(readFileSync(join(src, file), "utf8")).not.toMatch(heavy);
  });
});
