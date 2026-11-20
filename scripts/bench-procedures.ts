/**
 * Tail-latency bench for the hot tRPC procedures. Not part of the test suite.
 *
 *   DATABASE_URL=<disposable pg> bun scripts/bench-procedures.ts
 *
 * Seeds ~400 members, ~150 events, ~6000 check-ins, RSVPs, kin groups,
 * elections and a committee cycle (idempotent, tagged `bench-`), then calls
 * each procedure through `createCaller` with a hand-built context.
 *
 * Env:
 *   BENCH_RTT_MS   simulated network round trip added before every query (default 0)
 *   BENCH_N        samples per case (default 200)
 *   BENCH_CONC     concurrent callers for the concurrent pass (default 4)
 *   BENCH_ONLY     substring filter on case names
 *   BENCH_EXPLAIN  "1" prints EXPLAIN (ANALYZE, BUFFERS) for the slowest queries
 *   BENCH_JSON     path to write the results as JSON
 *
 * Never point this at production: it writes rows.
 */
import { writeFileSync } from "node:fs";
import { mock } from "bun:test";

mock.module("../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { sql } =
  await import("../packages/db/node_modules/drizzle-orm/index.js");
const { createCaller } = await import("../packages/api/src/root");
const { db } = await import("../packages/db/src/index");
const { schoolYear, semester } = await import("../packages/api/src/terms");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const url = process.env.DATABASE_URL ?? "";
let host = "";
try {
  host = new URL(url).hostname;
} catch {
  // falls through to the refusal below
}
if (!LOCAL_HOSTS.has(host)) {
  throw new Error(
    "Refusing to run: DATABASE_URL must point at localhost / 127.0.0.1 (a disposable database).",
  );
}

const RTT = Number(process.env.BENCH_RTT_MS ?? 0);
const N = Number(process.env.BENCH_N ?? 200);
const CONC = Number(process.env.BENCH_CONC ?? 4);
const ONLY = process.env.BENCH_ONLY ?? "";

// ------------------------------------------------------------------ counting
let queryCount = 0;
let simulate = false;
const pool = (db as unknown as { $client: any }).$client;
const wrapQuery = (target: any) => {
  const original = target.query.bind(target);
  target.query = async (...args: unknown[]) => {
    queryCount += 1;
    if (simulate && RTT > 0) await new Promise((r) => setTimeout(r, RTT));
    return original(...args);
  };
};
wrapQuery(pool);
const connect = pool.connect.bind(pool);
pool.connect = (...args: unknown[]) => {
  const result = (connect as any)(...args);
  if (typeof result?.then !== "function") return result;
  return result.then((client: any) => {
    if (!client.__wrapped) {
      client.__wrapped = true;
      wrapQuery(client);
    }
    return client;
  });
};

// ---------------------------------------------------------------------- seed
async function seed() {
  const [{ n }] = (
    await db.execute(
      sql`select count(*)::int as n from buzz_user where id like 'bench-%'`,
    )
  ).rows as { n: number }[];
  if (n > 0 && process.env.BENCH_RESEED !== "1") return;
  await db.execute(sql`delete from buzz_election where id like 'bench-%'`);
  await db.execute(sql`delete from buzz_kin_group where id like 'bench-%'`);
  await db.execute(
    sql`delete from buzz_committee_cycle where id = ${semester(new Date())}`,
  );
  await db.execute(sql`delete from buzz_event where id like 'bench-%'`);
  await db.execute(sql`delete from buzz_user where id like 'bench-%'`);
  const year = schoolYear(new Date());
  const term = semester(new Date());
  const [term0, yr0] = term.split("-");
  const kinYear = year;

  await db.execute(sql`
    insert into buzz_user (id, name, email, role)
    select 'bench-u' || i, 'Member ' || i, 'bench-u' || i || '@example.invalid',
           case when i = 0 then 'ADMIN' else 'MEMBER' end
    from generate_series(0, 399) i`);
  await db.execute(sql`
    insert into buzz_event (id, title, description, location, "startsAt", "pointsValue",
      "checkInCode", "checkInEnabled", "createdById", "createdAt")
    select 'bench-e' || i, 'Event ' || i, 'Description of event ' || i, 'Room ' || (i % 20),
           now() + ((i - 135) * interval '4 days'), 10 + (i % 3) * 5,
           'BNCH' || lpad(i::text, 4, '0'), true, 'bench-u0', now()
    from generate_series(0, 149) i`);
  // ~40 attendees per past event (135 past) plus the viewer at every 2nd one.
  await db.execute(sql`
    insert into buzz_event_check_in (id, "eventId", "userId", method, "pointsEarned", "checkedInAt")
    select 'bench-c' || e || '-' || k, 'bench-e' || e, 'bench-u' || ((e * 7 + k * 13) % 400),
           'code', 10, now() + ((e - 135) * interval '4 days') + (k * interval '1 minute')
    from generate_series(0, 134) e, generate_series(0, 44) k
    on conflict do nothing`);
  await db.execute(sql`
    insert into buzz_event_check_in (id, "eventId", "userId", method, "pointsEarned", "checkedInAt")
    select 'bench-v' || e, 'bench-e' || e, 'bench-u1', 'code', 10, now() + ((e - 135) * interval '4 days')
    from generate_series(0, 134, 2) e
    on conflict do nothing`);
  await db.execute(sql`
    insert into buzz_event_rsvp ("eventId", "userId", "createdAt")
    select 'bench-e' || e, 'bench-u' || ((e * 11 + k * 17) % 400), now()
    from generate_series(0, 149) e, generate_series(0, 20) k
    on conflict do nothing`);

  // Kin: 12 groups this semester, every member enrolled, ~300 seated.
  await db.execute(sql`
    insert into buzz_kin_group (id, year, semester, name, capacity, "isOpen", "createdAt")
    select 'bench-g' || i, ${kinYear}, ${term}, 'Kin ' || i, 40, true, now() from generate_series(0, 11) i`);
  await db.execute(sql`
    insert into buzz_mentorship_enrollment ("userId", year, role, status, points, "createdAt")
    select 'bench-u' || i, ${kinYear}, case when i % 4 = 0 then 'mentor' else 'mentee' end,
           'enrolled', i % 30, now() from generate_series(0, 399) i`);
  await db.execute(sql`
    insert into buzz_kin_membership ("userId", semester, "groupId", points, "joinedAt")
    select 'bench-u' || i, ${term}, 'bench-g' || (i % 12), i % 30, now() from generate_series(0, 299) i`);

  // Committee cycle + 120 applications.
  await db.execute(sql`
    insert into buzz_committee_cycle (id, "closesAt", "createdAt") values (${term}, now() + interval '20 days', now())
    on conflict do nothing`);
  await db.execute(sql`
    insert into buzz_committee_application (id, "userId", cycle, "wantsEvents", "discordHandle", "submittedAt", "createdAt")
    select 'bench-a' || i, 'bench-u' || i, ${term}, true, 'handle' || i, now(), now() from generate_series(0, 119) i`);

  // Elections: 2 this year, 5 positions each, 3 candidates each, 300 votes each.
  await db.execute(sql`
    insert into buzz_election (id, year, title, phase, "createdAt")
    values ('bench-el0', ${year}, 'Officer election', 'published', now()),
           ('bench-el1', ${year}, 'Special election', 'voting', now())`);
  await db.execute(sql`
    insert into buzz_election_position (id, "electionId", title, "sortOrder")
    select 'bench-p' || el || '-' || p, 'bench-el' || el, 'Position ' || p, p
    from generate_series(0, 1) el, generate_series(0, 4) p`);
  await db.execute(sql`
    insert into buzz_election_candidate (id, "positionId", "userId", statement, status, "createdAt")
    select 'bench-k' || el || '-' || p || '-' || c, 'bench-p' || el || '-' || p,
           'bench-u' || (10 + el * 50 + p * 5 + c), 'I would be great', 'approved', now()
    from generate_series(0, 1) el, generate_series(0, 4) p, generate_series(0, 2) c`);
  await db.execute(sql`
    insert into buzz_election_vote ("positionId", "voterId", "candidateId", "castAt")
    select 'bench-p' || el || '-' || p, 'bench-u' || v,
           'bench-k' || el || '-' || p || '-' || (v % 3), now()
    from generate_series(0, 1) el, generate_series(0, 4) p, generate_series(100, 399) v`);
  await db
    .execute(
      sql`
    insert into buzz_page (id, slug, title, body, published)
    select 'bench-pg' || i, 'bench-page-' || i, 'Page ' || i, 'body', true from generate_series(0, 9) i
    on conflict do nothing`,
    )
    .catch(() => undefined);
  await db.execute(sql`analyze`);
  void term0;
  void yr0;
}

// -------------------------------------------------------------------- cases
const expires = new Date(Date.now() + 86_400_000).toISOString();
const ctxFor = (id: string, role: "MEMBER" | "ADMIN") => ({
  db,
  headers: new Headers(),
  session: {
    user: { id, role, name: id, email: `${id}@example.invalid` },
    expires,
  },
});
const member = createCaller(ctxFor("bench-u1", "MEMBER"));
const admin = createCaller(ctxFor("bench-u0", "ADMIN"));

type Case = { name: string; run: () => Promise<unknown> };
const swallow = <T>(p: Promise<T>) => p.catch(() => null);

const cases: Case[] = [
  { name: "event.home", run: () => member.event.home() },
  { name: "event.upcoming", run: () => member.event.upcoming() },
  {
    name: "member.leaderboard",
    run: () => member.member.leaderboard({ limit: 10 }),
  },
  { name: "mentorship.mine", run: () => member.mentorship.mine() },
  { name: "mentorship.myGroup", run: () => member.mentorship.myGroup() },
  { name: "mentorship.groups", run: () => member.mentorship.groups() },
  { name: "committee.mine", run: () => member.committee.mine() },
  { name: "election.current", run: () => member.election.current() },
  { name: "resume.mine", run: () => swallow(member.resume.mine()) },
  { name: "chapter.overview", run: () => admin.chapter.overview() },
  {
    name: "chapter.attendance",
    run: () => admin.chapter.attendance({ period: "semester" }),
  },
  {
    name: "chapter.turnout",
    run: () => admin.chapter.turnout({ period: "semester" }),
  },
  {
    name: "event.listAll",
    run: () => admin.event.listAll({ limit: 200, offset: 0 }),
  },
  {
    name: "event.getById",
    run: () => admin.event.getById({ id: "bench-e100" }),
  },
  {
    name: "member.list",
    run: () => admin.member.list({ limit: 25, offset: 0, sort: "points" }),
  },
  {
    name: "member.metrics",
    run: () => admin.member.metrics({ tiers: [0, 50, 100, 200] }),
  },
  { name: "member.byId", run: () => admin.member.byId({ id: "bench-u1" }) },
  { name: "committee.cycles", run: () => admin.committee.cycles() },
  { name: "committee.list", run: () => admin.committee.list({}) },
  { name: "mentorship.list", run: () => admin.mentorship.list({}) },
  { name: "election.list", run: () => admin.election.list({}) },
  // Page-level bundles: what one request fans out to (see page.tsx files).
  {
    name: "PAGE /portal",
    run: () =>
      Promise.all([
        member.event.home(),
        member.member.leaderboard({ limit: 10 }),
        member.mentorship.mine(),
        member.mentorship.myGroup(),
        member.committee.mine(),
      ]),
  },
  {
    name: "PAGE /portal/admin",
    run: () =>
      Promise.all([
        admin.chapter.overview(),
        admin.chapter.attendance({ period: "semester" }),
        admin.chapter.turnout({ period: "semester" }),
        admin.event.listAll({ limit: 200, offset: 0 }),
      ]),
  },
  {
    name: "PAGE /portal/admin/members",
    run: () =>
      Promise.all([
        admin.member.list({ limit: 25, offset: 0, sort: "points" }),
        admin.member.metrics({ tiers: [0, 50, 100, 200] }),
      ]),
  },
  {
    name: "PAGE /portal/mentorship",
    run: () =>
      Promise.all([
        member.mentorship.mine(),
        member.mentorship.groups(),
        member.mentorship.myGroup(),
      ]),
  },
];

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

async function measure(c: Case, conc: number) {
  const times: number[] = [];
  queryCount = 0;
  let calls = 0;
  const worker = async (count: number) => {
    for (let i = 0; i < count; i += 1) {
      const t = performance.now();
      await c.run();
      times.push(performance.now() - t);
      calls += 1;
    }
  };
  await Promise.all(
    Array.from({ length: conc }, () => worker(Math.ceil(N / conc))),
  );
  times.sort((a, b) => a - b);
  return {
    p50: pct(times, 50),
    p95: pct(times, 95),
    p99: pct(times, 99),
    qpc: queryCount / calls,
  };
}

await seed();
const results: Record<string, unknown> = {};
const fmt = (n: number) => n.toFixed(1).padStart(7);
console.log(`RTT=${RTT}ms N=${N} CONC=${CONC}`);
console.log(
  "case".padEnd(28) +
    "q/call".padStart(7) +
    "  seq p50    p95    p99 " +
    " conc p50    p95    p99",
);
for (const c of cases) {
  if (ONLY && !c.name.includes(ONLY)) continue;
  simulate = false;
  for (let i = 0; i < 10; i += 1) await c.run().catch(() => null); // warm
  simulate = true;
  const seq = await measure(c, 1);
  const conc = await measure(c, CONC);
  results[c.name] = { seq, conc };
  console.log(
    c.name.padEnd(28) +
      seq.qpc.toFixed(1).padStart(7) +
      "  " +
      [seq.p50, seq.p95, seq.p99].map(fmt).join("") +
      "  " +
      [conc.p50, conc.p95, conc.p99].map(fmt).join(""),
  );
}
if (process.env.BENCH_JSON)
  writeFileSync(process.env.BENCH_JSON, JSON.stringify(results, null, 2));
await pool.end();
