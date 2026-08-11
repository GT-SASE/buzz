# Next steps

Updated after the portal security ship + T3 / Drizzle alignment (Aug 2026).
Phases **0–3** are implemented in the working tree. Phases **4–5** stay deferred.
Gates: `pnpm check` (lint + typecheck + vitest). CI runs the same with a Postgres
service and `drizzle-kit migrate`.

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

Projector pending/open/closed states, wake lock + Escape, manual code fallback
on `/join`, QR origin fallback, button-radius / destructive-token consistency,
toast placement, admin table overflow, a11y (table scroll region, scanner label,
nav focus), portal `not-found`, drop unused `next-themes`, icons/manifest,
sitemap/`robots` cleanup.

## Deferred — Phase 5 (code quality)

`format:check` in `pnpm check`, further dedupe of not-found throws, drop dead
exports, jsdom portal session tests, eslint pages-directory warning, pin
Postgres image in `start-database.sh`.

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
