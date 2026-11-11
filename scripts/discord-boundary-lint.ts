/**
 * ESLint rules that catch the direct ways of reaching Discord from outside
 * src/discord/client.ts, where the managed-channel check and the outbound body
 * type apply.
 *
 * These rules are a guard against mistakes, not a proof. A URL or module name
 * assembled from strings at runtime cannot be fully caught statically, so review
 * still has to look for it. Bare `fetch` is refused for any URL for the same
 * reason. scripts/check-discord-urls.sh covers files ESLint does not read.
 *
 * Tests and their helpers under test/ are exempt, because they hold Discord URLs as
 * fixtures and use a mocked `fetch`, and importing from a test file or from test/ is
 * refused so that this cannot become a way around the rules. The two scripts that
 * prepare a database for CI may import test/, because they reuse its migration
 * harness and do not ship. scripts/register-commands.ts is also exempt: a maintainer
 * runs it by hand, and it sends no user text and posts to no channel. src/db/client.ts
 * may use `fetch`, because it is the one caller of the database API and the other
 * rules still apply to it.
 *
 * Bodies can also reach Discord as an HTTP response, so only the endpoint files may
 * build a Response, and even there only through `new Response`. The cron endpoint is
 * called by Vercel and answers with fixed text.
 *
 * The `safe` tag is only for text written in the source. Calling it directly, or
 * writing a mention's syntax around a value, would get past the render boundary.
 *
 * Member names are not read at all, because rendering one would let any member put
 * text in a bot message. Refer to a person with `userMention`.
 */

import type { Linter } from "eslint";

const MESSAGE =
  "Only src/discord/client.ts should call Discord. Use its client, or allow a new non-Discord caller in scripts/discord-boundary-lint.ts.";

// A selector's regular expression cannot hold a slash, hence \x2F.
const DISCORD_URL = [
  String.raw`discord(app)?\.com`,
  String.raw`discord\.gg`,
  String.raw`\bapi\x2Fv[0-9]`,
  String.raw`^\x2F(channels|webhooks|interactions)\x2F`,
].join("|");

const BANNED_MODULES = [
  "^(node:)?(http2?|https|net|tls|dgram|vm)$",
  "^(axios|got|ky|node-fetch|superagent|ofetch|eris)$",
  "^undici(/|$)",
  // discord-api-types only describes the API, apart from the names banned below.
  "^discord(?!-api-types(/|$))",
  "^@discordjs/",
  String.raw`\.test(\.|$)`,
];
const TEST_DIRECTORY = "(^|/)test/";
const CHILD_PROCESS = "^(node:)?child_process$";

const GLOBALS = [
  "fetch",
  "globalThis",
  "global",
  "window",
  "self",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "navigator",
  "eval",
  "Function",
];

// These hold the API's URL and routes, with no Discord URL for a rule to see.
const API_TYPES_ROUTES = {
  regex: "^discord-api-types(/|$)",
  importNames: ["RouteBases", "Routes"],
  message: MESSAGE,
};

const MEMBER_NAME =
  "/^(nick|username|global_name|display_name|discriminator)$/";
const MEMBER_NAME_MESSAGE =
  "Member names are never rendered, because any member controls them. Use userMention with the ID.";
const RESPONSE_MESSAGE =
  "Only the endpoint file may build a Response, so that every body comes from the outbound builders through respond().";

const SAFE_MESSAGE =
  "Use safe only as a tag on source text, and userMention or channelMention for mentions.";

function selector(selector: string, message = MESSAGE) {
  return { selector, message };
}

