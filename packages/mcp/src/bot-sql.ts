import { listDir, readRepoFile } from "./repo";

export const BOT_MIGRATIONS_DIR = "sites/discord-bot/db/migrations";

export type BotColumn = { name: string; type: string; flags: string[] };
export type BotTable = {
  schema: string;
  name: string;
  columns: BotColumn[];
  constraints: string[];
  indexes: string[];
};
export type BotEnum = { schema: string; name: string; values: string[] };
export type BotDomain = { schema: string; name: string; type: string };
export type BotFunction = {
  schema: string;
  name: string;
  args: string;
  returns: string;
  attributes: string[];
};
export type BotDatabase = {
  schemas: string[];
  tables: BotTable[];
  enums: BotEnum[];
  domains: BotDomain[];
  functions: BotFunction[];
};

const DOLLAR = /^\$[A-Za-z_]*\$/;

/**
 * Walks SQL once, tracking quotes and dollar-quoted bodies. `onTop` sees each
 * character that is outside both and returns "skip" to drop it, "cut" to end
 * the current statement, or nothing to keep it.
 */
function scan(
  sql: string,
  onTop: (c: string, i: number) => "skip" | "cut" | undefined,
): string[] {
  const out: string[] = [];
  let cur = "";
  let dollar: string | null = null;
  let quoted = false;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        cur += dollar;
        i += dollar.length;
        dollar = null;
      } else cur += sql[i++];
    } else if (quoted) {
      cur += c;
      if (c === "'") quoted = false;
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "'") {
      quoted = true;
      cur += c;
      i++;
    } else if (c === "$" && DOLLAR.test(sql.slice(i, i + 40))) {
      dollar = DOLLAR.exec(sql.slice(i, i + 40))![0];
      cur += dollar;
      i += dollar.length;
    } else {
      const action = onTop(c, i);
      if (action === "cut") {
        if (cur.trim()) out.push(cur.trim());
        cur = "";
      } else if (action !== "skip") cur += c;
      i++;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Splits on `;` outside quotes and dollar-quoted bodies. */
export function splitStatements(sql: string): string[] {
  const down = sql.search(/^--\s*migrate:down/m);
  return scan(down >= 0 ? sql.slice(0, down) : sql, (c) =>
    c === ";" ? "cut" : undefined,
  );
}

/** Splits on top-level commas (not inside parens or quotes). */
function splitTopLevel(s: string): string[] {
  let depth = 0;
  return scan(s, (c) => {
    if (c === "(") depth++;
    if (c === ")") depth--;
    return c === "," && depth === 0 ? "cut" : undefined;
  });
}

/** Text between the first `(` and its matching `)`, and what follows. */
function balanced(s: string): { inner: string; rest: string } | null {
  const start = s.indexOf("(");
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'") quoted = !quoted;
    if (quoted) continue;
    if (c === "(") depth++;
    if (c === ")" && --depth === 0) {
      return { inner: s.slice(start + 1, i), rest: s.slice(i + 1) };
    }
  }
  return null;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const unquote = (s: string) => s.replace(/^"|"$/g, "");
const IDENT = String.raw`(?:"[^"]+"|[\w$]+)`;
const NAME = String.raw`(${IDENT}(?:\.${IDENT})?)`;
const re = (source: string, flags = "i") => new RegExp(source, flags);

function parseColumn(def: string): BotColumn | null {
  const m = /^("[^"]+"|\w+)\s+(.*)$/s.exec(collapse(def));
  if (!m) return null;
  const rest = m[2]!;
  const cut = rest.search(
    /\s(?:NOT NULL|NULL|DEFAULT|GENERATED|CONSTRAINT|PRIMARY KEY|UNIQUE|CHECK|REFERENCES)\b/i,
  );
  const type = cut >= 0 ? rest.slice(0, cut) : rest;
  const tail = cut >= 0 ? rest.slice(cut) : "";
  const flags: string[] = [];
  if (/\bPRIMARY KEY\b/i.test(tail)) flags.push("primary");
  if (/\bNOT NULL\b/i.test(tail)) flags.push("notNull");
  if (/\bDEFAULT\b/i.test(tail)) flags.push("default");
  if (/\bGENERATED\b/i.test(tail)) flags.push("generated");
  return { name: unquote(m[1]!), type: type.trim(), flags };
}

const CONSTRAINT_START =
  /^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b/i;

function constraintLine(def: string): string | null {
  const m = /^(?:CONSTRAINT\s+("[^"]+"|\w+)\s+)?(.*)$/is.exec(collapse(def));
  const name = m?.[1] ? unquote(m[1]) : "";
  const body = m?.[2] ?? "";
  if (/^CHECK\b/i.test(body)) return `CHECK ${name}`.trim();
  if (/^PRIMARY KEY/i.test(body)) return `PK ${name}: ${body.slice(11).trim()}`;
  if (/^UNIQUE/i.test(body)) return `UNIQUE ${name}: ${body.slice(6).trim()}`;
  if (/^FOREIGN KEY/i.test(body)) {
    return `FK ${name}: ${body.slice(11).trim()}`;
  }
  if (/^EXCLUDE/i.test(body)) return `EXCLUDE ${name}`.trim();
  return null;
}

/** Constraint lines start with a kind and a name; a re-added name replaces the old line. */
function constraintName(line: string): string {
  return /^\w+ ([^\s:]+)/.exec(line)?.[1] ?? "";
}

function dropConstraint(t: BotTable, name: string) {
  t.constraints = t.constraints.filter((c) => constraintName(c) !== name);
}

/** Argument types only: drops names and defaults so `DROP FUNCTION f(uuid, text)` matches. */
function argTypes(args: string): string[] {
  if (!args.trim()) return [];
  return splitTopLevel(args).map((p) => {
    const noDefault = collapse(
      p
        .replace(/\s+DEFAULT\b.*$/is, "")
        .replace(/^(?:IN|OUT|INOUT|VARIADIC)\s+/i, ""),
    ).toLowerCase();
    // `p_id uuid` -> `uuid`; a bare type has no name to drop.
    const parts = noDefault.split(" ");
    return parts.length > 1 &&
      !/^(?:double|time|timestamp|character|bit)/.test(parts.slice(1).join(" "))
      ? parts.slice(1).join(" ")
      : noDefault;
  });
}

function sameSignature(a: string, b: string): boolean {
  const ta = argTypes(a);
  const tb = argTypes(b);
  return (
    ta.length === tb.length &&
    ta.every((t, i) => t === tb[i] || t.endsWith(tb[i]!) || tb[i]!.endsWith(t))
  );
}

/**
 * Replays the bot's dbmate migrations in file order and returns the resulting
 * objects. Objects keep the schema their SQL names; unqualified names use the
 * migration's `SET [LOCAL] search_path`, else `public`.
 */
export function parseBotSql(
  files: { name: string; sql: string }[],
): BotDatabase {
  const db: BotDatabase = {
    schemas: [],
    tables: [],
    enums: [],
    domains: [],
    functions: [],
  };
  const split = (qualified: string, current: string) => {
    const parts = qualified.split(".").map(unquote);
    return parts.length === 2
      ? { schema: parts[0]!, name: parts[1]! }
      : { schema: current, name: parts[0]! };
  };
  const findTable = (q: string, cur: string) => {
    const { schema, name } = split(q, cur);
    return db.tables.find((t) => t.schema === schema && t.name === name);
  };
  const addSchema = (s: string) => {
    if (!db.schemas.includes(s)) db.schemas.push(s);
  };
  const findCol = (t: BotTable, id: string) =>
    t.columns.find((c) => c.name === unquote(id));

  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    let current = "public";
    for (const stmt of splitStatements(file.sql)) {
      let m: RegExpExecArray | null;

      if (
        (m = re(
          String.raw`^SET\s+(?:LOCAL\s+|SESSION\s+)?search_path\s*(?:TO|=)\s*([^,\s]+)`,
        ).exec(stmt))
      ) {
        const s = unquote(m[1]!.replace(/'/g, ""));
        if (s) current = s;
      } else if (
        (m = re(String.raw`^CREATE SCHEMA\s+(?:IF NOT EXISTS\s+)?(\S+)`).exec(
          stmt,
        ))
      ) {
        addSchema(unquote(m[1]!));
      } else if (
        (m = re(`^ALTER SCHEMA\\s+${NAME}\\s+RENAME TO\\s+(\\S+)`).exec(stmt))
      ) {
        const from = unquote(m[1]!);
        const to = unquote(m[2]!);
        for (const xs of [db.tables, db.enums, db.domains, db.functions]) {
          for (const x of xs) if (x.schema === from) x.schema = to;
        }
        db.schemas = db.schemas.map((s) => (s === from ? to : s));
        if (current === from) current = to;
      } else if (
        (m = re(`^CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?${NAME}\\s*\\(`).exec(
          stmt,
        ))
      ) {
        const { schema, name } = split(m[1]!, current);
        const t: BotTable = {
          schema,
          name,
          columns: [],
          constraints: [],
          indexes: [],
        };
        for (const part of splitTopLevel(balanced(stmt)?.inner ?? "")) {
          if (CONSTRAINT_START.test(part)) {
            const line = constraintLine(part);
            if (line) t.constraints.push(line);
            continue;
          }
          const col = parseColumn(part);
          if (col) t.columns.push(col);
        }
        addSchema(schema);
        db.tables.push(t);
      } else if (
        (m = re(
          `^ALTER TABLE\\s+(?:IF EXISTS\\s+)?(?:ONLY\\s+)?${NAME}\\s+RENAME TO\\s+(${IDENT})\\s*$`,
        ).exec(stmt))
      ) {
        const t = findTable(m[1]!, current);
        if (t) t.name = unquote(m[2]!);
      } else if (
        (m = re(
          `^ALTER TABLE\\s+(?:IF EXISTS\\s+)?(?:ONLY\\s+)?${NAME}\\s+(.*)$`,
          "is",
        ).exec(stmt))
      ) {
        const t = findTable(m[1]!, current);
        if (!t) continue;
        for (const action of splitTopLevel(m[2]!)) {
          let a: RegExpExecArray | null;
          if ((a = /^ADD COLUMN\s+(?:IF NOT EXISTS\s+)?(.*)$/is.exec(action))) {
            const col = parseColumn(a[1]!);
            if (col) t.columns.push(col);
          } else if (
            (a = re(`^DROP COLUMN\\s+(?:IF EXISTS\\s+)?(${IDENT})`).exec(
              action,
            ))
          ) {
            t.columns = t.columns.filter((c) => c.name !== unquote(a![1]!));
          } else if (
            (a = re(`^DROP CONSTRAINT\\s+(?:IF EXISTS\\s+)?(${IDENT})`).exec(
              action,
            ))
          ) {
            dropConstraint(t, unquote(a[1]!));
          } else if (
            (a =
              /^ADD\s+((?:CONSTRAINT|PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY).*)$/is.exec(
                action,
              ))
          ) {
            const line = constraintLine(a[1]!);
            if (line) {
              dropConstraint(t, constraintName(line));
              t.constraints.push(line);
            }
          } else if (
            (a = re(`^RENAME COLUMN\\s+(${IDENT})\\s+TO\\s+(${IDENT})`).exec(
              action,
            ))
          ) {
            const col = findCol(t, a[1]!);
            if (col) col.name = unquote(a[2]!);
          } else if (
            (a = re(
              `^ALTER COLUMN\\s+(${IDENT})\\s+(?:SET DATA\\s+)?TYPE\\s+(.*?)(?:\\s+USING\\b.*)?$`,
              "is",
            ).exec(action))
          ) {
            const col = findCol(t, a[1]!);
            if (col) col.type = collapse(a[2]!);
          } else if (
            (a = re(`^ALTER COLUMN\\s+(${IDENT})\\s+SET NOT NULL`).exec(action))
          ) {
            const col = findCol(t, a[1]!);
            if (col && !col.flags.includes("notNull"))
              col.flags.push("notNull");
          } else if (
            (a = re(`^ALTER COLUMN\\s+(${IDENT})\\s+DROP NOT NULL`).exec(
              action,
            ))
          ) {
            const col = findCol(t, a[1]!);
            if (col) col.flags = col.flags.filter((f) => f !== "notNull");
          }
        }
      } else if (
        (m = re(`^DROP TABLE\\s+(?:IF EXISTS\\s+)?${NAME}`).exec(stmt))
      ) {
        const { schema, name } = split(m[1]!, current);
        db.tables = db.tables.filter(
          (t) => !(t.schema === schema && t.name === name),
        );
      } else if (
        (m = re(
          `^CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF NOT EXISTS\\s+)?(${IDENT})\\s+ON\\s+(?:ONLY\\s+)?${NAME}\\s*(?:USING\\s+\\w+\\s*)?(.*)$`,
          "is",
        ).exec(stmt))
      ) {
        const t = findTable(m[3]!, current);
        const cols = balanced(m[4]!);
        const where = /\bWHERE\s+(.*)$/is.exec(cols?.rest ?? "")?.[1];
        t?.indexes.push(
          `${m[1] ? "UNIQUE " : ""}INDEX ${unquote(m[2]!)}: (${collapse(cols?.inner ?? "")})${where ? ` WHERE ${collapse(where)}` : ""}`,
        );
      } else if (
        (m = re(
          `^DROP INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF EXISTS\\s+)?${NAME}`,
        ).exec(stmt))
      ) {
        const n = unquote(m[1]!.split(".").at(-1)!);
        for (const t of db.tables) {
          t.indexes = t.indexes.filter((i) => !i.includes(`INDEX ${n}:`));
        }
      } else if (
        (m = re(`^CREATE TYPE\\s+${NAME}\\s+AS\\s+ENUM\\s*\\(`).exec(stmt))
      ) {
        const { schema, name } = split(m[1]!, current);
        const values = [
          ...(balanced(stmt)?.inner ?? "").matchAll(/'((?:[^']|'')*)'/g),
        ].map((v) => v[1]!.replace(/''/g, "'"));
        addSchema(schema);
        db.enums.push({ schema, name, values });
      } else if (
        (m = re(
          `^ALTER TYPE\\s+${NAME}\\s+ADD VALUE\\s+(?:IF NOT EXISTS\\s+)?'((?:[^']|'')*)'(?:\\s+(BEFORE|AFTER)\\s+'((?:[^']|'')*)')?`,
        ).exec(stmt))
      ) {
        const { schema, name } = split(m[1]!, current);
        const e = db.enums.find((x) => x.schema === schema && x.name === name);
        if (!e) continue;
        const ref = m[4] ? e.values.indexOf(m[4].replace(/''/g, "'")) : -1;
        const at =
          ref < 0
            ? e.values.length
            : m[3]!.toUpperCase() === "BEFORE"
              ? ref
              : ref + 1;
        e.values.splice(at, 0, m[2]!.replace(/''/g, "'"));
      } else if (
        (m = re(`^DROP TYPE\\s+(?:IF EXISTS\\s+)?${NAME}`).exec(stmt))
      ) {
        const { schema, name } = split(m[1]!, current);
        const keep = (x: { schema: string; name: string }) =>
          !(x.schema === schema && x.name === name);
        db.enums = db.enums.filter(keep);
        db.domains = db.domains.filter(keep);
      } else if (
        (m = re(`^CREATE DOMAIN\\s+${NAME}\\s+AS\\s+(\\S+)`).exec(stmt))
      ) {
        const { schema, name } = split(m[1]!, current);
        addSchema(schema);
        db.domains.push({ schema, name, type: m[2]! });
      } else if (
        (m = re(
          `^CREATE\\s+(?:OR REPLACE\\s+)?(?:FUNCTION|PROCEDURE)\\s+${NAME}\\s*\\(`,
        ).exec(stmt))
      ) {
        const { schema, name } = split(m[1]!, current);
        const b = balanced(stmt);
        if (!b) continue;
        const args = collapse(b.inner);
        const head = b.rest.split(/\bAS\s+\$/i)[0] ?? b.rest;
        const returns =
          /\bRETURNS\s+(.*?)(?=\s+(?:LANGUAGE|SECURITY|SET|STABLE|IMMUTABLE|VOLATILE|STRICT|PARALLEL|COST)\b|$)/is.exec(
            head,
          )?.[1];
        const attributes = [
          /\bLANGUAGE\s+(\w+)/i.exec(head)?.[1]?.toLowerCase(),
          /\bSECURITY DEFINER\b/i.test(head) ? "security definer" : undefined,
        ].filter((x): x is string => Boolean(x));
        addSchema(schema);
        db.functions = db.functions.filter(
          (f) =>
            !(
              f.schema === schema &&
              f.name === name &&
              sameSignature(f.args, args)
            ),
        );
        db.functions.push({
          schema,
          name,
          args,
          returns: collapse(returns ?? ""),
          attributes,
        });
      } else if (
        (m = re(
          `^DROP (?:FUNCTION|PROCEDURE)\\s+(?:IF EXISTS\\s+)?${NAME}\\s*(\\(.*\\))?`,
          "is",
        ).exec(stmt))
      ) {
        const { schema, name } = split(m[1]!, current);
        const args = m[2] ? collapse(m[2].slice(1, -1)) : null;
        db.functions = db.functions.filter(
          (f) =>
            !(
              f.schema === schema &&
              f.name === name &&
              (args === null || sameSignature(f.args, args))
            ),
        );
      }
    }
  }
  const order = (
    a: { schema: string; name: string },
    b: { schema: string; name: string },
  ) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name);
  db.tables.sort(order);
  db.enums.sort(order);
  db.domains.sort(order);
  db.functions.sort(order);
  return db;
}

