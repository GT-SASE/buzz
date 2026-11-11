/**
 * Fails if a migration uses dynamic SQL. A string run through EXECUTE cannot be
 * reviewed like the rest of a migration, and inside a SECURITY DEFINER function it is
 * how an argument becomes an injection.
 *
 * The EXECUTE in GRANT or REVOKE EXECUTE ON is a privilege, and in EXECUTE FUNCTION or
 * PROCEDURE at the end of a CREATE TRIGGER statement it is a trigger target, so those
 * are allowed. Outside CREATE TRIGGER, function and procedure can be variable names, so
 * `EXECUTE function USING (1)` is dynamic SQL. A CREATE TRIGGER that does not begin its
 * statement, as straight after BEGIN in a function body, is flagged as well, which is
 * the safe way round.
 *
 * The SQL is split into tokens the way Postgres does it, so that a comment marker in a
 * string, or a comment before the keyword, cannot hide anything. A function body is a
 * string, so the contents of every string are read as SQL too. A string that only
 * mentions the word is flagged as well, which is the safe way round. Text is not put
 * back together across strings, and an author who means to hide something has easier
 * ways, so this is a guard against mistakes, and review still has to read a migration.
 *
 * Also fails if two migrations share a version number.
 *
 * Usage: node scripts/check-migration-sql.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(
  import.meta.dirname,
  "..",
  "supabase",
  "migrations",
);

// Postgres takes any non-ASCII character as part of a name or a dollar tag, including
// a no-break space or an emoji.
const WORD_START = /[A-Za-z0-9_\u0080-\u{10FFFF}]/u;
const WORD = /[A-Za-z0-9_$\u0080-\u{10FFFF}]+/uy;
const DOLLAR_TAG =
  /\$(?:[A-Za-z_\u0080-\u{10FFFF}][A-Za-z0-9_\u0080-\u{10FFFF}]*)?\$/uy;

interface Token {
  kind: "word" | "quoted" | "string" | "other";
  text: string;
  line: number;
}

/**
 * Each version number used by more than one migration. Supabase records a migration by
 * that number, so a second file with the same one can be skipped without any error, and
 * the order of the two is left to their names.
 */
export function findDuplicatePrefixes(files: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const file of files) {
    const prefix = file.split("_", 1)[0] ?? file;
    if (seen.has(prefix)) {
      duplicates.add(prefix);
    }
    seen.add(prefix);
  }
  return [...duplicates];
}

/** The index just past the comment that starts at `start`. Block comments nest. */
function endOfComment(sql: string, start: number): number {
  if (sql.startsWith("--", start)) {
    const rest = sql.slice(start).search(/[\r\n]/);
    return rest === -1 ? sql.length : start + rest;
  }
  let depth = 0;
  let index = start;
  while (index < sql.length) {
    if (sql.startsWith("/*", index)) {
      depth += 1;
      index += 2;
    } else if (sql.startsWith("*/", index)) {
      depth -= 1;
      index += 2;
      if (depth === 0) {
        return index;
      }
    } else {
      index += 1;
    }
  }
  return sql.length;
}

/** The index just past the quoted text opened at `start`. A doubled quote stays open. */
function endOfQuoted(sql: string, start: number, backslashes: boolean): number {
  const quote = sql.charAt(start);
  let index = start + 1;
  while (index < sql.length) {
    const char = sql.charAt(index);
    if (backslashes && char === "\\") {
      index += 2;
    } else if (char !== quote) {
      index += 1;
    } else if (sql.charAt(index + 1) === quote) {
      index += 2;
    } else {
      return index + 1;
    }
  }
  return sql.length;
}

function isName(token: Token | undefined): boolean {
  return token?.kind === "word" || token?.kind === "quoted";
}

/** Whether the statement holding the token at `at` begins with CREATE ... TRIGGER. */
function isInCreateTrigger(tokens: readonly Token[], at: number): boolean {
  let index = at;
  while (index > 0) {
    const previous = tokens[index - 1];
    if (previous?.kind === "other" && previous.text === ";") {
      break;
    }
    index -= 1;
  }
  const word = (position: number): string | undefined => {
    const token = tokens[position];
    return token?.kind === "word" ? token.text.toUpperCase() : undefined;
  };
  if (word(index) !== "CREATE") {
    return false;
  }
  index += 1;
  if (word(index) === "OR" && word(index + 1) === "REPLACE") {
    index += 2;
  }
  if (word(index) === "CONSTRAINT" || word(index) === "EVENT") {
    index += 1;
  }
  return word(index) === "TRIGGER";
}

