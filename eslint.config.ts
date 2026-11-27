import eslintJs from "@eslint/js";
import type { ESLint } from "eslint";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
// @ts-expect-error -- eslint-plugin-drizzle ships no type declarations
import drizzlePlugin from "eslint-plugin-drizzle";
import path from "node:path";
import tseslint, { type ConfigArray } from "typescript-eslint";

const drizzle = drizzlePlugin as ESLint.Plugin;

const botDir = path.join(import.meta.dirname, "sites/discord-bot");
const SEND_THROUGH_CLIENT = "Send to Discord through src/discord/client.ts.";
const discordRoutes = {
  regex: "^discord-api-types(/.*)?$",
  importNames: ["RouteBases", "Routes"],
  message: SEND_THROUGH_CLIENT,
};
const databaseOnlyInDb = {
  regex: "^(@neondatabase/.*|pg|@electric-sql/pglite)$|/db/internal(\\.ts)?$",
  message: "Only src/db/ may use the database driver. Use the functions there.",
};

/** Keeps the web rules off the bot, which has its own stricter set below. */
const exceptBot = (configs: ConfigArray): ConfigArray =>
  configs.map((config) =>
    // A block of only `ignores` is global, and adding the bot would ignore it.
    Object.keys(config).every((key) => key === "ignores" || key === "name")
      ? config
      : {
          ...config,
          ignores: [...(config.ignores ?? []), "sites/discord-bot/**"],
        },
  );

const webAndTooling = tseslint.config(
  ...nextCoreWebVitals,
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { drizzle },
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    rules: {
      "@next/next/no-html-link-for-pages": "off",
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      "drizzle/enforce-delete-with-where": [
        "error",
        { drizzleObjectName: ["db", "ctx.db"] },
      ],
      "drizzle/enforce-update-with-where": [
        "error",
        { drizzleObjectName: ["db", "ctx.db"] },
      ],
    },
  },
  {
    linterOptions: { reportUnusedDisableDirectives: true },
    languageOptions: { parserOptions: { projectService: true } },
    settings: {
      react: { version: "19.2" },
      // The Next app is a workspace, not the repo root. Without this the Next
      // plugin looks for `pages/` beside this config, fails, and prints
      // "Pages directory cannot be found" on every lint run.
      next: { rootDir: ["sites/web/"] },
    },
  },
  {
    // Vendored from the Watermelon registry via `bun run ui:add`. `tsc` still
    // checks these files; only the type-aware lint rules are dropped, because
    // re-adding a component overwrites the file and takes any hand-fix with it.
    files: ["sites/web/src/components/ui/**/*.tsx"],
    extends: [tseslint.configs.disableTypeChecked],
    linterOptions: { reportUnusedDisableDirectives: false },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-empty-function": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // bun-types declares `mock.module` as `void | Promise<void>` and types
    // `expect(...).rejects` as void, so these rules flag correct test code.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            { from: "package", package: "bun-types", name: "module" },
          ],
        },
      ],
    },
  },
  {
    // React test files are not in the root tsconfig (importing them would
    // pull the Next app into root `tsc` without image-module decls).
    files: ["tests/**/*.tsx"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Next's bundled Babel parser ships a scope manager without `addGlobals`,
    // which ESLint 10 calls on every file.
    files: ["**/*.{js,mjs,cjs,jsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: false },
    },
  },
);

export default tseslint.config(
  {
    ignores: [
      "**/.next/**",
      "**/node_modules/**",
      "**/.vercel/**",
      "**/.tools/**",
      // Manual bench tool, not shipped or tested; pokes at pg internals.
      "scripts/bench-procedures.ts",
    ],
  },
  ...exceptBot(webAndTooling),
  {
    files: ["sites/discord-bot/**/*.ts"],
    extends: [
      eslintJs.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: botDir },
    },
  },
  {
    // Only the Discord client sends to Discord, so that every send runs the managed
    // channel check. Only src/db/ talks to the database.
    name: "discord-bot/one-send-path",
    files: ["sites/discord-bot/{src,api}/**/*.ts"],
    ignores: ["sites/discord-bot/src/discord/client.ts", "**/*.test.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: SEND_THROUGH_CLIENT },
      ],
      "no-restricted-imports": [
        "error",
        { patterns: [discordRoutes, databaseOnlyInDb] },
      ],
    },
  },
  {
    name: "discord-bot/db-driver",
    files: ["sites/discord-bot/src/db/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [discordRoutes] }],
    },
  },
);
