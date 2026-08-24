# Next steps

Updated after the operability pass (16 Aug 2026). Phases **0–5** are in the
tree. Gates: `pnpm check` (lint + typecheck + format + vitest). CI runs the
same with a Postgres 16 service and `drizzle-kit migrate`.

**No code work is left on the launch path.** Everything under "Remaining" below
is an ops or board task that has to happen in a console, not in this repo.

---

## Immediate (ops, not code)

1. **Sign-in is wired correctly — verified 16 Aug 2026.** `/api/auth/providers`
   and `/api/auth/csrf` both answer on production, and the authorize URL the
   deployment builds returns Google's normal account chooser rather than an
   error, so the redirect URI is registered and Vercel's `AUTH_SECRET` /
   `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` are all set.

   Preview URLs (`buzz-git-….vercel.app`) are different origins and are not
   registered; sign in on the canonical domain, or set `AUTH_URL`.

---

## Done (operability pass, Aug 2026)

### Cleanup

- Dead code removed after confirming zero importers: `Panel` and `Notice` in
  `portal/_components/controls.tsx` (plus the `Alert`/`Card` imports they
  orphaned), the deprecated `toDate` alias in `packages/api/src/aggregates.ts`,
  and six unreferenced Watermelon primitives — `checkbox`, `collapsible`,
  `popover`, `switch`, `tabs`, `tooltip`. Re-add any with
  `pnpm ui:add @watermelon/<name>`.
- Stale `.bench-check-in.json` deleted from the working tree.
- Working tree normalised to LF. With `core.autocrlf=true` and no
  `.gitattributes`, `pnpm check` failed locally on ~35 files nobody had touched;
  it now passes end to end (exit 0).
- The jsdom test project runs on `pool: "threads"`. Forking it timed out
  starting its worker (`Timeout waiting for worker to respond`) on roughly every
  other full run, which would have been an intermittent CI failure. Only the
  node project needs fork semantics, for `process.env.TZ`. Full suite also
  dropped from ~103s to ~37s.

### Data integrity

- `0001_blue_bedlam.sql` adds four CHECK constraints: `pointsValue >= 0`,
  `maxCheckIns is null or > 0`, `currentCheckIns >= 0`, `pointsEarned >= 0`.
  Zod already enforced these on the way in, but Zod is not in the path of
  `db:studio`, a seed script, or a hand-written UPDATE — and all four feed
  money-like arithmetic. A negative `currentCheckIns` inflates the capacity gate
  by exactly that much. The upper bound on points stays in Zod on purpose: 100 is
  a policy the board may change, not an invariant.
- Verified against the current database before generating: zero existing rows
  violate any of the four.

### Test isolation

- **`pnpm test` used to write to the production database.** `vitest.config.ts`
  loaded `sites/web/.env` and handed `DATABASE_URL` to the integration and load
  suites, which create users, events and check-ins by the dozen. Against a
  scratch database that is fine; against the one serving members it is not.
- Tests now read **`TEST_DATABASE_URL` only**, and `DATABASE_URL` is deleted from
  the environment afterwards so nothing can fall back to it — not a test file,
  not `packages/db/src/client.ts`, not a stray import. Unset means the two
  database-backed suites skip, which is the safe direction: a skipped test is
  visible in the output, a test that quietly wrote to production is not.
- CI sets it to its own `postgres:16` service container. `.env.example` and the
  README document it.

### Hardening

- CSP drops `'unsafe-eval'` in production. It is a Turbopack dev-server
  requirement; a production bundle never calls eval, so shipping the allowance
  only widened the blast radius of anything that got past `'unsafe-inline'`.
- The tRPC origin check no longer accepts `Sec-Fetch-Site: same-site`. There are
  no sibling subdomains today, so it bought nothing — and the day the chapter
  registers a domain with something else on a subdomain, that sibling would have
  silently gained the right to issue mutations.
- `.github/CODEOWNERS` — review requested on everything, with the files that
  decide officer status, points, and CSV export called out by name.

### Observability

- **Every production 500 used to vanish.** `onError` on the tRPC route was
  `undefined` outside development, so a failing check-in left no server-side
  trace at all. It now emits one JSON line per failure to stdout, which Vercel's
  runtime logs capture with no account and no DSN. Deliberate rejections
  (`FORBIDDEN`, `NOT_FOUND`, `TOO_MANY_REQUESTS`, …) go out at `warn` with no
  stack; only an unhandled throw is logged as an incident, with one.