/** Whether the EXECUTE at `at` is `EXECUTE ON`, or a trigger's `EXECUTE FUNCTION name(`. */
function isAllowedExecute(tokens: readonly Token[], at: number): boolean {
  const next = tokens[at + 1];
  if (next?.kind !== "word") {
    return false;
  }
  const keyword = next.text.toUpperCase();
  // ON is a reserved word, so no variable can have that name.
  if (keyword === "ON") {
    return true;
  }
  if (keyword !== "FUNCTION" && keyword !== "PROCEDURE") {
    return false;
  }
  if (!isInCreateTrigger(tokens, at)) {
    return false;
  }
  let index = at + 2;
  if (!isName(tokens[index])) {
    return false;
  }
  index += 1;
  while (tokens[index]?.text === "." && isName(tokens[index + 1])) {
    index += 2;
  }
  return tokens[index]?.text === "(";
}

function scan(sql: string, firstLine: number, found: number[]): void {
  const tokens: Token[] = [];
  let index = 0;
  let line = firstLine;
  const moveTo = (end: number) => {
    line += sql.slice(index, end).split("\n").length - 1;
    index = end;
  };
  const readBody = (body: string, end: number) => {
    tokens.push({ kind: "string", text: body, line });
    scan(body, line, found);
    moveTo(end);
  };
  const readString = (backslashes: boolean) => {
    const end = endOfQuoted(sql, index, backslashes);
    const closed = end - 1 > index && sql.charAt(end - 1) === "'";
    const body = sql.slice(index + 1, closed ? end - 1 : end);
    readBody(body.replaceAll("''", "'"), end);
  };

  while (index < sql.length) {
    const char = sql.charAt(index);
    if (sql.startsWith("--", index) || sql.startsWith("/*", index)) {
      moveTo(endOfComment(sql, index));
    } else if (char === "'") {
      readString(false);
    } else if (char === '"') {
      const end = endOfQuoted(sql, index, false);
      tokens.push({ kind: "quoted", text: sql.slice(index, end), line });
      moveTo(end);
    } else if (char === "$") {
      DOLLAR_TAG.lastIndex = index;
      const tag = DOLLAR_TAG.exec(sql)?.[0];
      if (tag === undefined) {
        tokens.push({ kind: "other", text: char, line });
        moveTo(index + 1);
      } else {
        const start = index + tag.length;
        const close = sql.indexOf(tag, start);
        if (close === -1) {
          readBody(sql.slice(start), sql.length);
        } else {
          readBody(sql.slice(start, close), close + tag.length);
        }
      }
    } else if (WORD_START.test(char)) {
      WORD.lastIndex = index;
      const word = WORD.exec(sql)?.[0] ?? char;
      const after = index + word.length;
      const prefix = word.toUpperCase();
      if (prefix === "E" && sql.charAt(after) === "'") {
        // A backslash can spell a keyword or end a comment, which this scan would not
        // see, and no migration needs one.
        moveTo(after);
        const end = endOfQuoted(sql, index, true);
        if (sql.slice(index, end).includes("\\")) {
          found.push(line);
        }
        readString(true);
      } else if (prefix === "U" && sql.startsWith("&'", after)) {
        // The same goes for these, whose escape character the file can choose.
        found.push(line);
        moveTo(after + 1);
        readString(false);
      } else {
        tokens.push({ kind: "word", text: word, line });
        moveTo(after);
      }
    } else {
      if (!/\s/.test(char)) {
        tokens.push({ kind: "other", text: char, line });
      }
      moveTo(index + 1);
    }
  }

  tokens.forEach((token, at) => {
    if (
      token.kind === "word" &&
      token.text.toUpperCase() === "EXECUTE" &&
      !isAllowedExecute(tokens, at)
    ) {
      found.push(token.line);
    }
    // Turned off, this makes a backslash escape a quote in a plain string, which this
    // scan would not see, and no migration needs to change it.
    if (
      (token.kind === "word" || token.kind === "quoted") &&
      token.text.replaceAll('"', "").toLowerCase() ===
        "standard_conforming_strings"
    ) {
      found.push(token.line);
    }
  });
}

/**
 * The 1-based line of each dynamic EXECUTE in a migration's SQL, and of each escape
 * string or setting that could hide one.
 */
export function findDynamicExecutes(sql: string): number[] {
  const found: number[] = [];
  scan(sql, 1, found);
  return found.sort((a, b) => a - b);
}

function main(): void {
  const files = readdirSync(MIGRATIONS_DIR).filter((name) =>
    name.endsWith(".sql"),
  );
  if (files.length === 0) {
    throw new Error(`no migrations found in ${MIGRATIONS_DIR}`);
  }

  let failed = false;
  for (const prefix of findDuplicatePrefixes(files)) {
    console.error(`${prefix}: more than one migration uses this version`);
    failed = true;
  }
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const line of findDynamicExecutes(sql)) {
      console.error(
        `${file}:${String(line)}: dynamic EXECUTE, or an escape string or setting that could hide one, is not allowed`,
      );
      failed = true;
    }
  }
  if (failed) {
    process.exit(1);
  }
  console.log(
    `Checked ${String(files.length)} migrations: no dynamic EXECUTE, no repeated version.`,
  );
}

if (import.meta.main) {
  main();
}
