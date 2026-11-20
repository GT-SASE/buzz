import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

/**
 * Two elections in one school year, in different phases. Vote counts must show
 * only where the phase allows (officers: closed or published; members:
 * published), and one election's votes must never land on the other's
 * candidates.
 */
mock.module("../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const {
  db,
  electionCandidates,
  electionPositions,
  elections,
  electionVotes,
  users,
} = await import("../packages/db/src/index");
const { createCaller } = await import("../packages/api/src/root");
const { schoolYear } = await import("../packages/api/src/terms");
const { inArray } =
  await import("../packages/db/node_modules/drizzle-orm/index.js");

const SLOW = 30_000;

function callerFor(id: string, role: "MEMBER" | "ADMIN") {
  return createCaller({
    db,
    session: {
      user: { id, role, email: `${id}@example.invalid`, name: "vitest" },
      expires: new Date(Date.now() + 86_400_000).toISOString(),
    },
    headers: new Headers(),
  });
}

describe.skipIf(!process.env.DATABASE_URL)("election phases", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const electionIds: string[] = [];
  const year = schoolYear(new Date());
  let officer = "";
  let voterA = "";
  let voterB = "";
  let voterC = "";
  const cand: Record<string, string> = {};

  async function makeUser(tag: string, role: "MEMBER" | "ADMIN") {
    const [row] = await db
      .insert(users)
      .values({
        email: `vitest-ph-${tag}-${suffix}@example.invalid`,
        name: `vitest ${tag} ${suffix}`,
        role,
      })
      .returning({ id: users.id });
    userIds.push(row!.id);
    return row!.id;
  }

  beforeAll(async () => {
    officer = await makeUser("officer", "ADMIN");
    voterA = await makeUser("a", "MEMBER");
    voterB = await makeUser("b", "MEMBER");
    voterC = await makeUser("c", "MEMBER");

    const made = await db
      .insert(elections)
      .values([
        { year, title: `vitest voting ${suffix}`, phase: "voting" },
        { year, title: `vitest published ${suffix}`, phase: "published" },
      ])
      .returning({ id: elections.id, title: elections.title });
    for (const row of made) electionIds.push(row.id);
    const votingId = made.find((row) => row.title.includes("voting"))!.id;
    const publishedId = made.find((row) => row.title.includes("published"))!.id;

    const pos = await db
      .insert(electionPositions)
      .values([
        { electionId: votingId, title: "vitest V president" },
        { electionId: publishedId, title: "vitest P president" },
      ])
      .returning({ id: electionPositions.id, title: electionPositions.title });
    const votingPos = pos.find((row) => row.title.includes("V "))!.id;
    const publishedPos = pos.find((row) => row.title.includes("P "))!.id;

    const cands = await db
      .insert(electionCandidates)
      .values([
        {
          positionId: votingPos,
          userId: voterA,
          statement: "v-a",
          status: "approved",
        },
        {
          positionId: votingPos,
          userId: voterB,
          statement: "v-b",
          status: "approved",
        },
        {
          positionId: publishedPos,
          userId: voterA,
          statement: "p-a",
          status: "approved",
        },
        {
          positionId: publishedPos,
          userId: voterB,
          statement: "p-b",
          status: "approved",
        },
      ])
      .returning({
        id: electionCandidates.id,
        statement: electionCandidates.statement,
      });
    for (const row of cands) cand[row.statement] = row.id;

    await db.insert(electionVotes).values([
      { positionId: votingPos, voterId: voterA, candidateId: cand["v-a"]! },
      { positionId: votingPos, voterId: voterB, candidateId: cand["v-a"]! },
      { positionId: votingPos, voterId: voterC, candidateId: cand["v-b"]! },
      { positionId: publishedPos, voterId: voterA, candidateId: cand["p-b"]! },
      { positionId: publishedPos, voterId: voterB, candidateId: cand["p-b"]! },
    ]);
  }, SLOW);

  afterAll(async () => {
    if (electionIds.length > 0) {
      await db.delete(elections).where(inArray(elections.id, electionIds));
    }
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  }, SLOW);

  it(
    "officer list shows counts only for closed or published elections",
    async () => {
      const listed = await callerFor(officer, "ADMIN").election.list();
      const voting = listed.find((e) => e.title.includes(`voting ${suffix}`))!;
      const published = listed.find((e) =>
        e.title.includes(`published ${suffix}`),
      )!;

      // Turnout shows throughout; per-candidate counts do not while voting.
      expect(voting.positions[0]!.voters).toBe(3);
      expect(voting.positions[0]!.candidates.map((c) => c.votes)).toEqual([
        null,
        null,
      ]);
      expect(published.positions[0]!.voters).toBe(2);
      const byStatement = Object.fromEntries(
        published.positions[0]!.candidates.map((c) => [c.statement, c.votes]),
      );
      expect(byStatement).toEqual({ "p-a": 0, "p-b": 2 });
    },
    SLOW,
  );

  it(
    "member current shows counts only once published, with no cross-election leak",
    async () => {
      const view = await callerFor(voterC, "MEMBER").election.current();
      const voting = view.elections.find((e) =>
        e.title.includes(`voting ${suffix}`),
      )!;
      const published = view.elections.find((e) =>
        e.title.includes(`published ${suffix}`),
      )!;

      expect(voting.positions[0]!.candidates.map((c) => c.votes)).toEqual([
        null,
        null,
      ]);
      expect(
        published.positions[0]!.candidates.map((c) => c.votes).sort(),
      ).toEqual([0, 2]);
      // voterC voted only in the voting election.
      expect(voting.positions[0]!.myVote).toBe(cand["v-b"]!);
      expect(published.positions[0]!.myVote).toBeNull();
    },
    SLOW,
  );
});
