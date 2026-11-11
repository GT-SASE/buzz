import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import { builtinRules } from "eslint/use-at-your-own-risk";
import tseslint from "typescript-eslint";
import { discordBoundary } from "./scripts/discord-boundary-lint.ts";

/** Methods whose first argument names a table, column or function, or a whole filter. */
const NAMED_FIRST_ARGUMENT =
  "match|imatch|order|select|from|textSearch|rpc|eq|neq|is|gt|gte|lt|lte|in|like|ilike|contains|containedBy|overlaps";

/** Client methods the bot has no use for, and that could widen or redirect a query. */
const BANNED_METHODS = [
  "filter",
  "not",
  "upsert",
  "delete",
  "schema",
  "setHeader",
  "explain",
  "ilikeAnyOf",
  "ilikeAllOf",
  "likeAnyOf",
  "likeAllOf",
  "regexMatch",
  "regexIMatch",
  "notIn",
  "isDistinct",
  "throwOnError",
  "rollback",
  "csv",
  "geojson",
  "abortSignal",
  "returns",
  "overrideTypes",
  "getOpenApiSpec",
  "range",
  "rangeGt",
  "rangeGte",
  "rangeLt",
  "rangeLte",
  "rangeAdjacent",
].join("|");

const TABLES =
  "guild_config|managed_channels|events|tasks|reminder_log|job_runs|config_audit|interaction_claims|task_reassignments";

// Every extension Node or the TypeScript compiler could load, so that a file cannot
// step around these rules by its name.
const EXTENSIONS = "{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

const SUPABASE_ONLY_IN_DB = "Only src/db/ may load Supabase packages.";
const QUERIES_ONLY_IN_DB = "Database queries belong in src/db/.";

// A rule's options replace rather than merge across config blocks, so using the
// core rule names here would silently switch off the Discord boundary on the same
// files. The same core rules under another name run alongside it instead.
const dbRules = {
  rules: {
    imports: builtinRules.get("no-restricted-imports"),
    syntax: builtinRules.get("no-restricted-syntax"),
  },
};

export default defineConfig([
  globalIgnores(["coverage/", "dist/", ".tools/"]),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  ...discordBoundary,
  {
    name: "db/outside-boundary",
    files: [`**/*.${EXTENSIONS}`],
    ignores: ["src/db/**"],
    plugins: { db: dbRules },
    rules: {
      "db/imports": [
        "error",
        {
          patterns: [
            { group: ["@supabase/*"], message: SUPABASE_ONLY_IN_DB },
            {
              group: ["**/db/internal", "**/db/internal.ts"],
              message: "Only src/db/ can reach the query client.",
            },
          ],
        },
      ],
      "db/syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/^@supabase\\//]",
          message: SUPABASE_ONLY_IN_DB,
        },
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.value=/^@supabase\\//]",
          message: SUPABASE_ONLY_IN_DB,
        },
        {
          selector:
            "CallExpression[callee.property.name=/^(rpc|or|textSearch|ilike)$/]",
          message: QUERIES_ONLY_IN_DB,
        },
        {
          selector: `CallExpression[callee.property.name='from'][arguments.0.value=/^(${TABLES})$/]`,
          message: QUERIES_ONLY_IN_DB,
        },
        // A hash has update() too, and Node's digest API offers no other way to feed one.
        {
          selector:
            "CallExpression[callee.property.name=/^(update|insert|upsert)$/]:not([callee.object.callee.name=/^(createHash|createHmac)$/])",
          message: QUERIES_ONLY_IN_DB,
        },
        // Map, Set and Headers delete by a key, while the query method takes none.
        {
          selector:
            "CallExpression[callee.property.name='delete']:not([arguments.0.type=/^(Literal|Identifier|MemberExpression|TemplateLiteral)$/])",
          message: QUERIES_ONLY_IN_DB,
        },
      ],
    },
  },
  {
    name: "db/query-shape",
    files: [`src/db/**/*.${EXTENSIONS}`],
    ignores: [`src/db/**/*.test.${EXTENSIONS}`],
    linterOptions: { noInlineConfig: true },
    plugins: { db: dbRules },
    rules: {
      "db/syntax": [
        "error",
        {
          selector: `CallExpression[callee.property.name=/^(${NAMED_FIRST_ARGUMENT})$/]:not([arguments.0.type='Literal'])`,
          message:
            "Tables, columns, functions and filters must be string literals. Only values vary.",
        },
        {
          selector:
            "CallExpression[callee.property.name='or']:not([arguments.0.type='Literal']):not([arguments.0.callee.name='keysetAfter'])",
          message: ".or() takes a literal, or the output of keysetAfter().",
        },
        {
          selector:
            "CallExpression[callee.property.name='select'][arguments.0.value=/[*]/]",
          message: "List the columns. Do not select everything.",
        },
        {
          selector:
            "CallExpression[callee.property.name='in']:not([arguments.1.callee.name=/^(snowflakeList|uuidList)$/])",
          message:
            ".in() values must be passed through snowflakeList() or uuidList().",
        },
        {
          selector:
            "CallExpression[callee.property.name=/^(ilike|like)$/]:not([arguments.1.callee.name='searchPattern'])",
          message: "Search patterns must be built by searchPattern().",
        },
        {
          selector:
            "CallExpression[callee.property.name=/^(insert|update)$/]:not([arguments.0.type='ObjectExpression'])",
          message: "Written values must be a literal object.",
        },
        {
          selector:
            "CallExpression[callee.property.name='rpc']:not([arguments.1.type='ObjectExpression'])",
          message: "RPC arguments must be a literal object.",
        },
        {
          selector:
            "CallExpression[callee.property.name=/^(rpc|insert|update)$/] > ObjectExpression > SpreadElement",
          message: "Name each written field. Do not spread into a write.",
        },
        {
          selector:
            "CallExpression[callee.property.name=/^(rpc|insert|update)$/] > ObjectExpression > Property[computed=true]",
          message: "Name each written field. Do not compute a key.",
        },
        {
          selector: `CallExpression[callee.property.name=/^(${BANNED_METHODS})$/]`,
          message: "The bot does not use this query method.",
        },
        {
          selector: "CallExpression[callee.computed=true]",
          message: "Call methods by name.",
        },
        {
          selector: "MemberExpression[property.name=/^(url|headers)$/]",
          message: "Do not reach into a query's URL or headers.",
        },
      ],
    },
  },
]);
