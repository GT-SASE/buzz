/**
 * A small stand-in for PostgREST, for fast local runs. Real PostgREST is the
 * authority, and if the two ever disagree, the stand-in is wrong. CI runs only
 * test/db/access-layer.test.ts against it, through `npm run test:postgrest`, so every
 * other test file reaches the database through this stand-in alone. A request shape
 * new to `src/db/` needs a case in that file, or real PostgREST never sees it.
 *
 * It reads the requests the database layer sends and runs them on PGlite as
 * service_role, so tests still exercise the real schema, grants, triggers and
 * functions. It handles only what `src/db/` uses and throws on anything else. PGlite
 * has one connection, so requests run one at a time here and never truly race.
 */

import type { PGlite } from "@electric-sql/pglite";
import { queryAs } from "./harness.ts";

interface Relation {
  table: string;
  many: boolean;
  /** Pairs of parent column and child column. */
  on: [string, string][];
}

const RELATIONS = new Map<string, Relation>([
  [
    "tasks.events",
    {
      table: "events",
      many: false,
      on: [
        ["event_id", "id"],
        ["guild_id", "guild_id"],
      ],
    },
  ],
  [
    "events.managed_channels",
    {
      table: "managed_channels",
      many: false,
      on: [
        ["guild_id", "guild_id"],
        ["channel_id", "channel_id"],
      ],
    },
  ],
  [
    "managed_channels.guild_config",
    { table: "guild_config", many: false, on: [["guild_id", "guild_id"]] },
  ],
  [
    "tasks.reminder_log",
    { table: "reminder_log", many: true, on: [["id", "task_id"]] },
  ],
]);

const IDENTIFIER = /^[a-z_]+$/;
const RESERVED = new Set(["select", "order", "limit", "offset", "columns"]);
/** The one `or` the database layer sends: rows after a page position. */
const KEYSET =
  /^\(due_date\.gt\.([0-9-]+),and\(due_date\.eq\.([0-9-]+),id\.gt\.([0-9a-f-]+)\)\)$/;

function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`shim: unsupported identifier ${name}`);
  }
  return name;
}

interface SelectItem {
  name: string;
  inner: boolean;
  children: SelectItem[] | null;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current !== "") parts.push(current);
  return parts;
}

function parseSelect(text: string): SelectItem[] {
  return splitTopLevel(text).map((part) => {
    const open = part.indexOf("(");
    if (open === -1) {
      return { name: identifier(part), inner: false, children: null };
    }
    const head = part.slice(0, open);
    const inner = head.endsWith("!inner");
    return {
      name: identifier(inner ? head.slice(0, -"!inner".length) : head),
      inner,
      children: parseSelect(part.slice(open + 1, -1)),
    };
  });
}

interface Filter {
  path: string;
  column: string;
  operator: string;
  value: string;
}

function readFilters(params: URLSearchParams): Filter[] {
  const filters: Filter[] = [];
  for (const [key, raw] of params) {
    if (RESERVED.has(key)) continue;
    if (key === "or") {
      filters.push({ path: "", column: "", operator: "keyset", value: raw });
      continue;
    }
    const dot = raw.indexOf(".");
    const segments = key.split(".");
    const column = segments.pop() ?? "";
    filters.push({
      path: segments.join("."),
      column: identifier(column),
      operator: raw.slice(0, dot),
      value: raw.slice(dot + 1),
    });
  }
  return filters;
}

class Query {
  readonly params: unknown[] = [];

  bind(value: unknown): string {
    this.params.push(value);
    return `$${String(this.params.length)}`;
  }

  condition(alias: string, filter: Filter): string {
    const column = `${alias}.${filter.column}`;
    switch (filter.operator) {
      case "eq":
        return `${column} = ${this.bind(filter.value)}`;
      case "neq":
        return `${column} <> ${this.bind(filter.value)}`;
      case "lt":
        return `${column} < ${this.bind(filter.value)}`;
      case "gte":
        return `${column} >= ${this.bind(filter.value)}`;
      case "lte":
        return `${column} <= ${this.bind(filter.value)}`;
      case "is":
        if (!["null", "true", "false"].includes(filter.value)) {
          throw new Error("shim: unsupported is value");
        }
        return `${column} IS ${filter.value.toUpperCase()}`;
      case "ilike":
        // PostgREST turns every * into %, with no way to escape it.
        return `${column}::text ILIKE ${this.bind(filter.value.replaceAll("*", "%"))}`;
      case "in": {
        if (!filter.value.startsWith("(") || filter.value.includes('"')) {
          throw new Error("shim: unsupported in value");
        }
        const list = filter.value.slice(1, -1).split(",");
        return `${column}::text = ANY(${this.bind(list)}::text[])`;
      }
      case "keyset": {
        const match = KEYSET.exec(filter.value);
        const [, after, same, id] = match ?? [];
        if (after === undefined || after !== same || id === undefined) {
          throw new Error("shim: unsupported or value");
        }
        return `(${alias}.due_date > ${this.bind(after)} OR (${alias}.due_date = ${this.bind(after)} AND ${alias}.id > ${this.bind(id)}))`;
      }
      default:
        throw new Error(`shim: unsupported operator ${filter.operator}`);
    }
  }