export function readBotDatabase(): BotDatabase {
  const files = listDir(BOT_MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((name) => ({ name, sql: readRepoFile(BOT_MIGRATIONS_DIR, name) }));
  return parseBotSql(files);
}

export function formatBotDatabase(filter?: string): string {
  const db = readBotDatabase();
  const f = filter?.trim().toLowerCase();
  const hit = (n: string) => !f || n.toLowerCase().includes(f);
  const out: string[] = [];
  const schemas = [
    ...new Set([...db.schemas, ...db.tables.map((t) => t.schema)]),
  ].sort();
  for (const schema of schemas) {
    const body: string[] = [];
    for (const t of db.tables.filter(
      (x) => x.schema === schema && hit(x.name),
    )) {
      const lines = [`table ${schema}.${t.name}`];
      for (const c of t.columns) {
        lines.push(
          `  ${c.name}  ${c.type}${c.flags.length ? `  ${c.flags.join(" ")}` : ""}`,
        );
      }
      for (const c of t.constraints) lines.push(`  ${c}`);
      for (const i of t.indexes) lines.push(`  ${i}`);
      body.push(lines.join("\n"));
    }
    for (const e of db.enums.filter(
      (x) => x.schema === schema && hit(x.name),
    )) {
      body.push(`enum ${schema}.${e.name}: ${e.values.join(", ")}`);
    }
    for (const d of db.domains.filter(
      (x) => x.schema === schema && hit(x.name),
    )) {
      body.push(`domain ${schema}.${d.name}: ${d.type}`);
    }
    for (const fn of db.functions.filter(
      (x) => x.schema === schema && hit(x.name),
    )) {
      const attrs = fn.attributes.length
        ? `  [${fn.attributes.join(", ")}]`
        : "";
      body.push(
        `function ${schema}.${fn.name}(${fn.args}) returns ${fn.returns}${attrs}`,
      );
    }
    if (body.length) out.push(`-- schema ${schema} --\n\n${body.join("\n\n")}`);
  }
  return out.length ? out.join("\n\n") : "No matching bot database objects.";
}
