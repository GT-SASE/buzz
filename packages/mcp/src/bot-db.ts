import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { BOT_MIGRATIONS_DIR } from "./bot";
import { repoPath } from "./repo";

type Row = Record<string, string | boolean | null>;

/** Each Drizzle migration's SQL, in the order drizzle-kit runs them. */
function migrationsUp(): { name: string; sql: string }[] {
  const dir = repoPath(BOT_MIGRATIONS_DIR);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(path.join(dir, name), "utf8").replaceAll(
        "--> statement-breakpoint",
        "",
      ),
    }));
}

const USER_SCHEMA = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`;

/**
 * Applies the bot's migrations to an in-memory PGlite, each in its own
 * transaction, then describes what they made from the catalogs.
 * A migration that fails to apply throws; there is no partial output.
 */
async function describe(): Promise<string> {
  // Loaded on demand: PGlite is heavy and only this tool needs it.
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  try {
    await db.waitReady;
    for (const { name, sql } of migrationsUp()) {
      await db.exec("BEGIN");
      try {
        await db.exec(sql);
        await db.exec("COMMIT");
      } catch (e) {
        await db.exec("ROLLBACK");
        throw new Error(
          `bot migration ${name} failed: ${(e as Error).message}`,
        );
      }
    }
    // With only pg_catalog visible, every user type prints schema-qualified.
    await db.exec("SET search_path = pg_catalog");
    const q = async (sql: string) => (await db.query<Row>(sql)).rows;

    const columns = await q(`
      SELECT n.nspname AS schema, c.relname AS table, a.attname AS name,
             format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
             pg_get_expr(d.adbin, d.adrelid) AS "default", a.attidentity AS identity,
             a.attgenerated AS generated
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE c.relkind IN ('r', 'p') AND ${USER_SCHEMA}
      ORDER BY n.nspname, c.relname, a.attnum`);
    const constraints = await q(`
      SELECT n.nspname AS schema, c.relname AS table, k.conname AS name,
             k.contype AS kind, pg_get_constraintdef(k.oid) AS def
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND ${USER_SCHEMA} AND k.contype <> 'n'
      ORDER BY n.nspname, c.relname, k.contype, k.conname`);
    const indexes = await q(`
      SELECT n.nspname AS schema, c.relname AS table, pg_get_indexdef(i.indexrelid) AS def,
             i.indexrelid IN (SELECT conindid FROM pg_constraint) AS from_constraint
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${USER_SCHEMA}
      ORDER BY n.nspname, c.relname, i.indexrelid::regclass::text`);
    const enums = await q(`
      SELECT n.nspname AS schema, t.typname AS name,
             string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS "values"
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE ${USER_SCHEMA}
      GROUP BY n.nspname, t.typname ORDER BY n.nspname, t.typname`);
    const domains = await q(`
      SELECT n.nspname AS schema, t.typname AS name,
             format_type(t.typbasetype, t.typtypmod) AS type
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typtype = 'd' AND ${USER_SCHEMA}
      ORDER BY n.nspname, t.typname`);
    const functions = await q(`
      SELECT n.nspname AS schema, p.proname AS name,
             pg_get_function_arguments(p.oid) AS args,
             pg_get_function_result(p.oid) AS returns,
             l.lanname AS language, p.prosecdef AS security_definer
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      WHERE p.prokind IN ('f', 'p') AND ${USER_SCHEMA}
      ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)`);
    const schemas = await q(`
      SELECT n.nspname AS schema FROM pg_namespace n
      WHERE ${USER_SCHEMA} ORDER BY n.nspname`);

    const out: string[] = [];
    for (const { schema } of schemas as { schema: string }[]) {
      const body: string[] = [];
      const tables = [
        ...new Set(
          columns.filter((c) => c.schema === schema).map((c) => c.table),
        ),
      ];
      for (const table of tables) {
        const lines = [`table ${schema}.${table as string}`];
        for (const c of columns.filter(
          (x) => x.schema === schema && x.table === table,
        )) {
          const flags = [
            c.not_null ? "notNull" : "",
            c.default ? `default ${c.default as string}` : "",
            c.identity ? "identity" : "",
            c.generated ? "generated" : "",
          ].filter(Boolean);
          lines.push(
            `  ${c.name as string}  ${c.type as string}${flags.length ? `  ${flags.join(" ")}` : ""}`,
          );
        }
        for (const k of constraints.filter(
          (x) => x.schema === schema && x.table === table,
        )) {
          lines.push(`  CONSTRAINT ${k.name as string}: ${k.def as string}`);
        }
        for (const i of indexes.filter(
          (x) => x.schema === schema && x.table === table && !x.from_constraint,
        )) {
          lines.push(`  ${i.def as string}`);
        }
        body.push(lines.join("\n"));
      }
      for (const e of enums.filter((x) => x.schema === schema)) {
        body.push(`enum ${schema}.${e.name as string}: ${e.values as string}`);
      }
      for (const d of domains.filter((x) => x.schema === schema)) {
        body.push(`domain ${schema}.${d.name as string}: ${d.type as string}`);
      }
      for (const f of functions.filter((x) => x.schema === schema)) {
        const attrs = [
          f.language as string,
          f.security_definer ? "security definer" : "",
        ].filter(Boolean);
        body.push(
          `function ${schema}.${f.name as string}(${f.args as string}) returns ${f.returns as string}  [${attrs.join(", ")}]`,
        );
      }
      if (body.length)
        out.push(`-- schema ${schema} --\n\n${body.join("\n\n")}`);
    }
    return out.join("\n\n");
  } finally {
    await db.close();
  }
}

let cached: Promise<string> | undefined;

/** The whole bot database, described once per process. A failure is not cached. */
function botDatabaseText(): Promise<string> {
  cached ??= describe().catch((e: unknown) => {
    cached = undefined;
    throw e;
  });
  return cached;
}

/**
 * Keeps the blocks (separated by blank lines) whose first line names an object
 * matching `filter`, plus each schema heading that still has a block.
 */
export async function formatBotDatabase(filter?: string): Promise<string> {
  const text = await botDatabaseText();
  const f = filter?.trim().toLowerCase();
  if (!f) return text;
  const out: string[] = [];
  let heading: string | undefined;
  for (const block of text.split("\n\n")) {
    if (block.startsWith("-- schema ")) {
      const [head, ...rest] = block.split("\n");
      heading = head;
      if (rest.some(Boolean)) out.push(block);
      continue;
    }
    const name = /^(?:table|enum|domain|function) \S*?\.([^\s(:]+)/.exec(
      block,
    )?.[1];
    if (name?.toLowerCase().includes(f)) {
      if (heading && !out.includes(heading)) out.push(heading);
      out.push(block);
    }
  }
  return out.length ? out.join("\n\n") : "No matching bot database objects.";
}
