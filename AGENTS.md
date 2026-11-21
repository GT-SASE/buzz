# AGENTS.md

Guide for coding agents working on buzz, the GT SASE chapter site plus member portal.
Bun monorepo: Next.js 16, NextAuth, tRPC, Drizzle on Postgres. README.md has the full
narrative and `docs/site-structure.md` has diagrams. This file is the short, verified version.

## MCP server

`.mcp.json` registers a stdio MCP server (`packages/mcp`, run with `bun packages/mcp/src/index.ts`
from the repo root). It derives everything from the source at call time, so prefer it over
trusting any list in prose, including this file:

- `buzz_guide` this file (also the resource `buzz://AGENTS.md`)
- `buzz_trpc_procedures [filter]` every tRPC procedure: access, query/mutation, file:line
- `buzz_db_schema [table] [database=all|buzz|bot]` buzz Drizzle tables (columns, keys, indexes) and the bot's tables, enums, domains and functions with signatures, read from the catalogs of an in-memory PGlite after applying `sites/discord-bot/db/migrations`, grouped by schema; a failing migration is returned as the error
- `buzz_migrations` buzz Drizzle SQL and the bot's dbmate files, latest of each, and each process (bot production migrations are a manual owner step)
- `buzz_routes` Next routes tagged marketing / portal member / portal admin / api, plus the bot's Vercel functions and crons
- `buzz_bot_commands [filter]` the bot's slash commands, subcommands and options, from the definitions `register-commands.ts` sends
- `buzz_version` footer version rule, computed build, every workspace (including `@buzz/discord-bot`) with mismatches flagged, README table
- `buzz_run_checks tasks=[lint|typecheck|format|test|typecheck:tsc|bot:test|bot:test:db|bot:test:db:concurrency] [force]` runs turbo; `test`, `bot:test` and `bot:test:db` are refused unless the server env has `TEST_DATABASE_URL` on a local scratch DB; `bot:test:db:concurrency` also needs `CONCURRENCY_DATABASE_URL` passing the same guard
- `buzz_deploy_status` latest main commit, its Vercel status, the latest GitHub CI conclusion for main (Vercel success alone is not enough), live footer version

## Layout

```
packages/api/src/root.ts        appRouter; every router must be added here by hand
packages/api/src/routers/*.ts   tRPC routers (chapter committee election event member mentorship page resume)
packages/api/src/trpc.ts        context and procedure builders (protected, admin, superAdmin)
packages/api/src/*.ts           pure helpers (page-slug, terms, rate-limit, ...) with unit tests
packages/db/src/schema.ts       Drizzle schema; all tables are prefixed buzz_
packages/db/drizzle/            generated SQL migrations + meta; commit them
packages/db/scripts/            seeds
packages/auth/src/              NextAuth config and auth()
packages/mcp/src/               this MCP server
sites/discord-bot/              the events Discord bot: api/ (Vercel functions), src/, db/migrations (dbmate), its own README and docs/
sites/web/src/app/(marketing)/  public pages, prerendered; [slug] serves CMS pages
sites/web/src/app/portal/(member)/        member portal pages (needs a session)
sites/web/src/app/portal/(member)/admin/  officer pages; adminNav lives in sites/web/src/data/portal.ts
sites/web/src/app/api/          route handlers (trpc, auth, health, resume)
sites/web/src/components/ui/    vendored Watermelon UI (do not hand-fix; `bun run ui:add`)
sites/web/src/components/site/  editorial components built on ui
sites/web/src/data/             content constants and cached loaders (chapter-events.ts, pages.ts)
sites/web/src/trpc/             tRPC client/server glue for the app
tests/                          all tests (bun test); tests/setup, tests/helpers, tests/mocks
scripts/                        vercel-build.mjs, smoke.mjs, ci-test.mjs
```

## Commands (run from repo root, Bun only)

Use `bun`, `bun run`, `bun x`. Never npm, pnpm, npx, bunx. Spell out `bun run test`: bare `bun test` skips the DOM setup.

