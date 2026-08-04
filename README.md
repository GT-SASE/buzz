# SASE at Georgia Tech

The chapter site, plus the member portal. Built on the [T3 Stack](https://create.t3.gg/):
Next.js, NextAuth, Drizzle, Tailwind, tRPC.

## Layout

npm workspaces. Packages ship raw TypeScript and are compiled by whoever imports
them, which is why `sites/web/next.config.js` lists them under `transpilePackages`.

```
packages/db     @buzz/db     drizzle schema, the client, drizzle-kit config
packages/auth   @buzz/auth   NextAuth config and the auth() helper
packages/api    @buzz/api    tRPC context, procedures, routers
sites/web       @buzz/web    the Next.js app
```

Run everything from the repo root: `npm run dev`, `npm run build`, `npm run check`,
`npm run db:push`. Each delegates to the workspace that owns it.

Deploying on Vercel: set **Root Directory** to `sites/web`. Vercel installs from
the repo root, so the workspace packages resolve normally.

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

1. Start Postgres — `./start-database.sh` runs one in Docker.
2. Copy `sites/web/.env.example` to `sites/web/.env` and fill in all four keys.
   That path is deliberate: it is where Next.js reads `.env` from without any
   configuration, and `packages/db/drizzle.config.ts` is pointed at the same
   file so the credentials exist in exactly one place.
   - `DATABASE_URL` — the connection string for the database above.
   - `AUTH_SECRET` — `npx auth secret`.
   - `AUTH_DISCORD_ID` / `AUTH_DISCORD_SECRET` — from a Discord OAuth app whose redirect
     URI is `<origin>/api/auth/callback/discord`.
3. `npm run db:push` to create the tables.
4. `npm run dev`.

## Promoting the first officer

There is no in-app way to make someone an admin — that would be a privilege-escalation
surface with no benefit, since it happens roughly once a year.

1. Have the officer sign in once at `/portal`, which creates their user row.
2. `npm run db:studio`, open `buzz_user`, find them by email, set `role` to `ADMIN`.

The role rides on the database session, so it takes effect on their next request. The same
step in reverse revokes it.

## How points work

An event carries a `pointsValue`. Checking in copies that number onto the attendance row as
`pointsEarned` and never reads it back. Re-pricing an event later therefore changes what
future attendance is worth and leaves everybody's existing total exactly where it was.

A member's total is one aggregate query over their own check-ins. Tiers are derived from
that total at render time — they live in `src/data/portal.ts` and changing them needs no
migration.

## Check-in codes

Each event gets an eight-character code drawn from an alphabet with no `I`, `L`, `O`, `U`,
`0` or `1`, because members read it off a projector and type it on a phone. The code is a
bearer credential: anyone holding it can check in, so no member-facing query selects it, and
rotating it (officer tools, per event) revokes a photographed slide immediately.

## Still needed before launch

- `site.url` in `src/data/site.ts` is a placeholder. Every canonical URL, the sitemap,
  `robots.txt`, and the share card derive from it.
- Board roster, real event dates, meeting cadence, dues, and socials — all marked `TODO` in
  `src/data/site.ts` and `src/data/content.ts`.
- Board headshots and sponsor logos.
