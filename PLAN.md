# Next steps

Updated after the launch-readiness pass (Aug 2026). Phases **0–5** are in the
tree. Gates: `pnpm check` (lint + typecheck + format + vitest). CI runs the
same with a Postgres 16 service and `drizzle-kit migrate`.

---

## Immediate (ops, not code)

1. **Google sign-in `redirect_uri_mismatch`** — in Google Cloud Console →
   Credentials → the OAuth web client, list the exact origin under Authorized
   JavaScript origins, and that origin + `/api/auth/callback/google` under
   Authorized redirect URIs. Vercel *preview* URLs (`buzz-git-…vercel.app`) are
   different origins from `buzzsase.vercel.app`. Sign in from the canonical URL,
   or set `AUTH_URL=https://buzzsase.vercel.app` in Vercel env so Auth.js always
   builds callbacks against it. Google can take a few minutes to propagate.

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
