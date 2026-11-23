import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { SQL } from "bun";

/**
 * Migration 0017 moves every row of `election_vote` into `election_voter`
 * (who voted) and `election_ballot` (what, no voter), then drops the old
 * table. Build a scratch database at migration 0016, seed votes in the old
 * shape, run 0017, and compare every tally before and after. The data move
 * is also re-run on its own: it must neither duplicate a ballot nor fail.
 */
const DRIZZLE = "packages/db/drizzle";
const SLOW = 120_000;

function statements(file: string) {
  return readFileSync(`${DRIZZLE}/${file}.sql`, "utf8")
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean);
}

function journalTags() {
  const journal = JSON.parse(
    readFileSync(`${DRIZZLE}/meta/_journal.json`, "utf8"),
  ) as { entries: { idx: number; tag: string; when: number }[] };
  return journal.entries;
}

describe.skipIf(!process.env.DATABASE_URL)("migration 0017", () => {
  const name = `mig0017_${crypto.randomUUID().slice(0, 8)}`;
  let admin: SQL;
  let scratch: SQL;

  beforeAll(async () => {
    admin = new SQL(process.env.DATABASE_URL!);
    await admin.unsafe(`create database ${name}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${name}`;
    scratch = new SQL(url.toString());
  }, SLOW);

  afterAll(async () => {
    await scratch?.close();
    await admin?.unsafe(`drop database if exists ${name} with (force)`);
    await admin?.close();
  }, SLOW);

  it("is newer than the one before it, so prod applies it", () => {
    const entries = journalTags();
    const last = entries.at(-1)!;
    expect(last.tag.startsWith("0017_")).toBe(true);
    expect(last.when).toBeGreaterThan(entries.at(-2)!.when);
  });

  it(
    "keeps every tally identical and loses no vote",
    async () => {
      const entries = journalTags();
      const last = entries.at(-1)!;
      for (const entry of entries.slice(0, -1)) {
        for (const statement of statements(entry.tag)) {
          await scratch.unsafe(statement);
        }
      }

      // Old shape: three elections in each phase that has votes, 40 members.
      await scratch.unsafe(`
        insert into buzz_user (id, email, name)
        select 'u' || i, 'u' || i || '@x.test', 'User ' || i from generate_series(1, 40) i;
        insert into buzz_election (id, year, title, phase, "createdAt") values
          ('e-voting', '2026-2027', 'Voting', 'voting', now()),
          ('e-closed', '2026-2027', 'Closed', 'closed', now()),
          ('e-pub', '2025-2026', 'Published', 'published', now()),
          ('e-nom', '2026-2027', 'Nominating', 'nominating', now());
        insert into buzz_election_position (id, "electionId", title, "sortOrder") values
          ('p-v1', 'e-voting', 'President', 0), ('p-v2', 'e-voting', 'Treasurer', 1),
          ('p-c1', 'e-closed', 'President', 0),
          ('p-p1', 'e-pub', 'President', 0), ('p-p2', 'e-pub', 'Secretary', 1),
          ('p-n1', 'e-nom', 'President', 0);
        insert into buzz_election_candidate (id, "positionId", "userId", statement, status, "createdAt") values
          ('c-v1a', 'p-v1', 'u1', 's', 'approved', now()), ('c-v1b', 'p-v1', 'u2', 's', 'approved', now()),
          ('c-v2a', 'p-v2', 'u3', 's', 'approved', now()),
          ('c-c1a', 'p-c1', 'u4', 's', 'approved', now()), ('c-c1b', 'p-c1', 'u5', 's', 'approved', now()),
          ('c-p1a', 'p-p1', 'u6', 's', 'approved', now()), ('c-p1b', 'p-p1', 'u7', 's', 'approved', now()),
          ('c-p2a', 'p-p2', 'u8', 's', 'approved', now()),
          ('c-n1a', 'p-n1', 'u9', 's', 'pending', now());
        insert into buzz_election_vote ("positionId", "voterId", "candidateId", "castAt")
          select 'p-v1', 'u' || i, case when i % 3 = 0 then 'c-v1a' else 'c-v1b' end, now() from generate_series(10, 30) i;
        insert into buzz_election_vote ("positionId", "voterId", "candidateId", "castAt")
          select 'p-v2', 'u' || i, 'c-v2a', now() from generate_series(10, 14) i;
        insert into buzz_election_vote ("positionId", "voterId", "candidateId", "castAt")
          select 'p-c1', 'u' || i, case when i % 2 = 0 then 'c-c1a' else 'c-c1b' end, now() from generate_series(10, 35) i;
        insert into buzz_election_vote ("positionId", "voterId", "candidateId", "castAt")
          select 'p-p1', 'u' || i, case when i % 5 = 0 then 'c-p1a' else 'c-p1b' end, now() from generate_series(1, 40) i;
        insert into buzz_election_vote ("positionId", "voterId", "candidateId", "castAt")
          select 'p-p2', 'u' || i, 'c-p2a', now() from generate_series(1, 7) i;
      `);

      type Row = Record<string, unknown>;
      const select = async (text: string) =>
        (await scratch.unsafe(text)) as Row[];
      const count = async (table: string) =>
        (await select(`select count(*)::int as n from ${table}`))[0]!.n;

      const tallyBefore = await select(
        `select "positionId", "candidateId", count(*)::int as votes
         from buzz_election_vote group by 1, 2 order by 1, 2`,
      );
      const votersBefore = await select(
        `select p."electionId", v."positionId", v."voterId"
         from buzz_election_vote v join buzz_election_position p on p.id = v."positionId"
         order by 1, 2, 3`,
      );
      expect(tallyBefore.length).toBeGreaterThan(5);
      const total = await count("buzz_election_vote");

      const migration = statements(last.tag);
      for (const statement of migration) await scratch.unsafe(statement);

      const tallyAfter = await select(
        `select "positionId", "candidateId", count(*)::int as votes
         from buzz_election_ballot group by 1, 2 order by 1, 2`,
      );
      expect(tallyAfter).toEqual(tallyBefore);
      const votersAfter = await select(
        `select "electionId", "positionId", "voterId"
         from buzz_election_voter order by 1, 2, 3`,
      );
      expect(votersAfter).toEqual(votersBefore);
      expect(await count("buzz_election_ballot")).toBe(total);

      // The old table, and with it every voter-to-choice link, is gone.
      expect(
        (
          await select(`select to_regclass('public.buzz_election_vote') as t`)
        )[0]!.t,
      ).toBeNull();
      // Ballots carry no voter column.
      const columns = await select(
        `select column_name from information_schema.columns
         where table_name = 'buzz_election_ballot' order by 1`,
      );
      expect(columns.map((row) => row.column_name)).toEqual([
        "candidateId",
        "id",
        "positionId",
      ]);

      // Elections past nominating got a frozen voter list that holds everyone
      // who voted; the one still nominating got none.
      const frozen = await select(
        `select id, "rollFrozenAt" is not null as frozen,
                (select count(*)::int from buzz_election_roll r where r."electionId" = e.id) as roll
         from buzz_election e order by id`,
      );
      const byId = Object.fromEntries(
        frozen.map((row) => [row.id as string, row]),
      );
      expect(byId["e-nom"]).toMatchObject({ frozen: false, roll: 0 });
      expect(byId["e-closed"]).toMatchObject({ frozen: true, roll: 26 });
      expect(byId["e-pub"]).toMatchObject({ frozen: true, roll: 40 });
      expect(byId["e-voting"]!.frozen).toBe(true);
      expect(byId["e-voting"]!.roll as number).toBeGreaterThanOrEqual(21);

      // Running the data move again changes nothing.
      const move = migration.find((statement) => statement.includes("DO $$"))!;
      expect(move).toBeDefined();
      await scratch.unsafe(move);
      expect(await count("buzz_election_ballot")).toBe(total);
      expect(await count("buzz_election_voter")).toBe(votersBefore.length);
    },
    SLOW,
  );
});
