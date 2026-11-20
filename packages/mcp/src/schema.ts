import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import { BOT_MIGRATIONS_DIR } from "./bot";
import { formatBotDatabase } from "./bot-db";
import { readRepoFile } from "./repo";

const SCHEMA_FILE = "packages/db/src/schema.ts";

/**
 * Describes the Drizzle schema. Imports the schema file directly, not the
 * `@buzz/db` index, because the index opens a database client.
 */
export async function describeSchema(
  filter?: string,
  database: "all" | "buzz" | "bot" = "all",
): Promise<string> {
  const bot = database === "buzz" ? "" : await formatBotDatabase(filter);
  if (database === "bot") return bot;
  const schema = (await import("@buzz/db/schema")) as Record<string, unknown>;
  const source = readRepoFile(SCHEMA_FILE).split(/\r?\n/);
  const f = filter?.trim().toLowerCase();

  const blocks: string[] = [];
  for (const [exportName, value] of Object.entries(schema)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value);
    if (
      f &&
      !cfg.name.toLowerCase().includes(f) &&
      !exportName.toLowerCase().includes(f)
    ) {
      continue;
    }
    const line =
      source.findIndex((l) => l.startsWith(`export const ${exportName} =`)) + 1;
    const lines = [`${cfg.name}  (${exportName}, ${SCHEMA_FILE}:${line})`];
    for (const c of cfg.columns) {
      const flags = [
        c.primary ? "primary" : "",
        c.notNull ? "notNull" : "",
        c.hasDefault ? "default" : "",
      ].filter(Boolean);
      lines.push(
        `  ${c.name}  ${c.getSQLType()}${flags.length ? `  ${flags.join(" ")}` : ""}`,
      );
    }
    for (const pk of cfg.primaryKeys) {
      lines.push(
        `  PK ${pk.getName()}: (${pk.columns.map((c) => c.name).join(", ")})`,
      );
    }
    for (const fk of cfg.foreignKeys) {
      const r = fk.reference();
      lines.push(
        `  FK ${fk.getName()}: (${r.columns.map((c) => c.name).join(", ")}) -> ${getTableConfig(r.foreignTable).name}(${r.foreignColumns.map((c) => c.name).join(", ")}) onDelete=${fk.onDelete ?? "no action"} onUpdate=${fk.onUpdate ?? "no action"}`,
      );
    }
    for (const u of cfg.uniqueConstraints) {
      lines.push(
        `  UNIQUE ${u.name ?? ""}: (${u.columns.map((c) => c.name).join(", ")})`,
      );
    }
    for (const i of cfg.indexes) {
      const ic = i.config;
      const cols = ic.columns
        .map((c) => ("name" in c ? c.name : "<expr>"))
        .join(", ");
      lines.push(`  ${ic.unique ? "UNIQUE " : ""}INDEX ${ic.name}: (${cols})`);
    }
    for (const ck of cfg.checks) lines.push(`  CHECK ${ck.name}`);
    blocks.push(lines.join("\n"));
  }
  const buzz = blocks.length ? blocks.join("\n\n") : "No matching tables.";
  if (database === "buzz") return buzz;
  return [
    `=== buzz database (Drizzle, ${SCHEMA_FILE}) ===`,
    buzz,
    `=== bot database (dbmate SQL, ${BOT_MIGRATIONS_DIR}) ===`,
    bot,
  ].join("\n\n");
}
