import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { db, elections, eventCheckIns, events, users } =
  await import("../packages/db/src/index");
const { createCaller } = await import("../packages/api/src/root");
const { resetRateLimits } = await import("../packages/api/src/rate-limit");
const { inArray } =
  await import("../packages/db/node_modules/drizzle-orm/index.js");

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

describe.skipIf(!process.env.DATABASE_URL)("elections", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const electionIds: string[] = [];
  let eventId = "";
  let officer: TestUser;
  let runner: TestUser;
  let voter: TestUser;
  let newcomer: TestUser;

  async function makeUser(label: string, role: TestUser["role"]) {
    const id = `vote-${label}-${suffix}`;
    const email = `${id}@vitest.local`;
    await db.insert(users).values({ id, email, role, name: label });
    userIds.push(id);
    return { id, email, role };
  }

  beforeAll(async () => {
    resetRateLimits();
    officer = await makeUser("officer", "ADMIN");
    runner = await makeUser("runner", "MEMBER");
    voter = await makeUser("voter", "MEMBER");
    newcomer = await makeUser("newcomer", "MEMBER");

    const [event] = await db
      .insert(events)
      .values({
        title: `Vote GBM ${suffix}`,
        startsAt: new Date(),
        checkInCode: suffix.toUpperCase().slice(0, 8),
        createdById: officer.id,
      })
      .returning();
    eventId = event!.id;
    await db.insert(eventCheckIns).values(
      [voter, officer].map((user) => ({
        eventId,
        userId: user.id,
        pointsEarned: 10,
      })),
    );
  });

  afterAll(async () => {
    if (electionIds.length > 0) {
      await db.delete(elections).where(inArray(elections.id, electionIds));
    }
    await db
      .delete(eventCheckIns)
      .where(inArray(eventCheckIns.userId, userIds));
    if (eventId) await db.delete(events).where(inArray(events.id, [eventId]));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it("runs nominations, approval, voting, and published results", async () => {
    const election = await callerFor(officer).election.create({
      title: `Board ${suffix}`,
      positions: ["President", "Treasurer"],
    });
    electionIds.push(election.id);

    const listed = await callerFor(officer).election.list();
    const mine = listed.find((row) => row.id === election.id)!;
    const [president, treasurer] = mine.positions;

    const nominated = await callerFor(runner).election.nominate({
      positionId: president!.id,
      statement: "I will run great GBMs.",
    });
    expect(nominated?.status).toBe("pending");
    expect(
      await errorCode(
        callerFor(runner).election.nominate({
          positionId: president!.id,
          statement: "again",
        }),
      ),
    ).toBe("CONFLICT");
    const other = await callerFor(voter).election.nominate({
      positionId: treasurer!.id,
      statement: "Spreadsheets.",
    });

    expect(
      await errorCode(
        callerFor(voter).election.vote({
          positionId: president!.id,
          candidateId: nominated!.id,
        }),
      ),
    ).toBe("BAD_REQUEST");

    expect(
      await errorCode(
        callerFor(officer).election.setPhase({
          electionId: election.id,
          phase: "voting",
        }),
      ),
    ).toBe("BAD_REQUEST");

    await callerFor(officer).election.setCandidateStatus({
      candidateId: nominated!.id,
      status: "approved",
    });
    await callerFor(officer).election.setPhase({
      electionId: election.id,
      phase: "voting",
    });

    expect(
      await errorCode(
        callerFor(runner).election.nominate({
          positionId: treasurer!.id,
          statement: "late",
        }),
      ),
    ).toBe("BAD_REQUEST");

    expect(
      await errorCode(
        callerFor(newcomer).election.vote({
          positionId: president!.id,
          candidateId: nominated!.id,
        }),
      ),
    ).toBe("FORBIDDEN");

    expect(
      await errorCode(
        callerFor(voter).election.vote({
          positionId: treasurer!.id,
          candidateId: other!.id,
        }),
      ),
    ).toBe("BAD_REQUEST");
    expect(
      await errorCode(
        callerFor(voter).election.vote({
          positionId: treasurer!.id,
          candidateId: nominated!.id,
        }),
      ),
    ).toBe("BAD_REQUEST");

    await callerFor(voter).election.vote({
      positionId: president!.id,
      candidateId: nominated!.id,
    });
    expect(
      await errorCode(
        callerFor(voter).election.vote({
          positionId: president!.id,
          candidateId: nominated!.id,
        }),
      ),
    ).toBe("CONFLICT");

    const during = await callerFor(officer).election.list();
    const duringPresident = during
      .find((row) => row.id === election.id)!
      .positions.find((position) => position.id === president!.id)!;
    expect(duringPresident.voters).toBe(1);
    expect(duringPresident.candidates[0]!.votes).toBeNull();

    expect(
      await errorCode(
        callerFor(officer).election.setPhase({
          electionId: election.id,
          phase: "nominating",
        }),
      ),
    ).toBe("BAD_REQUEST");

    const memberView = await callerFor(voter).election.current();
    const view = memberView.elections.find((row) => row.id === election.id)!;
    expect(memberView.eligible).toBe(true);
    expect(view.positions[0]!.myVote).toBe(nominated!.id);
    expect(view.positions[0]!.candidates[0]!.votes).toBeNull();
    expect(JSON.stringify(memberView)).not.toContain("voterId");

    await callerFor(officer).election.setPhase({
      electionId: election.id,
      phase: "closed",
    });
    const closed = await callerFor(voter).election.current();
    expect(
      closed.elections.find((row) => row.id === election.id)!.positions[0]!
        .candidates[0]!.votes,
    ).toBeNull();

    await callerFor(officer).election.setPhase({
      electionId: election.id,
      phase: "published",
    });
    const published = await callerFor(newcomer).election.current();
    expect(newcomer.id).not.toBe(voter.id);
    expect(published.eligible).toBe(false);
    expect(
      published.elections.find((row) => row.id === election.id)!.positions[0]!
        .candidates[0]!.votes,
    ).toBe(1);
  });

  it("only deletes an election that is still taking nominations", async () => {
    const election = await callerFor(officer).election.create({
      title: `Special ${suffix}`,
      positions: ["Secretary"],
    });
    await callerFor(officer).election.delete({ electionId: election.id });
    expect(
      (await callerFor(officer).election.list()).some(
        (row) => row.id === election.id,
      ),
    ).toBe(false);
  });
});
