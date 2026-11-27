import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import { stubEnv, unstubAllEnvs } from "../helpers/env";

/**
 * Elections v2 on a real Postgres: the frozen voter list, the secret ballot,
 * votes racing the phase flip, the scheduled flips and their cron route, the
 * tally export, locked positions and the board built from results.
 */
mock.module("../../packages/auth/src/index.ts", () => ({
  auth: () => Promise.resolve(null),
  handlers: {},
  signIn: () => Promise.resolve(undefined),
  signOut: () => Promise.resolve(undefined),
}));

const sent: { to: string; subject: string; phase: unknown }[] = [];
let probe: (() => Promise<unknown>) | null = null;

mock.module("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: async (message: { to: string; subject: string }) => {
        sent.push({
          to: message.to,
          subject: message.subject,
          phase: probe ? await probe() : undefined,
        });
      },
    }),
  },
}));

const {
  auditLog,
  db,
  electionBallots,
  electionCandidates,
  electionPositions,
  electionRoll,
  elections,
  electionVoters,
  eventCheckIns,
  events,
  users,
} = await import("../../packages/db/src/index");
const { createCaller } = await import("../../packages/api/src/root");
const { boardFromResults } = await import("../../packages/api/src/board");
const { runScheduledFlips } =
  await import("../../packages/api/src/election-flow");
const { GET: cronGet } =
  await import("../../sites/web/src/app/api/cron/elections/route");
const { and, eq, inArray, sql } =
  await import("../../packages/db/node_modules/drizzle-orm/index.js");

const SLOW = 60_000;
const CRON_SECRET = "c".repeat(40);

type Role = "MEMBER" | "ADMIN";
type TestUser = { id: string; email: string; role: Role };

