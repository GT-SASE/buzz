import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

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
  {
    // Only the Discord client sends to Discord, so that every send runs the managed
    // channel check. Only src/db/ talks to the database.
    name: "discord/one-send-path",
    files: ["{src,api}/**/*.ts"],
    ignores: ["src/discord/client.ts", "**/*.test.ts"],
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
    name: "db/driver",
    files: ["src/db/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [discordRoutes] }],
    },
  },
]);
