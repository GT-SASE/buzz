import { readFileSync, writeFileSync } from "node:fs";
function patch(f: string, edits: [string, string][]) {
  f = "sites/discord-bot/" + f;
  let s = readFileSync(f, "utf8");
  for (const [a, b] of edits) {
    const i = s.indexOf(a);
    if (i < 0) throw new Error(f + " missing: " + a.slice(0, 80));
    s = s.slice(0, i) + b + s.slice(i + a.length);
  }
  writeFileSync(f, s);
}
patch("src/db/history.ts", [
  [`  const strip = ({ updated_at: _moved, ...rest }: JsonRow): string =>
    JSON.stringify(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1)));
  return strip(before) === strip(after);`, `  const strip = (row: JsonRow): string =>
    JSON.stringify(
      Object.entries(row)
        .filter(([key]) => key !== "updated_at")
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  return strip(before) === strip(after);`],
  [`  return after.map(
    ({ __row: _row, ...rest }: Record<string, unknown>) => rest,
  ) as Record<keyof R, unknown>[];`, `  return after.map((result: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(result).filter(([key]) => key !== "__row"),
    ),
  ) as Record<keyof R, unknown>[];`],
]);
patch("test/db/history-and-rules.test.ts", [
  [`    second;\n`, ``],
  [`    const second = await insertEvent(db, guild);\n`, ``],
  [`void sql;\n`, ``],
  [`import { eq, sql } from "drizzle-orm";`, `import { eq } from "drizzle-orm";`],
]);