function callerFor(
  user: TestUser,
  defer?: (task: () => Promise<unknown>) => void,
) {
  return createCaller({
    db,
    defer,
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

describe.skipIf(!process.env.DATABASE_URL)("elections v2", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const electionIds: string[] = [];
  const eventIds: string[] = [];
  let seq = 0;
  let officer: TestUser;
  let member: TestUser;

  async function makeUser(label: string, role: Role = "MEMBER") {
    const id = `ev2-${label}-${suffix}`;
    const email = `${id}@vitest.local`;
    await db
      .insert(users)
      .values({ id, email, role, name: `Zed ${label} ${suffix}` });
    userIds.push(id);
    return { id, email, role } satisfies TestUser;
  }

  async function checkIn(user: TestUser, times = 1) {
    for (let i = 0; i < times; i++) {
      seq += 1;
      const [event] = await db
        .insert(events)
        .values({
          title: `ev2 ${seq} ${suffix}`,
          startsAt: new Date(),
          checkInCode:
            `${suffix.slice(0, 6)}${String(seq).padStart(2, "0")}`.toUpperCase(),
          createdById: officer.id,
        })
        .returning();
      eventIds.push(event!.id);
      await db
        .insert(eventCheckIns)
        .values({ eventId: event!.id, userId: user.id, pointsEarned: 10 });
    }
  }

  /** An election with the given positions, one approved candidate each (or more). */
  async function makeElection(
    label: string,
    options: {
      positions?: string[];
      candidates?: TestUser[];
      minCheckIns?: number;
      opensAt?: Date;
    } = {},
  ) {
    const election = await callerFor(officer).election.create({
      title: `ev2 ${label} ${suffix}`,
      positions: options.positions ?? ["President"],
      minCheckIns: options.minCheckIns,
    });
    electionIds.push(election.id);
    if (options.opensAt) {
      await db
        .update(elections)
        .set({ opensAt: options.opensAt })
        .where(eq(elections.id, election.id));
    }
    const positions = await db
      .select()
      .from(electionPositions)
      .where(eq(electionPositions.electionId, election.id))
      .orderBy(electionPositions.sortOrder);
    const candidateIds: string[] = [];
    for (const candidate of options.candidates ?? []) {
      const [row] = await db
        .insert(electionCandidates)
        .values({
          positionId: positions[0]!.id,
          userId: candidate.id,
          statement: `vote ${candidate.id}`,
          status: "approved",
        })
        .returning({ id: electionCandidates.id });
      candidateIds.push(row!.id);
    }
    return { id: election.id, title: election.title, positions, candidateIds };
  }

  const open = (id: string) =>
    callerFor(officer).election.setPhase({ electionId: id, phase: "voting" });
  const phaseOf = async (id: string) =>
    (
      await db
        .select({ phase: elections.phase })
        .from(elections)
        .where(eq(elections.id, id))
    )[0]!.phase;
  const ballotsFor = (positionId: string) =>
    db
      .select()
      .from(electionBallots)
      .where(eq(electionBallots.positionId, positionId));

  beforeAll(async () => {
    officer = await makeUser("officer", "ADMIN");
    member = await makeUser("member");
    await checkIn(officer);
  }, SLOW);

  afterAll(async () => {
    unstubAllEnvs();
    if (electionIds.length > 0) {
      await db.delete(elections).where(inArray(elections.id, electionIds));
    }
    await db
      .delete(eventCheckIns)
      .where(inArray(eventCheckIns.userId, userIds));
    if (eventIds.length > 0) {
      await db.delete(events).where(inArray(events.id, eventIds));
    }
    await db
      .delete(auditLog)
      .where(
        inArray(auditLog.targetId, electionIds.length ? electionIds : ["-"]),
      );
    await db.delete(users).where(inArray(users.id, userIds));
  }, SLOW);

  beforeEach(() => {
    sent.length = 0;
    probe = null;
    stubEnv("GMAIL_USER", "chapter@example.com");
    stubEnv("GMAIL_APP_PASSWORD", "app-password");
  });

  describe("the frozen voter list", () => {
    it(
      "is taken when voting opens from the election's own rule, and never changes after",
      async () => {
        const once = await makeUser("once");
        const twice = await makeUser("twice");
        const late = await makeUser("late");
        const runner = await makeUser("runner");
        await checkIn(once, 1);
        await checkIn(twice, 2);
        await checkIn(runner, 2);
        const election = await makeElection("frozen", {
          candidates: [runner],
          minCheckIns: 2,
        });

        await open(election.id);

        const roll = await db
          .select({ userId: electionRoll.userId })
          .from(electionRoll)
          .where(eq(electionRoll.electionId, election.id));
        const listed = new Set(roll.map((row) => row.userId));
        expect(listed.has(twice.id)).toBe(true);
        expect(listed.has(runner.id)).toBe(true);
        // One check-in is under this election's rule of two.
        expect(listed.has(once.id)).toBe(false);

        // A check-in after voting opened changes nothing.
        await checkIn(late, 2);
        const vote = (user: TestUser) =>
          callerFor(user).election.vote({
            positionId: election.positions[0]!.id,
            candidateId: election.candidateIds[0]!,
          });
        expect(await errorCode(vote(late))).toBe("FORBIDDEN");
        expect(await errorCode(vote(once))).toBe("FORBIDDEN");
        expect(await errorCode(vote(twice))).toBe("NO_ERROR");

        const view = await callerFor(late).election.current();
        expect(
          view.elections.find((row) => row.id === election.id)!.eligible,
        ).toBe(false);
        expect(
          (await callerFor(twice).election.current()).elections.find(
            (row) => row.id === election.id,
          )!.eligible,
        ).toBe(true);
        // Reopening nominations (nobody has voted in this one) unfreezes it;
        // with a vote cast it is refused.
        expect(
          await errorCode(
            callerFor(officer).election.setPhase({
              electionId: election.id,
              phase: "nominating",
            }),
          ),
        ).toBe("BAD_REQUEST");
      },
      SLOW,
    );
  });

  describe("the secret ballot", () => {
    it(
      "stores what was chosen with no voter, and a deleted member changes no tally",
      async () => {
        const runner = await makeUser("sb-runner");
        const a = await makeUser("sb-a");
        const b = await makeUser("sb-b");
        for (const user of [runner, a, b]) await checkIn(user);
        const election = await makeElection("secret", {
          candidates: [runner],
        });
        await open(election.id);
        const position = election.positions[0]!.id;
        for (const user of [a, b]) {
          await callerFor(user).election.vote({
            positionId: position,
            candidateId: election.candidateIds[0]!,
          });
        }

        const columns = await db.execute(
          sql`select column_name from information_schema.columns
              where table_name = 'buzz_election_ballot' order by column_name`,
        );
        expect(
          columns.rows.map(
            (row) => (row as { column_name: string }).column_name,
          ),
        ).toEqual(["candidateId", "id", "positionId"]);
        const ballots = await ballotsFor(position);
        expect(ballots).toHaveLength(2);
        for (const ballot of ballots) {
          expect(JSON.stringify(ballot)).not.toContain(a.id);
          expect(JSON.stringify(ballot)).not.toContain(b.id);
        }
        const voters = await db
          .select()
          .from(electionVoters)
          .where(eq(electionVoters.positionId, position));
        expect(voters.map((row) => row.voterId).sort()).toEqual(
          [a.id, b.id].sort(),
        );

        // Closing, then deleting a voter, leaves the count alone.
        await callerFor(officer).election.setPhase({
          electionId: election.id,
          phase: "closed",
        });
        const before = (await callerFor(officer).election.list()).find(
          (row) => row.id === election.id,
        )!;
        await db.delete(users).where(eq(users.id, a.id));
        const after = (await callerFor(officer).election.list()).find(
          (row) => row.id === election.id,
        )!;
        expect(before.positions[0]!.candidates[0]!.votes).toBe(2);
        expect(after.positions[0]!.candidates[0]!.votes).toBe(2);
        expect(await ballotsFor(position)).toHaveLength(2);
      },
      SLOW,
    );

    it(
      "refuses a second vote on a position, however many arrive together",
      async () => {
        const runner = await makeUser("dv-runner");
        const voter = await makeUser("dv-voter");
        await checkIn(runner);
        await checkIn(voter);
        const election = await makeElection("double", {
          candidates: [runner],
        });
        await open(election.id);
        const position = election.positions[0]!.id;

        const results = await Promise.allSettled(
          Array.from({ length: 6 }, () =>
            callerFor(voter).election.vote({
              positionId: position,
              candidateId: election.candidateIds[0]!,
            }),
          ),
        );

        const codes = results.map((result) =>
          result.status === "fulfilled"
            ? "OK"
            : (result.reason as { code?: string }).code,
        );
        expect(codes.filter((code) => code === "OK")).toHaveLength(1);
        for (const code of codes.filter((code) => code !== "OK")) {
          // A rate limit may refuse some before they reach the table.
          expect(["CONFLICT", "TOO_MANY_REQUESTS"]).toContain(code!);
        }
        expect(await ballotsFor(position)).toHaveLength(1);
        expect(
          await db
            .select()
            .from(electionVoters)
            .where(eq(electionVoters.positionId, position)),
        ).toHaveLength(1);
      },
      SLOW,
    );
  });

  describe("a vote racing the phase flip", () => {
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
          .set({ phase: "closed" })
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

    it(
      "refuses, and records nothing, for a ballot that arrives as voting closes",
      async () => {
        const runner = await makeUser("race-runner");
        const voter = await makeUser("race-voter");
        await checkIn(runner);
        await checkIn(voter);
        const election = await makeElection("race", { candidates: [runner] });
        await open(election.id);
        const position = election.positions[0]!.id;

        const outcome = await whileFlipping(election.id, () =>
          callerFor(voter).election.vote({
            positionId: position,
            candidateId: election.candidateIds[0]!,
          }),
        );

        expect(outcome).toBe("BAD_REQUEST");
        expect(await ballotsFor(position)).toHaveLength(0);
        expect(
          await db
            .select()
            .from(electionVoters)
            .where(eq(electionVoters.positionId, position)),
        ).toHaveLength(0);
      },
      SLOW,
    );

    it(
      "counts every ballot that returned success and none after the close",
      async () => {
        const runner = await makeUser("storm-runner");
        const voters: TestUser[] = [];
        await checkIn(runner);
        for (let i = 0; i < 12; i++) {
          const voter = await makeUser(`storm-${i}`);
          await checkIn(voter);
          voters.push(voter);
        }
        const election = await makeElection("storm", { candidates: [runner] });
        await open(election.id);
        const position = election.positions[0]!.id;

        const [outcomes] = await Promise.all([
          Promise.allSettled(
            voters.map((voter) =>
              callerFor(voter).election.vote({
                positionId: position,
                candidateId: election.candidateIds[0]!,
              }),
            ),
          ),
          new Promise((resolve) => setTimeout(resolve, 15)).then(() =>
            callerFor(officer).election.setPhase({
              electionId: election.id,
              phase: "closed",
            }),
          ),
        ]);

        const accepted = outcomes.filter(
          (outcome) => outcome.status === "fulfilled",
        ).length;
        // Whatever the interleaving: what was acknowledged is exactly what is
        // counted, voters and ballots agree, and the election ended closed.
        expect(await ballotsFor(position)).toHaveLength(accepted);
        expect(
          await db
            .select()
            .from(electionVoters)
            .where(eq(electionVoters.positionId, position)),
        ).toHaveLength(accepted);
        expect(await phaseOf(election.id)).toBe("closed");

        // And nothing is accepted once it is closed.
        expect(
          await errorCode(
            callerFor(voters[0]!).election.vote({
              positionId: position,
              candidateId: election.candidateIds[0]!,
            }),
          ),
        ).not.toBe("NO_ERROR");
        expect(await ballotsFor(position)).toHaveLength(accepted);
      },
      SLOW,
    );

    it(
      "refuses ballots after the closing time, whether or not anything has flipped the phase yet",
      async () => {
        const runner = await makeUser("late-runner");
        const voter = await makeUser("late-voter");
        await checkIn(runner);
        await checkIn(voter);
        const election = await makeElection("overdue", {
          candidates: [runner],
        });
        await open(election.id);
        await db
          .update(elections)
          .set({ closesAt: new Date(Date.now() - 1000) })
          .where(eq(elections.id, election.id));

        expect(
          await errorCode(
            callerFor(voter).election.vote({
              positionId: election.positions[0]!.id,
              candidateId: election.candidateIds[0]!,
            }),
          ),
        ).toBe("BAD_REQUEST");
        expect(await ballotsFor(election.positions[0]!.id)).toHaveLength(0);
        // The refused request also closed it: the lazy flip, not the cron.
        expect(await phaseOf(election.id)).toBe("closed");
      },
      SLOW,
    );
  });

  describe("scheduled flips", () => {
    it(
      "open and close on schedule, audit as the scheduler and announce after the commit",
      async () => {
        const runner = await makeUser("cron-runner");
        const voter = await makeUser("cron-voter");
        await checkIn(runner);
        await checkIn(voter);
        const election = await makeElection("cron", {
          candidates: [runner],
          opensAt: new Date(Date.now() - 60_000),
        });
        const notDue = await makeElection("not-due", {
          candidates: [runner],
          opensAt: new Date(Date.now() + 3_600_000),
        });
        const manual = await makeElection("manual", { candidates: [runner] });

        sent.length = 0;
        probe = () => phaseOf(election.id);
        const first = await runScheduledFlips(db);

        expect(first.flipped).toContainEqual({
          id: election.id,
          phase: "voting",
        });
        expect(first.flipped.some((flip) => flip.id === notDue.id)).toBe(false);
        expect(first.flipped.some((flip) => flip.id === manual.id)).toBe(false);
        expect(await phaseOf(election.id)).toBe("voting");
        expect(await phaseOf(notDue.id)).toBe("nominating");
        expect(await phaseOf(manual.id)).toBe("nominating");

        // The voter list was frozen by the flip.
        const roll = await db
          .select({ userId: electionRoll.userId })
          .from(electionRoll)
          .where(eq(electionRoll.electionId, election.id));
        expect(roll.map((row) => row.userId)).toContain(voter.id);

        // Same notice as a manual flip, sent after the phase committed.
        const mail = sent.filter((m) => m.to.includes(suffix));
        expect(mail.length).toBeGreaterThanOrEqual(2);
        for (const m of mail) {
          expect(m.subject).toBe(`Voting is open: ${election.title}`);
          expect(m.phase).toBe("voting");
        }

        const [audit] = await db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.targetId, election.id),
              eq(auditLog.action, "election.set_phase"),
            ),
          );
        expect(audit).toMatchObject({
          actorId: "system:cron",
          targetType: "election",
          before: { phase: "nominating" },
          after: { phase: "voting", scheduled: true },
        });

        // A second run does nothing until the closing time passes.
        expect((await runScheduledFlips(db)).flipped).toEqual([]);
        await db
          .update(elections)
          .set({ closesAt: new Date(Date.now() - 1000) })
          .where(eq(elections.id, election.id));
        const second = await runScheduledFlips(db);
        expect(second.flipped).toContainEqual({
          id: election.id,
          phase: "closed",
        });
        expect(await phaseOf(election.id)).toBe("closed");
      },
      SLOW,
    );

    it(
      "leaves an election with nobody approved alone and says so",
      async () => {
        const election = await makeElection("empty", {
          opensAt: new Date(Date.now() - 60_000),
        });
        const run = await runScheduledFlips(db);
        expect(run.skipped).toContainEqual({
          id: election.id,
          reason: "Approve at least one candidate before opening voting.",
        });
        expect(await phaseOf(election.id)).toBe("nominating");
      },
      SLOW,
    );

    it(
      "keeps a manual flip working on a scheduled election",
      async () => {
        const runner = await makeUser("hand-runner");
        await checkIn(runner);
        const election = await makeElection("by-hand", {
          candidates: [runner],
          opensAt: new Date(Date.now() + 3_600_000),
        });
        await open(election.id);
        expect(await phaseOf(election.id)).toBe("voting");
        // The cron has nothing to do for it now.
        expect((await runScheduledFlips(db)).flipped).not.toContainEqual({
          id: election.id,
          phase: "voting",
        });
      },
      SLOW,
    );

    it(
      "is configured by officers: times must make sense and only closing moves while voting",
      async () => {
        const runner = await makeUser("cfg-runner");
        await checkIn(runner);
        const election = await makeElection("cfg", { candidates: [runner] });
        const officerApi = callerFor(officer).election;
        const day = 86_400_000;

        expect(
          await errorCode(
            officerApi.configure({
              electionId: election.id,
              opensAt: new Date(Date.now() + 2 * day),
              closesAt: new Date(Date.now() + day),
            }),
          ),
        ).toBe("BAD_REQUEST");
        const saved = await officerApi.configure({
          electionId: election.id,
          opensAt: new Date(Date.now() + day),
          closesAt: new Date(Date.now() + 2 * day),
          minCheckIns: 3,
        });
        expect(saved.minCheckIns).toBe(3);
        expect(
          await errorCode(
            callerFor(member).election.configure({
              electionId: election.id,
              minCheckIns: 1,
            }),
          ),
        ).toBe("FORBIDDEN");

        await officerApi.configure({ electionId: election.id, minCheckIns: 1 });
        await open(election.id);
        expect(
          await errorCode(
            officerApi.configure({ electionId: election.id, minCheckIns: 5 }),
          ),
        ).toBe("BAD_REQUEST");
        const extended = await officerApi.configure({
          electionId: election.id,
          closesAt: new Date(Date.now() + 5 * day),
        });
        expect(extended.closesAt!.getTime()).toBeGreaterThan(
          Date.now() + 4 * day,
        );
      },
      SLOW,
    );
  });

  describe("the cron route", () => {
    const call = (authorization?: string) =>
      cronGet(
        new Request("https://buzz.test/api/cron/elections", {
          headers: authorization ? { authorization } : {},
        }),
      );

    it(
      "refuses everyone without the secret and flips due elections with it",
      async () => {
        const runner = await makeUser("route-runner");
        await checkIn(runner);
        const election = await makeElection("route", {
          candidates: [runner],
          opensAt: new Date(Date.now() - 60_000),
        });

        stubEnv("CRON_SECRET", CRON_SECRET);
        expect((await call()).status).toBe(401);
        expect((await call("Bearer nope")).status).toBe(401);
        expect((await call(CRON_SECRET)).status).toBe(401);
        expect(await phaseOf(election.id)).toBe("nominating");

        // A secret that is too short refuses even a matching header.
        stubEnv("CRON_SECRET", "short");
        expect((await call("Bearer short")).status).toBe(401);
        stubEnv("CRON_SECRET", CRON_SECRET);

        const ok = await call(`Bearer ${CRON_SECRET}`);
        expect(ok.status).toBe(200);
        expect(
          ((await ok.json()) as { flipped: number }).flipped,
        ).toBeGreaterThanOrEqual(1);
        expect(await phaseOf(election.id)).toBe("voting");
      },
      SLOW,
    );
  });

  describe("the tally export", () => {
    it(
      "is for officers, waits for the close, and holds counts but no voter",
      async () => {
        const runner = await makeUser("csv-runner");
        const rival = await makeUser("csv-rival");
        const a = await makeUser("csv-a");
        const b = await makeUser("csv-b");
        for (const user of [runner, rival, a, b]) await checkIn(user);
        const election = await makeElection("csv", {
          candidates: [runner, rival],
        });
        const [first, second] = election.candidateIds;
        await open(election.id);

        expect(
          await errorCode(
            callerFor(member).election.exportTally({ electionId: election.id }),
          ),
        ).toBe("FORBIDDEN");
        expect(
          await errorCode(
            callerFor(officer).election.exportTally({
              electionId: election.id,
            }),
          ),
        ).toBe("BAD_REQUEST");

        const position = election.positions[0]!.id;
        await callerFor(a).election.vote({
          positionId: position,
          candidateId: first!,
        });
        await callerFor(b).election.vote({
          positionId: position,
          candidateId: first!,
        });
        await callerFor(runner).election.vote({
          positionId: position,
          candidateId: second!,
        });
        await callerFor(officer).election.setPhase({
          electionId: election.id,
          phase: "closed",
        });

        const exported = await callerFor(officer).election.exportTally({
          electionId: election.id,
        });
        const body = JSON.stringify(exported.rows);
        for (const voter of [a, b]) {
          expect(body).not.toContain(voter.id);
          expect(body).not.toContain(voter.email);
        }
        const byCandidate: Record<string, string | number | undefined> = {};
        for (const row of exported.rows) {
          if (row[3] === "Ballots cast" || row[0] === "Election") continue;
          byCandidate[String(row[4])] = row[5];
        }
        expect(byCandidate).toEqual({ [runner.email]: 2, [rival.email]: 1 });
        const turnout = exported.rows.find((row) => row[3] === "Ballots cast")!;
        expect(turnout[5]).toBe(3);

        const logged = await db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.targetId, election.id),
              eq(auditLog.action, "export.election_tally"),
            ),
          );
        expect(logged).toHaveLength(1);
        expect(logged[0]!.actorId).toBe(officer.id);
      },
      SLOW,
    );
  });

  describe("positions", () => {
    it(
      "can be added, renamed and removed until voting opens, then are locked",
      async () => {
        const runner = await makeUser("pos-runner");
        await checkIn(runner);
        const election = await makeElection("positions", {
          positions: ["President", "Treasurer"],
          candidates: [runner],
        });
        const api = callerFor(officer).election;

        const added = await api.addPosition({
          electionId: election.id,
          title: "Secretary",
        });
        await api.renamePosition({ positionId: added.id, title: "Historian" });
        await api.removePosition({ positionId: election.positions[1]!.id });
        const listed = (await api.list()).find(
          (row) => row.id === election.id,
        )!;
        expect(listed.positions.map((position) => position.title)).toEqual([
          "President",
          "Historian",
        ]);
        const single = await makeElection("single", {
          positions: ["Only"],
        });
        expect(
          await errorCode(
            api.removePosition({ positionId: single.positions[0]!.id }),
          ),
        ).toBe("BAD_REQUEST");

        await open(election.id);
        for (const attempt of [
          () => api.addPosition({ electionId: election.id, title: "Late" }),
          () => api.renamePosition({ positionId: added.id, title: "Renamed" }),
          () => api.removePosition({ positionId: added.id }),
        ]) {
          expect(await errorCode(attempt())).toBe("BAD_REQUEST");
        }
        const audit = await db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.targetId, election.id),
              eq(auditLog.action, "election.edit_positions"),
            ),
          );
        expect(audit.length).toBeGreaterThanOrEqual(3);
      },
      SLOW,
    );
  });

  describe("officer audit rows", () => {
    it(
      "record create, review, delete and phase changes by the officer who made them",
      async () => {
        const runner = await makeUser("aud-runner");
        await checkIn(runner);
        const election = await makeElection("audit");
        const candidate = await callerFor(runner).election.nominate({
          positionId: election.positions[0]!.id,
          statement: "Hello",
        });
        await callerFor(officer).election.setCandidateStatus({
          candidateId: candidate!.id,
          status: "approved",
        });
        await callerFor(officer).election.delete({ electionId: election.id });

        const rows = await db
          .select({ action: auditLog.action, actorId: auditLog.actorId })
          .from(auditLog)
          .where(eq(auditLog.targetId, election.id));
        expect(rows.map((row) => row.action).sort()).toEqual([
          "election.create",
          "election.delete",
          "election.review_candidate",
        ]);
        for (const row of rows) expect(row.actorId).toBe(officer.id);
      },
      SLOW,
    );
  });

  describe("the board from results", () => {
    it(
      "lists the winners of the latest published election, with ties shared and unvoted seats open",
      async () => {
        const ada = await makeUser("board-ada");
        const bea = await makeUser("board-bea");
        const cy = await makeUser("board-cy");
        const dee = await makeUser("board-dee");
        const voters: TestUser[] = [];
        for (const user of [ada, bea, cy, dee]) await checkIn(user);
        for (let i = 0; i < 2; i++) {
          const voter = await makeUser(`board-v${i}`);
          await checkIn(voter);
          voters.push(voter);
        }
        const election = await makeElection("board", {
          positions: ["President", "Treasurer", "Secretary"],
          candidates: [ada, bea],
        });
        const [president, treasurer, secretary] = election.positions;
        const [adaId, beaId] = election.candidateIds;
        // Treasurer: a tie. Secretary: nobody votes.
        const [cyRow, deeRow] = await db
          .insert(electionCandidates)
          .values([
            {
              positionId: treasurer!.id,
              userId: cy.id,
              statement: "cy",
              status: "approved",
            },
            {
              positionId: treasurer!.id,
              userId: dee.id,
              statement: "dee",
              status: "approved",
            },
            {
              positionId: secretary!.id,
              userId: cy.id,
              statement: "cy sec",
              status: "approved",
            },
          ])
          .returning({ id: electionCandidates.id });
        await open(election.id);
        const [v0, v1] = voters;
        await callerFor(v0!).election.vote({
          positionId: president!.id,
          candidateId: adaId!,
        });
        await callerFor(v1!).election.vote({
          positionId: president!.id,
          candidateId: adaId!,
        });
        await callerFor(v0!).election.vote({
          positionId: treasurer!.id,
          candidateId: cyRow!.id,
        });
        await callerFor(v1!).election.vote({
          positionId: treasurer!.id,
          candidateId: deeRow!.id,
        });
        void beaId;

        // Before publishing, this election does not appear.
        const beforePublish = await boardFromResults(db);
        expect(JSON.stringify(beforePublish)).not.toContain(ada.id);
        expect(JSON.stringify(beforePublish ?? [])).not.toContain(
          "Zed board-ada",
        );

        for (const phase of ["closed", "published"] as const) {
          await callerFor(officer).election.setPhase({
            electionId: election.id,
            phase,
          });
        }
        const seats = await boardFromResults(db);
        // Seat holders by id; the account's own image is never part of a seat.
        expect(seats).toEqual([
          {
            role: "President",
            name: `Zed board-ada ${suffix}`,
            userId: ada.id,
          },
          { role: "Treasurer", name: `Zed board-cy ${suffix}`, userId: cy.id },
          {
            role: "Treasurer",
            name: `Zed board-dee ${suffix}`,
            userId: dee.id,
          },
          { role: "Secretary" },
        ]);
      },
      SLOW,
    );
  });

  describe("the ballot shuffle at close", () => {
    it(
      "gives every ballot a new id and leaves every tally identical",
      async () => {
        const runner = await makeUser("sh-runner");
        const rival = await makeUser("sh-rival");
        const voters: TestUser[] = [];
        await checkIn(runner);
        await checkIn(rival);
        for (let i = 0; i < 8; i++) {
          const voter = await makeUser(`sh-${i}`);
          await checkIn(voter);
          voters.push(voter);
        }
        const election = await makeElection("shuffle", {
          candidates: [runner, rival],
        });
        await open(election.id);
        const position = election.positions[0]!.id;
        for (const [i, voter] of voters.entries()) {
          await callerFor(voter).election.vote({
            positionId: position,
            candidateId: election.candidateIds[i % 3 === 0 ? 1 : 0]!,
          });
        }
        const tally = async () =>
          (
            await db
              .select({
                candidateId: electionBallots.candidateId,
                n: sql<number>`count(*)::int`,
              })
              .from(electionBallots)
              .where(eq(electionBallots.positionId, position))
              .groupBy(electionBallots.candidateId)
              .orderBy(electionBallots.candidateId)
          ).map((row) => [row.candidateId, row.n]);
        const idsBefore = (await ballotsFor(position)).map((b) => b.id);
        const tallyBefore = await tally();
        expect(idsBefore).toHaveLength(8);

        await callerFor(officer).election.setPhase({
          electionId: election.id,
          phase: "closed",
        });

        const idsAfter = (await ballotsFor(position)).map((b) => b.id);
        expect(idsAfter).toHaveLength(8);
        expect(idsAfter.filter((id) => idsBefore.includes(id))).toEqual([]);
        for (const id of idsAfter) expect(id).toMatch(/^[0-9a-f-]{36}$/);
        expect(await tally()).toEqual(tallyBefore);
        // The voters are untouched: only the choices were rewritten.
        expect(
          await db
            .select()
            .from(electionVoters)
            .where(eq(electionVoters.positionId, position)),
        ).toHaveLength(8);
        // One transaction wrote them all, so no ballot stands out by xmin.
        const xmins = await db.execute(
          sql`select count(distinct xmin::text)::int as n
              from buzz_election_ballot where "positionId" = ${position}`,
        );
        expect((xmins.rows[0] as { n: number }).n).toBe(1);
      },
      SLOW,
    );
  });

  describe("the lazy flip", () => {
    const deferred = () => {
      const tasks: (() => Promise<unknown>)[] = [];
      return {
        tasks,
        defer: (task: () => Promise<unknown>) => void tasks.push(task),
      };
    };

    it(
      "opens a due election on the first request, sends the notice only after the response, and once",
      async () => {
        const runner = await makeUser("lazy-runner");
        const first = await makeUser("lazy-a");
        const second = await makeUser("lazy-b");
        for (const user of [runner, first, second]) await checkIn(user);
        const election = await makeElection("lazy", {
          candidates: [runner],
          opensAt: new Date(Date.now() - 60_000),
        });
        sent.length = 0;
        const later = deferred();

        // Two requests arrive together; neither is the cron.
        await Promise.all([
          callerFor(first, later.defer).election.current(),
          callerFor(second, later.defer).election.current(),
        ]);

        expect(await phaseOf(election.id)).toBe("voting");
        const audit = await db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.targetId, election.id),
              eq(auditLog.action, "election.set_phase"),
            ),
          );
        expect(audit).toHaveLength(1);
        // Nothing was sent inside either request; exactly one notice is queued.
        expect(sent.filter((m) => m.to.includes(suffix))).toHaveLength(0);
        expect(later.tasks).toHaveLength(1);

        probe = () => phaseOf(election.id);
        await later.tasks[0]!();
        const mail = sent.filter((m) => m.to.includes(suffix));
        expect(mail.length).toBeGreaterThanOrEqual(3);
        for (const m of mail) {
          expect(m.subject).toBe(`Voting is open: ${election.title}`);
          expect(m.phase).toBe("voting");
        }
        expect(new Set(mail.map((m) => m.to)).size).toBe(mail.length);

        // A later request, or the cron, finds nothing left to do.
        const again = deferred();
        await callerFor(first, again.defer).election.current();
        expect(again.tasks).toHaveLength(0);
        expect((await runScheduledFlips(db)).flipped).not.toContainEqual({
          id: election.id,
          phase: "voting",
        });
      },
      SLOW,
    );

    it(
      "lets a ballot through at the scheduled moment, before any cron",
      async () => {
        const runner = await makeUser("lv-runner");
        const voter = await makeUser("lv-voter");
        await checkIn(runner);
        await checkIn(voter);
        const election = await makeElection("lazy-vote", {
          candidates: [runner],
          opensAt: new Date(Date.now() - 1000),
        });
        expect(await phaseOf(election.id)).toBe("nominating");

        await callerFor(voter).election.vote({
          positionId: election.positions[0]!.id,
          candidateId: election.candidateIds[0]!,
        });

        expect(await phaseOf(election.id)).toBe("voting");
        expect(await ballotsFor(election.positions[0]!.id)).toHaveLength(1);
      },
      SLOW,
    );

    it(
      "passes over an election that cannot open without taking a lock, and the officer page says why",
      async () => {
        const election = await makeElection("stuck", {
          opensAt: new Date(Date.now() - 1000),
        });
        let transactions = 0;
        const counting = new Proxy(db, {
          get(target, property, receiver) {
            if (property === "transaction") {
              return (...args: unknown[]) => {
                transactions += 1;
                return (
                  target.transaction as (...a: unknown[]) => Promise<unknown>
                )(...args);
              };
            }
            return Reflect.get(target, property, receiver) as unknown;
          },
        });

        for (let i = 0; i < 3; i++) {
          const run = await runScheduledFlips(counting);
          expect(run.skipped).toContainEqual({
            id: election.id,
            reason: "Approve at least one candidate before opening voting.",
          });
        }
        // Not one transaction, so no row lock and no failed write, per read.
        expect(transactions).toBe(0);
        expect(await phaseOf(election.id)).toBe("nominating");

        const listed = (await callerFor(officer).election.list()).find(
          (row) => row.id === election.id,
        )!;
        expect(listed.stuck).toBe(
          "Approve at least one candidate before opening voting.",
        );

        // Approving someone clears it, and the next read opens it.
        const runner = await makeUser("stuck-runner");
        await checkIn(runner);
        const candidate = await callerFor(runner).election.nominate({
          positionId: election.positions[0]!.id,
          statement: "Ready.",
        });
        await callerFor(officer).election.setCandidateStatus({
          candidateId: candidate!.id,
          status: "approved",
        });
        const after = (await callerFor(officer).election.list()).find(
          (row) => row.id === election.id,
        )!;
        expect(after.stuck).toBeNull();
        expect(after.phase).toBe("voting");
      },
      SLOW,
    );

    it(
      "shows the officer list a due election already moved",
      async () => {
        const runner = await makeUser("ll-runner");
        await checkIn(runner);
        const election = await makeElection("lazy-list", {
          candidates: [runner],
          opensAt: new Date(Date.now() - 1000),
        });
        const listed = (await callerFor(officer).election.list()).find(
          (row) => row.id === election.id,
        )!;
        expect(listed.phase).toBe("voting");
      },
      SLOW,
    );
  });
});
