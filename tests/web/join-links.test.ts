import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const marketing = join(import.meta.dir, "../../sites/web/src/app/(marketing)");

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? pageFiles(join(dir, entry.name))
      : entry.name.endsWith(".tsx")
        ? [join(dir, entry.name)]
        : [],
  );
}

describe("join links", () => {
  /**
   * Joining is signing in (`joinHref`). A button that went to the /join
   * explainer instead sent visitors down a second path to the same decision.
   */
  it("no marketing button points at /join instead of joinHref", () => {
    for (const file of pageFiles(marketing)) {
      expect(readFileSync(file, "utf8")).not.toMatch(
        /<Button[^>]*href="\/join"/,
      );
    }
  });
});
