# SASE at Georgia Tech

The chapter site, plus the member portal. Next.js 16, NextAuth, Drizzle, tRPC,
Tailwind v4, and [Watermelon UI](https://ui.watermelon.sh) for components.

## Layout

pnpm workspaces. Packages ship raw TypeScript and are compiled by whoever imports
them, which is why `sites/web/next.config.ts` lists them under `transpilePackages`.

```
packages/db     @buzz/db     drizzle schema, the client, drizzle-kit config
packages/auth   @buzz/auth   NextAuth config and the auth() helper
packages/api    @buzz/api    tRPC context, procedures, routers
sites/web       @buzz/web    the Next.js app
```

Inside `sites/web/src`:

```
app/(marketing)/   the public site — nav + footer chrome, prerendered
app/portal/        the member portal — its own chrome, dynamic
components/ui/     Watermelon UI primitives (shadcn registry)
components/site/   the editorial layer built on top of them
data/              chapter copy and constants
```

Run everything from the repo root: `pnpm dev`, `pnpm build`, `pnpm check`,
`pnpm db:migrate`. Each delegates to the workspace that owns it. Schema changes
go through Drizzle Kit (`pnpm db:generate` → commit SQL → `pnpm db:migrate`).

Deploying on Vercel: set **Root Directory** to `sites/web`. Vercel installs from
the repo root, so the workspace packages resolve normally.

## TypeScript

Everything type-checks under **TypeScript 7**. The workspace root additionally
pins `typescript` to 6.x, because `typescript-eslint` reads the compiler API
directly and its peer range stops at `<6.1.0`; `typescript-7` is the alias that
`tsc` actually runs. `postcss.config.js` is the one file still in JavaScript —
Next 16.3 only resolves `postcss.config.{js,mjs,json}`.

`pnpm ui:add @watermelon/<name>` pulls another component into `components/ui`.

## Two halves

The public site (`/`, `/about`, `/programs`, `/events`, `/join`, `/board`, `/sponsors`,
`/contact`) is fully prerendered and touches neither the database nor the session. It stays
that way on purpose — the root layout mounts no client providers, so those pages ship no
React Query and no tRPC client.

The member portal (`/portal/**`) is the dynamic half. It reads the session and the database
on every request, mounts the tRPC client in its own layout, and is excluded from search
indexing in two places (`robots.ts` and the portal layout's metadata).

## Setup

The public site needs no environment at all — it builds and deploys with an
empty environment, because none of its pages read the session or the database.
Everything below is what turns the **portal** on.

1. Copy `sites/web/.env.example` to `sites/web/.env` and fill it in. That path is
   deliberate: it is where Next.js reads `.env` from without any configuration, and
   `packages/db/drizzle.config.ts` is pointed at the same file so the credentials
   exist in exactly one place.
   - `DATABASE_URL` — the connection string for the database below.
   - `AUTH_SECRET` — `npx auth secret`.
   - `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` — from a Google Cloud OAuth client
     of type "Web application". Google is the only way into the portal, local
     development included, so sign-in does nothing until these are set.
   - `ADMIN_EMAILS` — who gets the officer role. Optional; see `.env.example`.
2. Start Postgres — `./start-database.sh` runs one in Docker. It reads the file
   from step 1, so that order matters.
3. `pnpm db:migrate` to apply the committed SQL under `packages/db/drizzle`.
   Use `pnpm db:push` only for throwaway local experiments — production and CI
   run migrations.
4. `pnpm dev`.

### Google OAuth redirect URIs

Every origin the portal runs on needs an entry, each with the
`/api/auth/callback/google` suffix. A missing entry is what produces
`redirect_uri_mismatch`.

```
Authorized JavaScript origins
  https://buzzsase.vercel.app
  http://localhost:3000

Authorized redirect URIs
  https://buzzsase.vercel.app/api/auth/callback/google
  http://localhost:3000/api/auth/callback/google
```

### Vercel

Project settings → Environment Variables, all four for Production and Preview:

```
DATABASE_URL         the same Postgres, or a separate one for previews
AUTH_SECRET          a different value from your local one
AUTH_GOOGLE_ID
AUTH_GOOGLE_SECRET
ADMIN_EMAILS         optional
```

`AUTH_URL` is not required. Auth.js reads the deployment URL from Vercel's own
`VERCEL_URL`, and `trustHost` is on so the forwarded host is accepted. Preview
deployments get a different hostname on every push, which Google will refuse
unless that exact origin is in the OAuth client. Sign in on the production
domain, or set `AUTH_URL=https://buzzsase.vercel.app` on Vercel if you want
every environment to callback against the canonical origin.

The build itself needs none of these. It runs with an empty environment on
purpose, so a missing variable shows up as a broken sign-in rather than a
failed deploy — check them before assuming the deploy is fine.

## Promoting the first officer

There is no in-app way to make someone an admin — that would be a privilege-escalation
surface with no benefit, since it happens roughly once a year. Set `ADMIN_EMAILS`, or:

1. Have the officer sign in once at `/portal`, which creates their user row.
2. `pnpm db:studio`, open `buzz_user`, find them by email, set `role` to `ADMIN`.

The role rides on the database session, so it takes effect on their next request. The same
step in reverse revokes it.

## How points work

An event carries a `pointsValue`. Checking in copies that number onto the attendance row as
`pointsEarned` and never reads it back. Re-pricing an event later therefore changes what
future attendance is worth and leaves everybody's existing total exactly where it was.

A member's total is one aggregate query over their own check-ins. Tiers are derived from
that total at render time — they live in `src/data/portal.ts` and changing them needs no
migration.

The dashboard leaderboard ranks members by that same total, with SQL `rank()`, so ties
share a place. It shows names and totals only — never an email, an id, or a photo — and
there is no opt-out column, so if the board wants members to be able to hide, that needs a
migration.

## The roster

`/portal/admin/members` is the officers' view of everyone who has ever signed in, searchable
by name or email, sortable by points, name or last check-in, and paged 25 at a time.
`/portal/admin/members/<id>` is one member: their totals, their tier, and every check-in with
the points it earned and whether it was scanned or added by hand. Both are `adminProcedure` —
a member holding another member's id gets `FORBIDDEN`, and there is a test that fails if that
gate is ever downgraded.

The roster exports to CSV. It exports every matching member, not the 25 on screen, which is
why it is a separate procedure rather than a loop over the paged one. Both exports — this one
and the per-event attendance — go through `src/app/portal/_lib/csv.ts`, which neutralises
leading `=`, `+`, `-`, `@`, tab and CR so a member's own display name cannot execute as a
formula when an officer opens the file. That guard is the reason the module exists; do not
inline a second CSV writer.

`/portal/admin` opens with the chapter's figures: members and how many have ever checked in,
check-ins in total and over the last 30 days, past and upcoming event counts, average
attendance per past event, and what is on next. Every figure is counted in SQL against one
clock reading, so no two can disagree about where "now" is.

## Check-in codes

Each event gets an eight-character code drawn from an alphabet with no `I`, `L`, `O`, `U`,
`0` or `1`. Members never type it: `/portal/check-in` opens the camera and reads the QR
code off the screen at the front of the room. The plain code is the officer's handle on the
event — it is what the present screen encodes and what rotation replaces.

The code is a bearer credential: anyone holding it can check in, so no member-facing query
selects it, and rotating it (officer tools, per event) revokes a photographed slide
immediately.

A member whose camera is blocked has two ways through that do not involve typing: point the
phone's own camera at the QR, which opens the page with the code already in the URL, or ask
an officer to add them by hand.

## Still needed after launch

- Board headshots under `sites/web/public/` once the chapter shoots them (the roster is named).
- Sponsor logos when partners sign — `/sponsors` stays an invitation until then.
- A chapter domain, if one is registered — swap `site.url` and the Google OAuth origins.
- Real events created in `/portal/admin` so the public calendar and check-in have something to run.