  /** One object per row, plus the lateral joins its embedded resources need. */
  projection(
    table: string,
    alias: string,
    path: string,
    items: SelectItem[],
    filters: Filter[],
  ): { object: string; joins: string } {
    const fields: string[] = [];
    const joins: string[] = [];
    items.forEach((item, index) => {
      if (item.children === null) {
        fields.push(`'${item.name}', ${alias}.${item.name}`);
        return;
      }
      const relation = RELATIONS.get(`${table}.${item.name}`);
      if (relation === undefined) {
        throw new Error(`shim: no relation ${table}.${item.name}`);
      }
      const childPath = path === "" ? item.name : `${path}.${item.name}`;
      const childAlias = `${alias}_${String(index)}`;
      const inner = this.projection(
        relation.table,
        childAlias,
        childPath,
        item.children,
        filters,
      );
      const where = [
        ...relation.on.map(
          ([parent, child]) =>
            `${childAlias}.${child}::text = ${alias}.${parent}::text`,
        ),
        ...filters
          .filter((filter) => filter.path === childPath)
          .map((filter) => this.condition(childAlias, filter)),
      ].join(" AND ");
      const value = relation.many
        ? `coalesce(jsonb_agg(${inner.object}), '[]'::jsonb)`
        : inner.object;
      const source = `(SELECT ${value} AS obj FROM public.${relation.table} ${childAlias} ${inner.joins} WHERE ${where}) ${childAlias}_j`;
      joins.push(
        item.inner
          ? `CROSS JOIN LATERAL ${source}`
          : `LEFT JOIN LATERAL ${source} ON true`,
      );
      fields.push(`'${item.name}', ${childAlias}_j.obj`);
    });
    return {
      object: `jsonb_build_object(${fields.join(", ")})`,
      joins: joins.join(" "),
    };
  }
}

function orderClause(order: string | null): string {
  if (order === null) return "";
  const terms = order.split(",").map((term) => {
    const [column = "", direction = ""] = term.split(".");
    if (direction !== "asc" && direction !== "desc") {
      throw new Error("shim: unsupported order");
    }
    return `t0.${identifier(column)} ${direction}`;
  });
  return `ORDER BY ${terms.join(", ")}`;
}

function integerClause(keyword: string, value: string | null): string {
  if (value === null) return "";
  if (!/^[0-9]+$/.test(value)) throw new Error("shim: bad integer");
  return `${keyword} ${value}`;
}

async function runRead(
  db: PGlite,
  table: string,
  params: URLSearchParams,
): Promise<unknown[]> {
  const query = new Query();
  const filters = readFilters(params);
  const { object, joins } = query.projection(
    table,
    "t0",
    "",
    parseSelect(params.get("select") ?? ""),
    filters,
  );
  const where = filters
    .filter((filter) => filter.path === "")
    .map((filter) => query.condition("t0", filter));
  const sql = `SELECT ${object} AS row FROM public.${table} t0 ${joins}
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ${orderClause(params.get("order"))}
    ${integerClause("LIMIT", params.get("limit"))}
    ${integerClause("OFFSET", params.get("offset"))}`;
  const rows = await queryAs<{ row: unknown }>(
    db,
    "service_role",
    sql,
    query.params,
  );
  return rows.map((row) => row.row);
}

function bodyEntries(body: unknown): [string, unknown][] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("shim: writes must send one object");
  }
  return Object.entries(body).map(([key, value]: [string, unknown]) => [
    identifier(key),
    typeof value === "object" && value !== null ? JSON.stringify(value) : value,
  ]);
}