function rules({
  modules,
  allowNewResponse,
  allowGlobals = [],
}: {
  modules: readonly string[];
  allowNewResponse: boolean;
  allowGlobals?: readonly string[];
}): Linter.RulesRecord {
  const dynamicModules = modules.join("|").replaceAll("/", String.raw`\x2F`);
  return {
    "no-restricted-globals": [
      "error",
      ...GLOBALS.filter((name) => !allowGlobals.includes(name)).map((name) => ({
        name,
        message: MESSAGE,
      })),
    ],
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          ...modules.map((regex) => ({ regex, message: MESSAGE })),
          API_TYPES_ROUTES,
        ],
      },
    ],
    "no-restricted-syntax": [
      "error",
      selector(`Literal[value=/${DISCORD_URL}/i]`),
      selector(`TemplateElement[value.raw=/${DISCORD_URL}/i]`),
      selector(`ImportExpression[source.value=/${dynamicModules}/]`),
      selector("ImportExpression[source.type!='Literal']"),
      selector("CallExpression[callee.name='require']"),
      selector("Identifier[name='createRequire']"),
      selector("Identifier[name='getBuiltinModule']"),
      selector("MemberExpression[object.name='Reflect'][property.name='get']"),
      selector("MemberExpression[object.name='Reflect'][property.value='get']"),
      selector("MemberExpression[property.name='constructor']"),
      selector("MemberExpression[property.value='constructor']"),
      selector(
        `MemberExpression[property.name=${MEMBER_NAME}]`,
        MEMBER_NAME_MESSAGE,
      ),
      selector(
        `MemberExpression[property.value=${MEMBER_NAME}]`,
        MEMBER_NAME_MESSAGE,
      ),
      selector(
        `ObjectPattern > Property[key.name=${MEMBER_NAME}]`,
        MEMBER_NAME_MESSAGE,
      ),
      selector(`Literal[value=${MEMBER_NAME}]`, MEMBER_NAME_MESSAGE),
      selector(
        `TemplateElement[value.raw=${MEMBER_NAME}]`,
        MEMBER_NAME_MESSAGE,
      ),
      selector("CallExpression[callee.name=/^(safe|plain)$/]", SAFE_MESSAGE),
      selector(
        String.raw`TaggedTemplateExpression[tag.name='safe'] TemplateElement[value.raw=/<[@#\x2F&]*$/]`,
        SAFE_MESSAGE,
      ),
      selector("MemberExpression[object.name='Response']", RESPONSE_MESSAGE),
      selector(
        allowNewResponse
          ? "NewExpression[callee.name='Response'] CallExpression[callee.object.name='JSON']"
          : "NewExpression[callee.name='Response']",
        RESPONSE_MESSAGE,
      ),
    ],
  };
}

const IGNORES = [
  "src/discord/client.ts",
  "scripts/register-commands.ts",
  "test/**",
  "**/*.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
];
const WITH_TEST_DIRECTORY = [...BANNED_MODULES, TEST_DIRECTORY];
const WITH_CHILD_PROCESS = [...WITH_TEST_DIRECTORY, CHILD_PROCESS];

export const discordBoundary: Linter.Config[] = [
  {
    name: "discord-boundary",
    files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    ignores: IGNORES,
    linterOptions: { noInlineConfig: true },
    rules: rules({ modules: WITH_TEST_DIRECTORY, allowNewResponse: false }),
  },
  {
    name: "discord-boundary/database-preparation",
    files: ["scripts/prepare-backup-db.ts", "scripts/prepare-postgrest-db.ts"],
    ignores: IGNORES,
    rules: rules({ modules: BANNED_MODULES, allowNewResponse: false }),
  },
  // Rule options replace rather than merge, so these blocks repeat the rest.
  // Scripts run on a maintainer's machine or in CI and may start other programs.
  {
    name: "discord-boundary/app",
    files: ["src/**", "api/**"],
    ignores: IGNORES,
    rules: rules({ modules: WITH_CHILD_PROCESS, allowNewResponse: false }),
  },
  {
    name: "discord-boundary/endpoint",
    files: ["api/interactions.ts", "api/cron/reminders.ts"],
    ignores: IGNORES,
    rules: rules({ modules: WITH_CHILD_PROCESS, allowNewResponse: true }),
  },
  {
    name: "discord-boundary/database-client",
    files: ["src/db/client.ts"],
    ignores: IGNORES,
    rules: rules({
      modules: WITH_CHILD_PROCESS,
      allowNewResponse: false,
      allowGlobals: ["fetch", "globalThis"],
    }),
  },
];