- `bun run dev`, `bun run build`, `bun run vercel-build` (migrates when `DATABASE_URL` is set, then builds)
- `bun run check` = turbo `//#lint typecheck //#typecheck:self //#format:check //#test test test:db` (the last two are the Discord bot's unit and PGlite tests)
- `bun run test` = `test:node` (`--isolate`, ignores `*.tsx`) then `test:dom` (`.test.tsx`, happy-dom preload in `tests/setup/dom.ts`)
- `bun run typecheck` (tsrs, fast) and `bun run typecheck:tsc` (tsc, the deciding check)
- `bun run format:write`, `bun run lint:fix`
- `bun run db:generate | db:migrate | db:push | db:seed | db:studio`
- `bun run smoke` = `bun scripts/smoke.mjs` against the live site
- Discord bot (`sites/discord-bot`, `bun run --cwd sites/discord-bot <script>`): `build` (Vercel Build Output in `.vercel/output`), `smoke` (loads the built functions from a temp folder, expects 401s), `test`, `test:db`, `test:db:concurrency` (needs `CONCURRENCY_DATABASE_URL` and `BOT_APP_PASSWORD`, see its README), `db:migrate` (dbmate into the `discord_bot` schema, which must exist first; `DATABASE_URL` of a disposable DB only)
- `bun run hooks:install` and `bun run gitleaks:install`: pre-push secret scan, rules in `.gitleaks.toml`

## Tests

- The bot's tests are excluded from root `test:node` because they need their own preload (`sites/discord-bot/test/support/setup.ts`); they run as the turbo tasks `test` and `test:db` from that folder.
- bun test. Mock modules with `mock.module(...)` (see `tests/page-router.test.ts`: mock `packages/auth`, then `await import` the router).
- Router tests use a fake `db`; `*.integration.test.ts` use a real Postgres through `TEST_DATABASE_URL` only and wrap the suite in `describe.skipIf(!process.env.DATABASE_URL)`.
- `tests/setup/env.ts` (bunfig preload) copies `TEST_DATABASE_URL` into `DATABASE_URL` and deletes it when unset, so unset means DB suites skip.
- `.tsx` tests need the happy-dom preload; they only run in `test:dom`.

## Turbo

`check`, `typecheck`, `typecheck:tsc` are cached by input. The cache is shared across git worktrees, so a second worktree can replay green logs without running anything: add `--force` for independent verification. In Git Bash prefix with `MSYS_NO_PATHCONV=1` or `//#lint` is rewritten into a path. `SKIP_ENV_VALIDATION=1` skips portal env validation.

Remote cache (Vercel, team `sasegt`) is optional and off by default. Locally: `bun x turbo login`, then `bun x turbo link` and pick `sasegt`. CI reads repo secret `TURBO_TOKEN` (Vercel access token scoped to `sasegt`) and repo variable `TURBO_TEAM` (team slug); when either is empty, e.g. fork PRs, turbo uses the local cache that `actions/cache` restores. `remoteCache.signature` stays off: with it on and no `TURBO_REMOTE_CACHE_SIGNATURE_KEY`, uploads fail with "artifact signature error". `bun run vercel-build` runs `next build` directly, not turbo, so Vercel builds do not use the remote cache.

## Safety

- The repo-root `.env` is the PRODUCTION database. Never run tests, migrations or scripts against it. `bunfig.toml` sets `env = false` so Bun does not auto-load it.
- Test against a disposable Postgres and export both `DATABASE_URL` and `TEST_DATABASE_URL` to it before `db:migrate` and `check`.
- Never probe `/api/health` or any DB-backed route for uptime or liveness; it wakes and loads the production database. Check the footer version on `/` instead (`buzz_deploy_status`).
- Do not paste secrets into commits, PRs or logs.

## Workflow

1. Branch from `origin/main` (`feat/...`, `fix/...`); use a git worktree for parallel work.
2. Commit, push, open a PR to `main`. Commits and PRs carry no AI co-author or attribution lines.
3. Run CI locally on a disposable Postgres in a clean tree: `bun run check` (use `--force`).
4. Merge with `gh pr merge N --merge`.
5. Check the Vercel commit status on the merge commit (`buzz_deploy_status`), then `bun scripts/smoke.mjs`, then GitHub CI on `main` (`gh run list --workflow CI --branch main --limit 1`). GitHub CI checks out a shallow clone, so tests that read git history can pass locally and fail there.

## Content Security Policy

`sites/web/csp.ts` builds the policy, `next.config.ts` serves it, `tests/csp.test.ts` pins it. Every page may load images and make requests only from its own origin (Vercel Analytics and Speed Insights use `/_vercel/*`). Two exceptions are scoped to the routes that need them: `/status` may also fetch `raw.githubusercontent.com` (the uptime JSON), and the public CMS pages plus the page-editor preview keep `img-src https:` because officers embed images by URL (`markdown.tsx`). A new third-party host goes into `csp.ts` for its own route, never into the default. Scripts keep `'unsafe-inline'` on purpose: a nonce works only on pages rendered per request, and building it (Next 16.4.6, `proxy.ts` plus `connection()` in the root layout) turned every marketing page from static to dynamic, losing the CDN-cached prerender. Do not retry that without a new idea, for example a nonce on `/portal` only, whose member pages are already dynamic.

Production migrates during the Vercel production build (`scripts/vercel-build.mjs`); previews skip migrations because they share the production DB.

## Versioning

One version for the whole repo, shown as `vX.Y.Z` in the footer, the MCP server version and every workspace `package.json`. The site's MAJOR.MINOR is `version` in `sites/web/package.json`; PATCH is first-parent commits since that line last changed and rolls into MINOR at 100. For a feature release worth naming, edit the `version` of every workspace package.json (root, `packages/*`, `sites/*`) to the same new `X.Y.0` (`tests/versions.test.ts` enforces it) and add a row to the README version table. Never change `sites/web/package.json`'s version line otherwise: that resets the footer patch. Use `buzz_version`, which lists each workspace and flags mismatches.

## How-to

Add a tRPC procedure
1. In `packages/api/src/routers/<name>.ts` add a key to the router: `adminProcedure` for officers, `protectedProcedure` for signed-in members, `superAdminProcedure` for role changes. Validate with `.input(z.object(...))`, then `.query` or `.mutation`.
2. New router file: export it with `createTRPCRouter` and add it to `appRouter` in `packages/api/src/root.ts`.
3. Test it in `tests/<name>-router.test.ts` (fake db) and, for SQL behavior, an `*.integration.test.ts`.

Add a table + migration
1. Define it in `packages/db/src/schema.ts` with `createTable("name", ...)` and index/constraint names through `idx("...")` (prefix `buzz_`).
2. `bun run db:generate`, commit the new SQL and `drizzle/meta`, then `bun run db:migrate` on a disposable DB.
3. Never edit an applied migration; add a new one.

Add a portal admin page
1. Create `sites/web/src/app/portal/(member)/admin/<name>/page.tsx`; prefetch with `api.<router>.<proc>.prefetch()` and wrap in `HydrateClient` like `admin/pages/page.tsx`.
2. Add an entry to `adminNav` in `sites/web/src/data/portal.ts`.
3. The real gate is the `adminProcedure` it calls, not the layout redirect.

Add a public CMS page
No code: an officer opens `/portal/admin/pages`, writes Markdown, sets a slug and publishes; it is served at `/{slug}` by `(marketing)/[slug]/page.tsx` (loader `sites/web/src/data/pages.ts`, cached, tag `pages`). Slugs that collide with a static route are rejected: when you add a top-level route folder, add its name to `RESERVED_PAGE_SLUGS` in `packages/api/src/page-slug.ts` (a test enforces this). For a coded page add `(marketing)/<name>/page.tsx`.
