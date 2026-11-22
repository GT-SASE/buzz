import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const src = join(import.meta.dir, "../sites/web/src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : /\.(ts|tsx)$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
}

describe("gold as text", () => {
  /**
   * --gold (#b3a369) is 2.6:1 on white, well under the 4.5:1 AA floor for text.
   * It stays for rules, pips and bars. Text on a light ground is `text-gold-ink`,
   * and on navy `text-gold-bright`.
   */
  it("no class sets text to the plain gold", () => {
    const offenders = sourceFiles(src).filter((file) =>
      /(^|[\s"'`:])text-gold(?![-\w])/m.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
