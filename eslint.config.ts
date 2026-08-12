import type { ESLint } from "eslint";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
// @ts-expect-error -- eslint-plugin-drizzle ships no type declarations
import drizzlePlugin from "eslint-plugin-drizzle";
import tseslint from "typescript-eslint";

const drizzle = drizzlePlugin as ESLint.Plugin;

export default tseslint.config(
  {
    ignores: ["**/.next/**", "**/node_modules/**"],
  },
  ...nextCoreWebVitals,
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { drizzle },
    extends: [
      ...tseslint.configs.recommended,
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
    // Vendored from the Watermelon registry via `pnpm ui:add`. `tsc` still
    // checks these files; only the type-aware lint rules are dropped, because
    // re-adding a component overwrites the file and takes any hand-fix with it.
    files: ["sites/web/src/components/ui/**/*.tsx"],
    extends: [tseslint.configs.disableTypeChecked],
    linterOptions: { reportUnusedDisableDirectives: false },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-empty-function": "off",
    },
  },
  {
    // React Vitest files are not in the root tsconfig (importing them would
    // pull the Next app into root `tsc` without image-module decls).
    files: ["tests/**/*.tsx"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
