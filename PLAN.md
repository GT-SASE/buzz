# Next steps

Updated after the portal security ship + T3 / Drizzle alignment (Aug 2026).
Phases **0–3** are implemented in the working tree. Phases **4–5** stay deferred.
Gates: `pnpm check` (lint + typecheck + vitest). CI runs the same with a Postgres
service and `drizzle-kit migrate`.

---

## Immediate (blocking launch)

1. **CI lint failure — fixed in tree, needs commit.** CI failed on 12
   "Unsafe assignment of an error typed value" errors in `photos.ts`,
   `media.tsx`, and the homepage: image imports (`*.jpg`) have no types until
   `next typegen` writes `next-env.d.ts`, which is gitignored, and CI ran
   `eslint` before typegen. Root `lint` / `lint:fix` now run
   `next typegen` first (`package.json`). Verified locally by deleting
   `next-env.d.ts` and re-running `pnpm lint`.
2. **Google sign-in broken in production** — `Error 400: redirect_uri_mismatch`
   on the deployed site. Ops, not code: in Google Cloud Console → Credentials →
   the OAuth web client, the *exact* origin being visited must be listed under
   Authorized JavaScript origins, and the same origin +
   `/api/auth/callback/google` under Authorized redirect URIs. Note Vercel
   *preview* URLs (`buzz-git-…vercel.app`) are different origins from
   `buzzsase.vercel.app` and will always mismatch — sign in from the canonical
   URL, or set `AUTH_URL=https://buzzsase.vercel.app` in the Vercel env so
   Auth.js always builds callbacks against the canonical origin. Google can
   take a few minutes to propagate credential edits.

---

## Done (Phases 0–3)

### Portal product

- Auth.js + Drizzle adapter, Google-only sign-in (any Google account may join)
- Events, QR check-in (`#code=` preferred; legacy `?code=` kept for OAuth),
  points, tiers
- Officer overview, event tools, present screen
- Member roster + CSV export + member detail + session revoke
- Dashboard leaderboard (competition ranks in app code, not window SQL)
- Cache invalidation after check-in / attendance edits
- Roster export truncation signal + UTF-8 BOM on CSV downloads
- Leaderboard error state (no silent fail)

### Security / reliability

- Admin allowlist fail-closed; exact emails only (no `@domain` wildcard);
  no hardcoded default admins; `ADMIN_EMAILS` via `@t3-oss/env-nextjs`
- Portal secrets required when `VERCEL_ENV === "production"`
- Security headers + CSP + `poweredByHeader: false`
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

### Drizzle query style

Business queries in `packages/api` use the Drizzle query builder
(`count` / `sum` / `min` / `max`, `eq` / `and` / `isNull` / `gte` / `lt`,
`desc` / `asc`, subqueries via `.as()`, `for("update")`). No hand-written
`sql\`...\`` templates for roster, chapter overview, check-in, or leaderboard
logic. Remaining `sql` fragments live only in `packages/db/src/schema.ts` for
DDL helpers (`lower(email)` index, CHECK constraints).

### Marketing content (from sites.gatech.edu/gtsase)

- Contact email + socials, named board, founding 2007, soft meeting copy

### Intentionally deferred this pass

- Continuous QR code rotation (Phase 1 item 8)
- Vercel Analytics / speed insights (Phase 2 item 6)
- Materialized / precomputed leaderboard view (Phase 3 item 5)

---

## Deferred — Phase 4 (UI/UX polish)

Re-audited Aug 2026 against the working tree. Status per item:

- [x] Projector pending/open/closed states — `present-screen.tsx` has all
  three (skeleton while loading, QR while open, "Check-in is closed." with
  archived/past/manual reasons). Done.
- [ ] **Wake lock + Escape on the projector view** — `present-screen.tsx` has
  neither: the screen can sleep mid-GBM, and leaving requires clicking the
  footer link. Add `navigator.wakeLock.request("screen")` (re-acquire on
  `visibilitychange`) and an Escape handler that routes back to the event page.
- [ ] **Manual code entry on `/portal/check-in`** — `check-in-form.tsx` has no
  text input; camera or URL are the only ways in. A member with a broken/denied
  camera is told to "ask an officer". Add a small "enter the code instead"
  input validated against the issued-code alphabet in `scanner.ts`.
- [x] Admin table overflow — `ui/table.tsx` wraps every table in
  `overflow-x-auto`, and the members/attendance tables set `min-w-*`. Done.
- [ ] **A11y sweep** — the table scroll containers are not keyboard-focusable
  scroll regions (add `tabIndex={0}` + `role="region"` + label on
  `ui/table.tsx` wrapper); the scanner `<video>` has no accessible label;
  spot-check portal tab focus styles.
- [ ] **Portal `not-found.tsx`** — none exists under `src/app/portal/`; a bad
  event/member id inside the portal falls through to the marketing 404, which
  drops the member out of the portal chrome.
- [ ] **Drop `next-themes`** — still in `sites/web/package.json` dependencies,
  zero imports anywhere (only a comment in `ui/sonner.tsx` mentions it).
  `pnpm remove` it.
- [ ] **Icons / manifest** — `public/` has only `favicon.ico` plus brand PNGs.
  Add `icon.png` / `apple-icon.png` and a `manifest.ts` in `src/app/` so
  home-screen installs of the portal get a real icon.
- [x] Sitemap / robots — both are clean: portal disallowed + `noindex`, public
  routes hand-listed with sane priorities. Done.
- [ ] Button-radius / destructive-token consistency and toast placement —
  visual pass across portal admin screens; low stakes, do last.
- [ ] QR origin fallback — `event-qr.tsx` already treats a failed encode as
  non-fatal (code beside it still shows); confirm the admin event page renders
  the URL from the request origin correctly behind the Vercel proxy, else
  build from `site.url`.

## Deferred — Phase 5 (code quality)

- [ ] **`format:check` in `pnpm check`** — script exists but is not part of the
  gate; add it so CI catches drift.
- [ ] **Dedupe not-found throws** — ten copies of
  `throw new TRPCError({ code: "NOT_FOUND", ... })` across
  `routers/event.ts` / `routers/member.ts`; extract a small helper.
- [ ] **Drop dead exports** — sweep `components/site/index.ts`, `_lib/`, and
  `data/` for exports with no importers.
- [ ] **jsdom portal session tests** — none of the 9 test files cover portal
  client components; add jsdom tests for `check-in-form` code parsing states
  and session-expiry redirect.
- [ ] **ESLint pages-directory warning** — "Pages directory cannot be found"
  still prints on every lint run even with `no-html-link-for-pages: "off"`;
  silence it properly (set the rule's option to the app dir or drop the
  legacy Next config layer that injects it).
- [ ] **Pin the Postgres image** — `start-database.sh` runs bare
  `docker.io/postgres` (latest); pin to `postgres:16` to match CI.

---

## Remaining (ops / board, not code)

1. **Confirm production env** on Vercel: `DATABASE_URL`, `AUTH_SECRET`,
   Google OAuth IDs + redirect URIs, `ADMIN_EMAILS` (first officer).
2. **Promote first officer** via `ADMIN_EMAILS` or `db:studio`.
3. **Migrate production schema** with `pnpm db:migrate` (fresh DBs). Local DBs
   that were created with `db:push` before migrations existed may need
   `db:push` or a one-off alter before `0000` applies cleanly.
4. **Create real events** and dry-run one GBM
   (QR → scan → manual code → manual add → export).
5. **Board headshots** / **sponsor logos** when available.
6. **Custom domain** if registered — update `site.url` + OAuth origins.
7. **Optional:** retune tier thresholds in `portal.ts` before printing cards.

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