- `GET /api/health` — uptime probe, `200` / `503` on whether the database
  answered. Says nothing else: it is unauthenticated, so it must not describe a
  failure. `robots.ts` already disallows `/api/`.

### Rate limiting

- The bucket map grew one entry per user forever on a warm lambda. It now sweeps
  buckets that have refilled to their limit — dropping a full bucket is
  indistinguishable from keeping it, so nobody is ever handed their limit back
  early. There is a test for exactly that.
- `event.exportAttendance` was unlimited while `member.exportRoster` was capped,
  despite both handing back up to 5000 member emails. Same 5/min ceiling now.
- `assertRateLimit` is shared rather than reimplemented in `member.ts`.
- Still per-instance, still soft under multi-instance deploys. Documented in
  `packages/api/src/rate-limit.ts` and in `SECURITY.md` as known and accepted.

### Coverage

- `tests/admin-actions.test.ts` — the four procedures that had no test at all:
  `event.exportAttendance`, `event.setCheckInEnabled`, `event.removeCheckIn`,
  `member.revokeSessions`. Two are destructive and one exports emails, so "the
  auth gate is somewhere upstream" was not enough. Covers lock ordering on
  removal, the counter floor, the truncation flag, and `FORBIDDEN` for a member
  session on each, plus the token bucket's refill and eviction arithmetic.
- `member.revokeSessions` returns `revoked: n`. A bare `{ success: true }` could
  not tell an officer whether the account they were worried about was signed in
  anywhere at all.

### Repo / CI

- CI: `concurrency` group so stale runs cancel (main exempt — its history is what
  the deploy tracks), `timeout-minutes: 20`, `permissions: contents: read`, and
  the Node version read from `.nvmrc` instead of being duplicated in the workflow.
- `.nvmrc` + `engines.node` so local, CI and Vercel agree on Node 22.
- `.gitattributes` pinning the checkout to LF. Without it a contributor on
  Windows gets CRLF and `pnpm check` fails locally on files they never opened.
- `.github/dependabot.yml` — weekly grouped npm PRs, monthly actions. `next-auth`
  and both TypeScript entries are ignored on purpose: the beta pin and the 6.x/7.x
  split are decisions, not chores.
- `.github/pull_request_template.md`, `SECURITY.md`.

### UI

- `app/portal/error.tsx` and `loading.tsx`. `/portal/signin` sits outside the
  `(member)` group, so a render failure there was escalating all the way to
  `global-error.tsx` — losing the portal chrome and the way back to the site.
- `generateMetadata` on `/portal/admin/events/[id]` and `/portal/admin/members/[id]`,
  which were titled "Event" and "Member" for every row. Cached on the id, so
  titling the tab costs no second query.

---

## Done (Phases 0–5)

### Portal product

- Auth.js + Drizzle adapter, Google-only sign-in (any Google account may join)
- Events, QR check-in (`#code=` preferred; legacy `?code=` kept for OAuth),
  points, tiers
- Officer overview, event tools, present screen (wake lock + Escape)
- Manual code entry on `/portal/check-in` when the camera will not open
- Member roster + CSV export + member detail + session revoke
- Dashboard leaderboard (competition ranks in app code, not window SQL)
- Cache invalidation after check-in / attendance edits
- Roster export truncation signal + UTF-8 BOM on CSV downloads
- Leaderboard error state (no silent fail)
- Portal 404 for unknown event/member ids (keeps portal chrome)
- Expired check-in session redirects to sign-in

### Security / reliability

- Admin allowlist fail-closed; exact emails only (no `@domain` wildcard);
  no hardcoded default admins; `ADMIN_EMAILS` via `@t3-oss/env-nextjs`
- Portal secrets required when `VERCEL_ENV === "production"`
- Security headers + CSP + `poweredByHeader: false`
- Auth.js `trustHost` so Vercel host headers are accepted
- In-process rate limits on check-in / regenerate / roster export
- Check-in window: open 2h before start, close 24h after start
- Origin check on tRPC mutations; session `maxAge` 30d, `sameSite: "lax"`
- Seed guard (localhost or `SEED_FORCE=1`); `actedByUserId` audit on check-ins
- Committed Drizzle migrations (`packages/db/drizzle/`); prefer
  `pnpm db:migrate` for real deploys, `db:push` for throwaway local DBs
- Serverless postgres client tuning; marketing/global errors; loading skeletons;
  `sites/web/vercel.json`; `.github/workflows/ci.yml`