async function runUpdate(
  db: PGlite,
  table: string,
  params: URLSearchParams,
  body: unknown,
): Promise<unknown[]> {
  const query = new Query();
  const assignments = bodyEntries(body).map(
    ([column, value]) => `${column} = ${query.bind(value)}`,
  );
  const filters = readFilters(params);
  const { object } = query.projection(
    table,
    "t0",
    "",
    parseSelect(params.get("select") ?? ""),
    [],
  );
  const where = filters.map((filter) => query.condition("t0", filter));
  const sql = `UPDATE public.${table} AS t0 SET ${assignments.join(", ")}
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    RETURNING ${object} AS row`;
  const rows = await queryAs<{ row: unknown }>(
    db,
    "service_role",
    sql,
    query.params,
  );
  return rows.map((row) => row.row);
}

async function runInsert(
  db: PGlite,
  table: string,
  params: URLSearchParams,
  body: unknown,
): Promise<unknown[]> {
  const query = new Query();
  const entries = bodyEntries(body);
  const columns = entries.map(([column]) => column);
  const values = entries.map(([, value]) => query.bind(value));
  const { object } = query.projection(
    table,
    "t0",
    "",
    parseSelect(params.get("select") ?? ""),
    [],
  );
  const sql = `INSERT INTO public.${table} AS t0 (${columns.join(", ")})
    VALUES (${values.join(", ")}) RETURNING ${object} AS row`;
  const rows = await queryAs<{ row: unknown }>(
    db,
    "service_role",
    sql,
    query.params,
  );
  return rows.map((row) => row.row);
}

async function runFunction(
  db: PGlite,
  name: string,
  body: unknown,
): Promise<unknown> {
  const { rows } = await db.query<{ names: string[]; types: string[] }>(
    `SELECT p.proargnames AS names,
            ARRAY(SELECT format_type(t, NULL) FROM unnest(p.proargtypes) AS t) AS types
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = $1`,
    [identifier(name)],
  );
  const definition = rows[0];
  if (definition === undefined || typeof body !== "object" || body === null) {
    throw Object.assign(new Error("no such function"), { code: "PGRST202" });
  }
  const args = Object.entries(body).map(([key, value]: [string, unknown]) => {
    const index = definition.names.indexOf(key);
    if (index === -1) {
      throw Object.assign(new Error("no such argument"), { code: "PGRST202" });
    }
    return { key, value, type: definition.types[index] ?? "text" };
  });
  const query = new Query();
  const list = args
    .map(
      ({ key, value, type }) =>
        `${identifier(key)} => ${query.bind(value)}::${type}`,
    )
    .join(", ");
  const result = await queryAs<{ value: unknown }>(
    db,
    "service_role",
    `SELECT public.${name}(${list}) AS value`,
    query.params,
  );
  return result[0]?.value ?? null;
}

async function answer(
  db: PGlite,
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<Response> {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  const path = url.pathname.replace(/^\/rest\/v1\//, "");
  const method = init?.method ?? "GET";
  const body: unknown =
    typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  try {
    let payload: unknown;
    let status = 200;
    if (path.startsWith("rpc/")) {
      payload = await runFunction(db, path.slice("rpc/".length), body);
    } else if (method === "GET") {
      payload = await runRead(db, identifier(path), url.searchParams);
    } else if (method === "PATCH") {
      payload = await runUpdate(db, identifier(path), url.searchParams, body);
    } else if (method === "POST") {
      payload = await runInsert(db, identifier(path), url.searchParams, body);
      status = 201;
    } else {
      throw new Error(`shim: unsupported method ${method}`);
    }
    return Response.json(payload, { status });
  } catch (error) {
    const { code, message, detail, hint } = error as {
      code?: string;
      message?: string;
      detail?: string;
      hint?: string;
    };
    if (code === undefined) {
      throw error;
    }
    return Response.json(
      { code, message, details: detail ?? null, hint: hint ?? null },
      { status: code === "42501" ? 403 : code === "23505" ? 409 : 400 },
    );
  }
}

/** A `fetch` that answers PostgREST requests from the given database. */
export function postgrestShim(db: PGlite): typeof fetch {
  // queryAs changes the session's role, so two requests must not overlap on the one
  // connection PGlite has.
  let previous: Promise<unknown> = Promise.resolve();
  return (input, init) => {
    const next = previous.then(() => answer(db, input, init));
    previous = next.catch(() => undefined);
    return next;
  };
}
