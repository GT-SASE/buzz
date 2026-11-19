import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

import { rel, repoPath } from "./repo";

export type Procedure = {
  path: string;
  access: string;
  kind: string;
  file: string;
  line: number;
};

const apiSrc = repoPath("packages/api/src");

const parse = (file: string) =>
  ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

const lineOf = (sf: ts.SourceFile, node: ts.Node) =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** Leftmost expression of a call/property chain, e.g. `adminProcedure`. */
function chainRoot(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isCallExpression(cur) ||
    ts.isPropertyAccessExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isParenthesizedExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

function topLevelConsts(sf: ts.SourceFile) {
  const out: { name: string; init: ts.Expression }[] = [];
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer) {
        out.push({ name: d.name.text, init: d.initializer });
      }
    }
  }
  return out;
}

/** Procedure builders defined in trpc.ts: chains rooted at `t.procedure`. */
export function procedureBuilders(): string[] {
  const sf = parse(path.join(apiSrc, "trpc.ts"));
  const builders = new Set<string>();
  for (const { name, init } of topLevelConsts(sf)) {
    const root = chainRoot(init);
    if (!ts.isIdentifier(root)) continue;
    if (
      (root.text === "t" && /^t\s*\.\s*procedure\b/.test(init.getText(sf))) ||
      builders.has(root.text)
    ) {
      builders.add(name);
    }
  }
  return [...builders];
}

function isRouterCall(e: ts.Expression): e is ts.CallExpression {
  return (
    ts.isCallExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "createTRPCRouter"
  );
}

function collect(
  sf: ts.SourceFile,
  routerCall: ts.CallExpression,
  prefix: string,
  builders: Set<string>,
  out: Procedure[],
) {
  const obj = routerCall.arguments[0];
  if (!obj || !ts.isObjectLiteralExpression(obj)) return;
  const locals = new Map(topLevelConsts(sf).map((c) => [c.name, c.init]));
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    const full = `${prefix}${prop.name.text}`;
    let init = prop.initializer;
    if (ts.isIdentifier(init) && locals.has(init.text)) {
      init = locals.get(init.text)!;
    }
    if (isRouterCall(init)) {
      collect(sf, init, `${full}.`, builders, out);
      continue;
    }
    const root = chainRoot(init);
    const kind =
      ts.isCallExpression(init) &&
      ts.isPropertyAccessExpression(init.expression)
        ? init.expression.name.text
        : "";
    if (
      ts.isIdentifier(root) &&
      builders.has(root.text) &&
      ["query", "mutation", "subscription"].includes(kind)
    ) {
      out.push({
        path: full,
        access: root.text.replace(/Procedure$/, ""),
        kind,
        file: rel(sf.fileName),
        line: lineOf(sf, prop),
      });
    }
  }
}

export function listProcedures(): Procedure[] {
  const builders = new Set(procedureBuilders());
  const root = parse(path.join(apiSrc, "root.ts"));

  const imports = new Map<string, string>();
  for (const st of root.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings)
      continue;
    const spec = (st.moduleSpecifier as ts.StringLiteral).text;
    const bindings = st.importClause.namedBindings;
    if (!spec.startsWith(".") || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      imports.set(el.name.text, path.join(apiSrc, `${spec}.ts`));
    }
  }

  const out: Procedure[] = [];
  const app = topLevelConsts(root).find((c) => c.name === "appRouter");
  const obj = app && isRouterCall(app.init) ? app.init.arguments[0] : undefined;
  if (!obj || !ts.isObjectLiteralExpression(obj)) return out;

  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    if (!ts.isIdentifier(prop.initializer)) continue;
    const varName = prop.initializer.text;
    const file = imports.get(varName);
    if (!file) continue;
    const sf = parse(file);
    const decl = topLevelConsts(sf).find((c) => c.name === varName);
    if (decl && isRouterCall(decl.init)) {
      collect(sf, decl.init, `${prop.name.text}.`, builders, out);
    }
  }
  return out;
}

export function formatProcedures(filter?: string): string {
  const all = listProcedures();
  const f = filter?.trim().toLowerCase();
  const rows = f ? all.filter((p) => p.path.toLowerCase().includes(f)) : all;
  return [
    `builders (packages/api/src/trpc.ts): ${procedureBuilders().join(", ")}`,
    `${rows.length}/${all.length} procedures`,
    ...rows.map((p) => `${p.path}  ${p.access} ${p.kind}  ${p.file}:${p.line}`),
  ].join("\n");
}