### API / DB correctness

- Capacity recount under txn + `FOR UPDATE`; lock order aligned on remove
- Archived events excluded from member-facing aggregates / leaderboard
- Paginated `listAll` / `getById` roster; server-side `exportAttendance`
- `lower(email)` unique index; cascade on accounts/sessions; check-in indexes
- Shared `notFound(subject)` helper for missing rows

### Drizzle query style

Business queries in `packages/api` use the Drizzle query builder
(`count` / `sum` / `min` / `max`, `eq` / `and` / `isNull` / `gte` / `lt`,
`desc` / `asc`, subqueries via `.as()`, `for("update")`). No hand-written
`sql\`...\`` templates for roster, chapter overview, check-in, or leaderboard
logic. Remaining `sql` fragments live only in `packages/db/src/schema.ts` for
DDL helpers (`lower(email)` index, CHECK constraints).

### Marketing content (from sites.gatech.edu/gtsase)

- Contact email + socials, named board, founding 2007, soft meeting copy

### UI / a11y / quality

- Projector pending/open/closed states; wake lock; Escape to leave
- Table scroll regions are labelled and keyboard-focusable
- Scanner video has an accessible name
- Portal skip-to-content link
- App icons + web manifest (`start_url: /portal`)
- Destructive actions use the `--destructive` token
- `format:check` is part of `pnpm check`
- Postgres image pinned to 16 (script + CI)
- `next typegen` runs before eslint so CI does not fail on image imports
- jsdom tests for check-in code entry and session-expiry redirect
- Vercel Analytics + Speed Insights

### Intentionally deferred

- Continuous QR code rotation (Phase 1 item 8)
- Materialized / precomputed leaderboard view (Phase 3 item 5)

---

## Remaining (ops / board, not code)

1. **Confirm production env** on Vercel: `DATABASE_URL`, `AUTH_SECRET`,
   Google OAuth IDs + redirect URIs, `ADMIN_EMAILS` (first officer). Optional:
   `AUTH_URL=https://buzzsase.vercel.app` if preview sign-in should hit the
   canonical origin.
2. ~~**Promote the first officer.**~~ **Done, 16 Aug 2026.**
   `aamoghsawantt@gmail.com` was written straight into `buzz_user` with
   `role = ADMIN`. Because that row has no linked Google account yet, the Google
   provider now sets `allowDangerousEmailAccountLinking: true` — without it
   Auth.js refuses to attach a login to an existing row and throws
   `OAuthAccountNotLinked`, which would have locked the address out rather than
   admitting it. Safe with Google as the only provider, since Google verifies the
   address; revisit if a second provider is ever added.

   The link happens on that account's first sign-in. Until then the row exists
   but has no session.
3. ~~**Clear the seed rows.**~~ **Done, 16 Aug 2026.** `officer@dev.local`,
   `member@dev.local`, the three seeded events (`TASTE234`, `SASEGT26`,
   `WKSHP789`) and their two check-ins were removed in one transaction, after a
   pre-flight that refused to run if any of them had a linked OAuth account.
   `gt@saseconnect.org` was kept — it is a real Google sign-in with a linked
   account and an active session. Production now holds one user, zero events,
   zero check-ins.
4. ~~**Migrate production schema.**~~ **Done, 16 Aug 2026.** The production Neon
   database had been built with `db:push`, so its migration ledger was empty
   while all six tables existed — `db:migrate` would have tried to replay
   `0000 CREATE TABLE` and failed. It was baselined (the `0000_past_sleeper` row
   inserted by hand, `created_at 1786411266874`) and `pnpm db:migrate` then
   applied `0001` alone. Verified afterwards: ledger holds both rows in order,
   all four CHECK constraints are present in `pg_constraint`, row counts
   unchanged. Every future deploy is on the migration path.
5. **Create real events** and dry-run one GBM
   (QR → scan → manual code → manual add → export).
6. **Board headshots** / **sponsor logos** when available.
7. **Custom domain** if registered — update `site.url` + OAuth origins.
8. **Optional:** retune tier thresholds in `portal.ts` before printing cards.

---

## Post-launch experiments

- Bun runtime on Vercel Functions: optional `bunVersion` in `vercel.json`;
  keep pnpm for installs. Not on the launch path.

---

## Intentionally out of scope

- In-app promote/demote to officer
- Dues system (membership is free)
- Leaderboard opt-out (add only if the board asks)
- School-domain lock on Google sign-in (product decision: any Google account)
