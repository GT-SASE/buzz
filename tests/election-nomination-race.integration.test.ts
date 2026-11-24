import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

/**
 * Nominations, withdrawals and approvals are only valid while an election is
 * nominating. Reading the phase and then writing, with nothing locked in
 * between, lets a write land after an officer has opened voting and fixed the
 * ballot. Each test holds the officer's phase flip open (election row locked
 * FOR UPDATE, new phase not yet committed) while the member write runs.
 */
mock.module("../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { db, electionCandidates, electionPositions, elections, users } =
  await import("../packages/db/src/index");
const { createCaller } = await import("../packages/api/src/root");
const { eq, inArray } = await import("drizzle-orm");

type TestUser = { id: string; email: string; role: "MEMBER" | "ADMIN" };

function callerFor(user: TestUser) {
  return createCaller({
    db,
    session: {
      user: { id: user.id, role: user.role, email: user.email, name: user.id },
      expires: new Date(Date.now() + 86_400_000).toISOString(),
    },
    headers: new Headers(),
  });
}

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
    return "NO_ERROR";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

describe.skipIf(!process.env.DATABASE_URL)(
  "election writes racing a phase flip",
  () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const userIds: string[] = [];
    const electionIds: string[] = [];
    let officer: TestUser;
    let runner: TestUser;

    async function makeUser(label: string, role: TestUser["role"]) {
      const id = `race-${label}-${suffix}`;
      const email = `${id}@vitest.local`;
      await db.insert(users).values({ id, email, role, name: label });
      userIds.push(id);
      return { id, email, role };
    }

    async function makeElection() {
      const election = await callerFor(officer).election.create({
        title: `Race ${suffix}`,
        positions: ["President"],
      });
      electionIds.push(election.id);
      const [position] = await db
        .select({ id: electionPositions.id })
        .from(electionPositions)
        .where(eq(electionPositions.electionId, election.id));
      return { electionId: election.id, positionId: position!.id };
    }

    /**
     * What an officer's `setPhase` does to the row, left uncommitted while
     * `during` runs. `during` starts after the lock is held; if it is going to
     * wait on that lock it has had time to start waiting before the flip
     * commits.
     */
    async function whileFlipping(
      electionId: string,
      during: () => Promise<unknown>,
    ) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));

      const flip = db.transaction(async (tx) => {
        await tx
          .select({ id: elections.id })
          .from(elections)
          .where(eq(elections.id, electionId))
          .for("update");
        await tx
          .update(elections)
          .set({ phase: "voting" })
          .where(eq(elections.id, electionId));
        locked();
        await held;
      });
      await lockTaken;

      const outcome = errorCode(during());
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      await flip;
      return outcome;
    }

    beforeAll(async () => {
      officer = await makeUser("officer", "ADMIN");
      runner = await makeUser("runner", "MEMBER");
    });

    afterAll(async () => {
      if (electionIds.length > 0) {
        await db.delete(elections).where(inArray(elections.id, electionIds));
      }
      await db.delete(users).where(inArray(users.id, userIds));
    });

    it("refuses a nomination that arrives as voting opens", async () => {
      const { electionId, positionId } = await makeElection();

      const outcome = await whileFlipping(electionId, () =>
        callerFor(runner).election.nominate({
          positionId,
          statement: "Too late.",
        }),
      );

      expect(outcome).toBe("BAD_REQUEST");
      expect(
        await db
          .select({ id: electionCandidates.id })
          .from(electionCandidates)
          .where(eq(electionCandidates.positionId, positionId)),
      ).toHaveLength(0);
    });

    it("refuses a withdrawal that arrives as voting opens", async () => {
      const { electionId, positionId } = await makeElection();
      const nominated = await callerFor(runner).election.nominate({
        positionId,
        statement: "Staying in.",
      });

      const outcome = await whileFlipping(electionId, () =>
        callerFor(runner).election.withdrawNomination({
          candidateId: nominated!.id,
        }),
      );

      expect(outcome).toBe("BAD_REQUEST");
      expect(
        await db
          .select({ id: electionCandidates.id })
          .from(electionCandidates)
          .where(eq(electionCandidates.id, nominated!.id)),
      ).toHaveLength(1);
    });

    it("refuses an approval that arrives as voting opens", async () => {
      const { electionId, positionId } = await makeElection();
      const nominated = await callerFor(runner).election.nominate({
        positionId,
        statement: "Approve me.",
      });

      const outcome = await whileFlipping(electionId, () =>
        callerFor(officer).election.setCandidateStatus({
          candidateId: nominated!.id,
          status: "approved",
        }),
      );

      expect(outcome).toBe("BAD_REQUEST");
      const [candidate] = await db
        .select({ status: electionCandidates.status })
        .from(electionCandidates)
        .where(eq(electionCandidates.id, nominated!.id));
      expect(candidate?.status).toBe("pending");
    });
  },
);
