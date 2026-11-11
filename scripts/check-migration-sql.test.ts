import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findDuplicatePrefixes,
  findDynamicExecutes,
} from "./check-migration-sql.ts";

describe("findDuplicatePrefixes", () => {
  it("flags a version used twice, once", () => {
    expect(
      findDuplicatePrefixes([
        "20261104000007_a.sql",
        "20261104000007_b.sql",
        "20261104000007_c.sql",
        "20261104000008_d.sql",
      ]),
    ).toEqual(["20261104000007"]);
  });

  it("allows different versions", () => {
    expect(
      findDuplicatePrefixes(["20261104000007_a.sql", "20261104000008_a.sql"]),
    ).toEqual([]);
  });

  it("finds none in this repo's migrations", () => {
    const dir = join(import.meta.dirname, "..", "supabase", "migrations");
    expect(findDuplicatePrefixes(readdirSync(dir))).toEqual([]);
  });
});

describe("findDynamicExecutes", () => {
  it.each([
    ["a string", "EXECUTE 'DROP TABLE public.tasks';"],
    ["lower case", "execute 'DROP TABLE public.tasks';"],
    ["a dollar-quoted string", "EXECUTE $q$DROP TABLE public.tasks$q$;"],
    ["format", "EXECUTE format('DROP TABLE %I', v_name);"],
    ["a variable", "EXECUTE v_sql;"],
    ["a string on the next line", "EXECUTE\n  'DROP TABLE public.tasks';"],
    ["after a comment marker in a string", "PERFORM '--'; EXECUTE p_sql;"],
    ["after a block marker in a string", "PERFORM '/*'; EXECUTE p_sql;"],
    ["after a comment that holds a marker", "/* -- */ EXECUTE p_sql;"],
    ["after a nested comment", "/* /* */ */ EXECUTE p_sql;"],
    ["on a line after a carriage return", "-- note\rEXECUTE p_sql;"],
    ["after a doubled quote", "PERFORM 'a''--'; EXECUTE p_sql;"],
    ["after a marker in an identifier", 'PERFORM "--"; EXECUTE p_sql;'],
    ["after a marker in a dollar string", "PERFORM $q$--$q$; EXECUTE p_sql;"],
    ["a variable named function", "EXECUTE function;"],
    ["a variable named procedure", "EXECUTE procedure;"],
    ["a variable named function in an expression", "EXECUTE function || 'x';"],
    ["a function named function", "EXECUTE function('x');"],
    ["a schema named function", "EXECUTE function.f('x');"],
    ["a function variable with USING", "EXECUTE function USING (1);"],
    ["a procedure variable with USING", "EXECUTE procedure USING (1);"],
    ["a function variable with INTO", "EXECUTE function INTO r;"],
    [
      "a function variable with USING in a body",
      "AS $$ begin EXECUTE function USING (1); end $$;",
    ],
    [
      "a function variable with USING in a loop",
      "FOR r IN EXECUTE function USING (1) LOOP",
    ],
    [
      "a function variable with USING after a trigger",
      "CREATE TRIGGER t BEFORE INSERT ON x EXECUTE FUNCTION f(); EXECUTE function USING (1);",
    ],
    ["a trigger target with no CREATE TRIGGER", "EXECUTE FUNCTION f();"],
    ["a trigger clause with no CREATE", "TRIGGER t EXECUTE FUNCTION f();"],
    ["a CREATE that is not a trigger", "CREATE TABLE t EXECUTE FUNCTION f();"],
    [
      "a quoted word that is not CREATE",
      '"CREATE" TRIGGER t EXECUTE FUNCTION f();',
    ],
    [
      "a CREATE TRIGGER that does not begin its statement",
      "AS $$ begin CREATE TRIGGER t BEFORE INSERT ON x EXECUTE FUNCTION f(); end $$;",
    ],
    [
      "a semicolon in a string that is not a boundary",
      "PERFORM ';' CREATE TRIGGER t BEFORE INSERT ON x EXECUTE FUNCTION f();",
    ],
    [
      "a trigger target that is a string",
      "CREATE TRIGGER t BEFORE INSERT ON x EXECUTE FUNCTION 'f'();",
    ],
    [
      "a trigger target with no arguments",
      "CREATE TRIGGER t BEFORE INSERT ON x EXECUTE FUNCTION f;",
    ],
    ["a quoted variable", 'EXECUTE "on";'],
    ["in a dollar-quoted body", "AS $$ begin EXECUTE p_sql; end $$;"],
    ["in a tagged body", "AS $fn$ begin EXECUTE p_sql; end $fn$;"],
    [
      "in a body after a nested dollar string",
      "AS $fn$ begin PERFORM $q$--$q$; EXECUTE p_sql; end $fn$;",
    ],
    ["in a single-quoted body", "AS 'begin EXECUTE p_sql; end';"],
    [
      "in a single-quoted body after a marker",
      "AS 'begin PERFORM ''--''; EXECUTE p_sql; end';",
    ],
    ["where a dollar in a name is not a quote", "a$b$ EXECUTE p_sql; $b$"],
    ["an E string with an escape", String.raw`AS E'begin \x45XECUTE p; end';`],
    ["an E string that ends a comment", String.raw`AS E'--\n EXECUTE p';`],
    ["a Unicode string", String.raw`AS U&'begin \0045XECUTE p; end';`],
  ])("flags %s", (_name, sql) => {
    expect(findDynamicExecutes(sql)).toHaveLength(1);
  });

  it.each([
    ["a grant", "GRANT EXECUTE ON FUNCTION public.f() TO service_role;"],
    ["a revoke", "REVOKE EXECUTE ON FUNCTION public.f() FROM PUBLIC;"],
    [
      "a default privilege",
      "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;",
    ],
    [
      "a trigger",
      "CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW EXECUTE FUNCTION public.f();",
    ],
    ["a lower-case trigger", "create trigger t execute function f();"],
    [
      "an old-style trigger",
      "CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW EXECUTE PROCEDURE public.f();",
    ],
    [
      "a trigger on the next line",
      "CREATE TRIGGER t BEFORE INSERT ON x\n  FOR EACH ROW\n  EXECUTE FUNCTION public.f();",
    ],
    [
      "a trigger with a WHEN clause",
      "CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION f();",
    ],
    ["a replaced trigger", "CREATE OR REPLACE TRIGGER t EXECUTE FUNCTION f();"],
    [
      "a constraint trigger",
      "CREATE CONSTRAINT TRIGGER t EXECUTE FUNCTION f();",
    ],
    ["an event trigger", "CREATE EVENT TRIGGER t EXECUTE FUNCTION f();"],
    [
      "a trigger after a statement",
      "SELECT 1; CREATE TRIGGER t BEFORE INSERT ON x EXECUTE FUNCTION f();",
    ],
    ["a comment", "-- never EXECUTE 'a string' here\nSELECT 1;"],
    ["another word", "SELECT executed FROM t;"],
    ["a block comment", "/* EXECUTE p_sql; */ SELECT 1;"],
    ["a nested block comment", "/* /* */ EXECUTE p_sql; */ SELECT 1;"],
    ["a quoted column", 'SELECT "EXECUTE" FROM t;'],
    ["a grant with a comment inside", "GRANT EXECUTE /* a */ ON f TO r;"],
    [
      "a quoted trigger function",
      'CREATE TRIGGER t BEFORE INSERT ON x EXECUTE FUNCTION "a"."b"();',
    ],
    [
      "a trigger with a marker before it",
      "/* -- */ CREATE TRIGGER t BEFORE INSERT ON x EXECUTE FUNCTION f();",
    ],
    [
      "a trigger in a body",
      "$$ begin NULL; CREATE TRIGGER t BEFORE INSERT ON x EXECUTE FUNCTION public.f('a'); end $$",
    ],
    ["an E string with no backslash", "SELECT E'plain';"],
    ["a plain string with a backslash", String.raw`SELECT 'a\';`],
  ])("allows %s", (_name, sql) => {
    expect(findDynamicExecutes(sql)).toEqual([]);
  });

  it.each([
    ["a no-break space", " "],
    ["an emoji", "\u{1F600}"],
    ["a non-ASCII digit", "٣"],
  ])("reads a dollar tag holding %s as Postgres does", (_label, char) => {
    const tag = `$${char}$`;

    expect(
      findDynamicExecutes(`PERFORM ${tag} /* ${tag}; EXECUTE p; -- */`),
    ).toEqual([1]);
  });

  it.each([
    ["SET", "SET standard_conforming_strings = off;"],
    ["SET in another case", "set Standard_Conforming_Strings to off;"],
    ["a quoted name", 'SET "standard_conforming_strings" = off;'],
    [
      "set_config",
      "SELECT set_config('standard_conforming_strings', 'off', 1);",
    ],
    [
      "a function body",
      "DO $$ begin SET standard_conforming_strings = off; end $$;",
    ],
  ])("flags a change to standard_conforming_strings by %s", (_label, sql) => {
    expect(findDynamicExecutes(sql)).toEqual([1]);
  });

  it("does not open a dollar tag inside a non-ASCII name", () => {
    expect(
      findDynamicExecutes("SELECT 1 AS  $x$ '$x$ /* '; EXECUTE p; -- */"),
    ).toEqual([1]);
  });

  it("reports the line of each one", () => {
    expect(
      findDynamicExecutes("SELECT 1;\nEXECUTE 'a';\n\nEXECUTE 'b';"),
    ).toEqual([2, 4]);
  });

  it("reads past a backslash quote in an E string", () => {
    expect(findDynamicExecutes(String.raw`SELECT E'\'--'; EXECUTE p;`)).toEqual(
      [1, 1],
    );
  });

  it("reports the line inside a multi-line body", () => {
    expect(
      findDynamicExecutes(
        "CREATE FUNCTION f()\nAS $$\nbegin\n  PERFORM '--';\n  EXECUTE p;\nend $$;",
      ),
    ).toEqual([5]);
    expect(findDynamicExecutes("AS '\nbegin\n  EXECUTE p;\nend';")).toEqual([
      3,
    ]);
  });

  it("ends safely on unclosed text", () => {
    expect(findDynamicExecutes("SELECT 'a")).toEqual([]);
    expect(findDynamicExecutes("/* a")).toEqual([]);
    expect(findDynamicExecutes("$$ a")).toEqual([]);
    expect(findDynamicExecutes("'EXECUTE p")).toEqual([1]);
  });

  it("finds none in this repo's migrations", () => {
    const dir = join(import.meta.dirname, "..", "supabase", "migrations");
    const found = readdirSync(dir).flatMap((file) =>
      findDynamicExecutes(readFileSync(join(dir, file), "utf8")),
    );

    expect(found).toEqual([]);
  });
});
