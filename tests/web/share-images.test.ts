import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { withOwnShareImage } from "../../sites/web/src/lib/own-share-image";
import { pageMetadata } from "../../sites/web/src/lib/seo";

const marketing = join(import.meta.dir, "../../sites/web/src/app/(marketing)");

/** Every route folder under (marketing) that has its own share image file. */
const routesWithCard = readdirSync(marketing, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => {
    try {
      readFileSync(join(marketing, name, "opengraph-image.tsx"));
      return true;
    } catch {
      return false;
    }
  });

describe("withOwnShareImage", () => {
  const meta = pageMetadata({
    title: "FAQ | SASE at Georgia Tech",
    description: "Answers.",
    path: "/faq",
  });
  const own = withOwnShareImage(meta);

  it("drops the chapter-wide image from the Open Graph and Twitter tags", () => {
    expect(meta.openGraph).toHaveProperty("images");
    expect(own.openGraph).not.toHaveProperty("images");
    expect(own.twitter).not.toHaveProperty("images");
  });

  it("keeps everything else the page set", () => {
    expect(own.title).toEqual(meta.title);
    expect(own.description).toBe("Answers.");
    expect(own.alternates?.canonical).toBe("https://buzzsase.vercel.app/faq");
    expect(own.openGraph).toMatchObject({
      title: "FAQ | SASE at Georgia Tech",
      url: "https://buzzsase.vercel.app/faq",
      type: "website",
    });
    expect(own.twitter).toMatchObject({ card: "summary_large_image" });
  });
});

describe("pages with their own share image", () => {
  it("covers the public pages that had only the chapter card", () => {
    const expected = [
      "[slug]",
      "about",
      "board",
      "contact",
      "discord",
      "faq",
      "join",
      "programs",
      "sponsors",
      "status",
      "website-team",
    ];
    const missing = expected.filter((route) => !routesWithCard.includes(route));
    expect(missing).toEqual([]);
  });

  it.each(routesWithCard)(
    "/%s leaves the image tags out so its opengraph-image file is used",
    (route) => {
      const page = readFileSync(join(marketing, route, "page.tsx"), "utf8");
      expect(page).toContain("withOwnShareImage(");
    },
  );

  it("keeps /events and the home page off this list", () => {
    expect(routesWithCard).not.toContain("events");
  });
});
