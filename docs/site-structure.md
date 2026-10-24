# Site structure

How the public site, member portal, API routes, workspace packages, and database fit
together. The README has the one-diagram overview; each section below zooms into one part.

- [Public site](#public-site)
- [Member portal](#member-portal)
- [Portal admin](#portal-admin)
- [Sign-in](#sign-in)
- [API](#api)
- [Database](#database)

## Public site

`app/(marketing)` is prerendered and never reads the session. Only `/` and `/events` touch
the database, through the cached calendar query.

```mermaid
flowchart LR
  visitor([Visitor])

  subgraph routes["app/(marketing)"]
    home["/"]
    events["/events"]
    other["/about, /programs, /join, /board,<br/>/sponsors, /contact, /discord, /website-team"]
  end

  subgraph meta["SEO / meta"]
    seo["robots.ts, sitemap.ts,<br/>manifest.ts, opengraph-image.tsx"]
  end

  visitor --> routes
  routes -- "/ and /events only" --> cache["data/chapter-events.ts<br/>unstable_cache"]
  cache --> db[("@buzz/db")]
  routes --> site["components/site<br/>nav, footer, hive, blocks"]
  site --> ui["components/ui<br/>Watermelon UI"]
  routes --> data["data/*<br/>copy, committees, photos"]
  routes -. portal CTA .-> start["/portal/start"]
```

## Member portal

`app/portal/(member)` needs a session. Pages call tRPC through the client mounted in
`app/portal/layout.tsx`; the resume upload goes through its own route handler.

```mermaid
flowchart LR
  member([Member])

  subgraph pages["app/portal/(member)"]
    home["/portal<br/>stats, leaderboard"]
    checkin["/portal/check-in<br/>QR scanner + code form"]
    events["/portal/events<br/>upcoming + RSVP"]
    committees["/portal/committees<br/>apply"]
    elections["/portal/elections<br/>nominate + vote"]
    mentorship["/portal/mentorship<br/>signup + kin groups"]
    resume["/portal/resume<br/>PDF upload"]
  end

  member --> pages
  pages --> trpc["/api/trpc"]
  pages -- resume upload --> resumeApi["/api/portal/resume"]
```

## Portal admin

`app/portal/(member)/admin` is gated to the admin role. Role changes need super admin.

```mermaid
flowchart LR
  admin([Admin])

  subgraph pages["app/portal/(member)/admin"]
    overview["/admin<br/>overview, events, attendance,<br/>turnout charts"]
    members["/admin/members<br/>roster + metrics"]
    memberId["/admin/members/[id]"]
    eventId["/admin/events/[id]<br/>attendance"]
    present["/admin/events/[id]/present<br/>check-in QR screen"]
    committees["/admin/committees<br/>cycles + inbox"]
    committeeId["/admin/committees/[id]<br/>application"]
    elections["/admin/elections"]
    mentorship["/admin/mentorship<br/>roster + kin groups"]
  end

  admin --> pages
  pages --> trpc["/api/trpc"]
  pages -- member resume download --> resumeApi["/api/portal/admin/members/[id]/resume"]
  pages -. event edits revalidate .-> cache["public calendar cache"]
```

## Sign-in

Google is the only provider. `/portal/start` is where the public site's CTAs land.

```mermaid
flowchart LR
  user([Visitor]) --> signin["/portal/signin"]
  user --> start["/portal/start"]
  signin --> route["/api/auth/[...nextauth]"]
  start --> route
  route --> nextauth["@buzz/auth<br/>NextAuth config, auth()"]
  nextauth <--> google[[Google OAuth]]
  nextauth --> tables[("user, account, session,<br/>verification_token")]
```

## API

`/api/trpc` serves `appRouter` from `@buzz/api`. Every procedure runs at one of four
access tiers; the shared helpers live beside the routers.

```mermaid
flowchart TB
  route["/api/trpc/[trpc]"] --> app["appRouter"]
  app --> tiers["procedure tiers<br/>public, protected, admin, superAdmin"]
  tiers --> auth["@buzz/auth"]

  app --> routers

  subgraph routers["routers"]
    chapter["chapter<br/>overview, attendance, turnout"]
    committee["committee<br/>submit, withdraw, cycles,<br/>setStatus, export"]
    election["election<br/>current, nominate, vote, setPhase"]
    event["event<br/>CRUD, checkIn, rsvp, myStats,<br/>attendance export"]
    member["member<br/>list, metrics, roster export,<br/>setRole, leaderboard"]
    mentorship["mentorship<br/>interest, kin groups, award points"]
    resume["resume<br/>mine, remove"]
  end

  routers --> helpers["helpers<br/>periods, terms, rate-limit,<br/>calendar-invite, leaderboard-rank"]
  routers --> db[("@buzz/db")]
```

Other route handlers:

```mermaid
flowchart LR
  health["/api/health"] --> db[("@buzz/db<br/>select 1")]
  upload["/api/portal/resume"] --> resume[("resume table")]
  download["/api/portal/admin/members/[id]/resume"] --> resume
```

## Database

Postgres through Drizzle. Every table is prefixed `buzz_`; migrations live in
`packages/db/drizzle`.

```mermaid
flowchart LR
  client["@buzz/db<br/>client + pooled-url"] --> pg
  migrations["drizzle/ migrations"] --> pg

  subgraph pg["Postgres"]
    auth["auth<br/>user, account, session,<br/>verification_token"]
    events["events<br/>event, event_check_in, event_rsvp"]
    mentorship["mentorship<br/>kin_group, mentorship_enrollment,<br/>kin_membership"]
    committees["committees<br/>committee_cycle, committee_application"]
    elections["elections<br/>election, election_position,<br/>election_candidate, election_vote"]
    resume["resume<br/>PDF bytes, max 2 MB"]
  end
```
