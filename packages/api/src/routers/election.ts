import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";

import { recordAudit } from "../audit";
import {
  advanceElection,
  badRequest,
  checkInsThisYear,
  ELECTION_PHASES,
  electionRecipients,
  tallyRows,
  yearTally,
  type Database,
  type Tx,
} from "../election-flow";
import { notFound } from "../errors";
import { notifyElectionPhase } from "../notify";
import { isUniqueViolation } from "../pg-errors";
import {
  assertRateLimit,
  ELECTION_ACTION_LIMIT,
  EXPORT_ROSTER_LIMIT,
} from "../rate-limit";
import { schoolYear, schoolYearPattern } from "../terms";
import { adminProcedure, createTRPCRouter, protectedProcedure } from "../trpc";
import {
  electionBallots,
  electionCandidates,
  electionPositions,
  electionRoll,
  elections,
  electionVoters,
  users,
  type CandidateStatus,
} from "@buzz/db";

async function loadElection(db: Database, electionId: string) {
  const [election] = await db
    .select()
    .from(elections)
    .where(eq(elections.id, electionId));
  if (!election) notFound("Election");
  return election;
}

async function positionWithElection(db: Database, positionId: string) {
  const [row] = await db
    .select({
      positionId: electionPositions.id,
      electionId: elections.id,
      phase: elections.phase,
    })
    .from(electionPositions)
    .innerJoin(elections, eq(elections.id, electionPositions.electionId))
    .where(eq(electionPositions.id, positionId));
  if (!row) notFound("Position");
  return row;
}

/**
 * Runs `write` while the election is still nominating, under a shared lock on
 * its row. `advanceElection` takes the same row FOR UPDATE, so a phase flip
 * waits for the write or the write sees the new phase: no nomination,
 * withdrawal, approval or position edit lands in an election after voting
 * opened. `vote` does the same for ballots.
 */
async function whileNominating<T>(
  db: Database,
  electionId: string,
  closedMessage: string,
  write: (tx: Tx, election: { title: string }) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ phase: elections.phase, title: elections.title })
      .from(elections)
      .where(eq(elections.id, electionId))
      .for("share");
    if (locked?.phase !== "nominating") badRequest(closedMessage);
    return write(tx, locked);
  });
}

/**
 * One year's elections, positions and candidates in a single statement, as
 * nested rows rebuilt from one left-joined result. One snapshot, one round
 * trip, one pool checkout. Elections come newest first, positions by
 * `sortOrder`, candidates by name.
 */
async function electionTree(db: Database, year: string) {
  const joined = await db
    .select({
      election: elections,
      positionId: electionPositions.id,
      positionTitle: electionPositions.title,
      positionSortOrder: electionPositions.sortOrder,
      candidateId: electionCandidates.id,
      candidateUserId: electionCandidates.userId,
      statement: electionCandidates.statement,
      status: electionCandidates.status,
      createdAt: electionCandidates.createdAt,
      name: users.name,
      email: users.email,
    })
    .from(elections)
    .leftJoin(electionPositions, eq(electionPositions.electionId, elections.id))
    .leftJoin(
      electionCandidates,
      eq(electionCandidates.positionId, electionPositions.id),
    )
    .leftJoin(users, eq(users.id, electionCandidates.userId))
    .where(eq(elections.year, year))
    .orderBy(
      desc(elections.createdAt),
      asc(electionPositions.sortOrder),
      asc(users.name),
    );

  const rows = new Map<string, (typeof joined)[number]["election"]>();
  const positions = new Map<
    string,
    { id: string; electionId: string; title: string; sortOrder: number }
  >();
  const candidates: {
    id: string;
    positionId: string;
    userId: string;
    statement: string;
    status: CandidateStatus;
    createdAt: Date;
    name: string | null;
    email: string | null;
  }[] = [];
  for (const row of joined) {
    rows.set(row.election.id, row.election);
    if (row.positionId === null) continue;
    positions.set(row.positionId, {
      id: row.positionId,
      electionId: row.election.id,
      title: row.positionTitle!,
      sortOrder: row.positionSortOrder!,
    });
    if (row.candidateId === null) continue;
    candidates.push({
      id: row.candidateId,
      positionId: row.positionId,
      userId: row.candidateUserId!,
      statement: row.statement!,
      status: row.status!,
      createdAt: row.createdAt!,
      name: row.name,
      email: row.email,
    });
  }
  return {
    rows: [...rows.values()],
    positions: [...positions.values()],
    candidates,
  };
}

const yearInput = z
  .object({ year: z.string().regex(schoolYearPattern).optional() })
  .nullish();

const positionTitle = z.string().trim().min(1).max(80);

/** Open and close times: closing must follow opening, and still be ahead. */
function checkSchedule(opensAt: Date | null, closesAt: Date | null, now: Date) {
  if (closesAt && closesAt <= now) {
    badRequest("The closing time has to be in the future.");
  }
  if (opensAt && closesAt && closesAt <= opensAt) {
    badRequest("Voting has to close after it opens.");
  }
}

const schedule = {
  opensAt: z.coerce.date().nullable().optional(),
  closesAt: z.coerce.date().nullable().optional(),
  minCheckIns: z.number().int().min(1).max(50).optional(),
};

export const electionRouter = createTRPCRouter({
  /**
   * This school year's elections as a member sees them. Approved candidates
   * only, the caller's own candidacies, whether they have voted on each
   * position (never which candidate: ballots carry no voter), and counts only
   * once an officer has published.
   */
  current: protectedProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const userId = ctx.session.user.id;
    const year = schoolYear(now);
    const yearPositions = ctx.db
      .select({ id: electionPositions.id })
      .from(electionPositions)
      .innerJoin(elections, eq(elections.id, electionPositions.electionId))
      .where(eq(elections.year, year));

    const [{ rows, positions, candidates }, votes, voted, onRoll, checkIns] =
      await Promise.all([
        electionTree(ctx.db, year),
        yearTally(ctx.db, year),
        ctx.db
          .select({ positionId: electionVoters.positionId })
          .from(electionVoters)
          .where(
            and(
              eq(electionVoters.voterId, userId),
              inArray(electionVoters.positionId, yearPositions),
            ),
          ),
        ctx.db
          .select({ electionId: electionRoll.electionId })
          .from(electionRoll)
          .where(eq(electionRoll.userId, userId)),
        checkInsThisYear(ctx.db, userId, now),
      ]);
    const counts = votes.perCandidate;
    const votedOn = new Set(voted.map((row) => row.positionId));
    const frozenFor = new Set(onRoll.map((row) => row.electionId));

    return {
      year,
      checkIns,
      elections: rows.map((election) => ({
        id: election.id,
        title: election.title,
        phase: election.phase,
        opensAt: election.opensAt,
        closesAt: election.closesAt,
        minCheckIns: election.minCheckIns,
        rollFrozen: election.rollFrozenAt !== null,
        // Once voting has opened the frozen list decides; before, the rule.
        eligible: election.rollFrozenAt
          ? frozenFor.has(election.id)
          : checkIns >= election.minCheckIns,
        positions: positions
          .filter((position) => position.electionId === election.id)
          .map((position) => {
            const here = candidates.filter(
              (candidate) => candidate.positionId === position.id,
            );
            const mine = here.find((candidate) => candidate.userId === userId);
            const published = election.phase === "published";
            return {
              id: position.id,
              title: position.title,
              candidates: here
                .filter((candidate) => candidate.status === "approved")
                .map((candidate) => ({
                  id: candidate.id,
                  name: candidate.name ?? "Member",
                  statement: candidate.statement,
                  votes: published ? (counts.get(candidate.id) ?? 0) : null,
                })),
              mine: mine
                ? {
                    id: mine.id,
                    status: mine.status,
                    statement: mine.statement,
                  }
                : null,
              voted: votedOn.has(position.id),
            };
          }),
      })),
    };
  }),

  nominate: protectedProcedure
    .input(
      z.object({
        positionId: z.string().min(1),
        statement: z.string().trim().min(1).max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertRateLimit(
        ctx.db,
        `election:${ctx.session.user.id}`,
        ELECTION_ACTION_LIMIT,
      );
      const position = await positionWithElection(ctx.db, input.positionId);
      try {
        return await whileNominating(
          ctx.db,
          position.electionId,
          "Nominations are closed for this election.",
          async (tx) => {
            const [created] = await tx
              .insert(electionCandidates)
              .values({
                positionId: input.positionId,
                userId: ctx.session.user.id,
                statement: input.statement,
              })
              .returning({
                id: electionCandidates.id,
                status: electionCandidates.status,
              });
            return created;
          },
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "You are already running for this position.",
          });
        }
        throw error;
      }
    }),

  withdrawNomination: protectedProcedure
    .input(z.object({ candidateId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await assertRateLimit(
        ctx.db,
        `election:${ctx.session.user.id}`,
        ELECTION_ACTION_LIMIT,
      );
      const [candidate] = await ctx.db
        .select({
          id: electionCandidates.id,
          userId: electionCandidates.userId,
          positionId: electionCandidates.positionId,
        })
        .from(electionCandidates)
        .where(eq(electionCandidates.id, input.candidateId));
      if (candidate?.userId !== ctx.session.user.id) notFound("Nomination");
      const position = await positionWithElection(ctx.db, candidate.positionId);
      await whileNominating(
        ctx.db,
        position.electionId,
        "Nominations are closed. Ask an officer.",
        (tx) =>
          tx
            .delete(electionCandidates)
            .where(eq(electionCandidates.id, candidate.id)),
      );
      return { id: candidate.id };
    }),

  /**
   * One ballot per position, final once cast. Returns no tally.
   *
   * One transaction under a shared lock on the election row: `advanceElection`
   * (FOR UPDATE) waits for it, so a ballot is counted in the voting phase or
   * refused, never counted after close. A closing time that has passed
   * refuses ballots even before the cron flips the phase. Who voted goes in
   * `election_voter` (its primary key refuses a second vote) and what was
   * chosen in `election_ballot`, which carries no voter.
   */
  vote: protectedProcedure
    .input(
      z.object({
        positionId: z.string().min(1),
        candidateId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      await assertRateLimit(
        ctx.db,
        `election:${userId}`,
        ELECTION_ACTION_LIMIT,
      );
      const position = await positionWithElection(ctx.db, input.positionId);
      if (position.phase !== "voting") {
        badRequest("Voting is not open for this election.");
      }

      const [candidate] = await ctx.db
        .select({
          positionId: electionCandidates.positionId,
          status: electionCandidates.status,
        })
        .from(electionCandidates)
        .where(eq(electionCandidates.id, input.candidateId));
      if (
        candidate?.positionId !== input.positionId ||
        candidate.status !== "approved"
      ) {
        badRequest("That candidate is not on this ballot.");
      }

      try {
        await ctx.db.transaction(async (tx) => {
          const [locked] = await tx
            .select({
              phase: elections.phase,
              over: sql<boolean>`${elections.closesAt} is not null and ${elections.closesAt} <= now()`,
            })
            .from(elections)
            .where(eq(elections.id, position.electionId))
            .for("share");
          if (locked?.phase !== "voting" || locked.over) {
            badRequest("Voting is not open for this election.");
          }
          const [listed] = await tx
            .select({ userId: electionRoll.userId })
            .from(electionRoll)
            .where(
              and(
                eq(electionRoll.electionId, position.electionId),
                eq(electionRoll.userId, userId),
              ),
            );
          if (!listed) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message:
                "You were not on the voter list when voting opened. It is frozen at that moment.",
            });
          }
          await tx.insert(electionVoters).values({
            electionId: position.electionId,
            positionId: input.positionId,
            voterId: userId,
          });
          await tx.insert(electionBallots).values({
            positionId: input.positionId,
            candidateId: input.candidateId,
          });
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "You already voted for this position.",
          });
        }
        throw error;
      }
      return { positionId: input.positionId, candidateId: input.candidateId };
    }),

  years: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .selectDistinct({ year: elections.year })
      .from(elections);
    const all = new Set([
      schoolYear(new Date()),
      ...rows.map((row) => row.year),
    ]);
    return [...all].sort().reverse();
  }),

  /**
   * Officer view. Per-candidate counts only once voting is closed, so nobody
   * running the election watches the race; turnout is shown throughout.
   */
  list: adminProcedure.input(yearInput).query(async ({ ctx, input }) => {
    const year = input?.year ?? schoolYear(new Date());
    const [{ rows, positions, candidates }, votes, rolls] = await Promise.all([
      electionTree(ctx.db, year),
      yearTally(ctx.db, year),
      ctx.db
        .select({ electionId: electionRoll.electionId, n: count() })
        .from(electionRoll)
        .innerJoin(elections, eq(elections.id, electionRoll.electionId))
        .where(eq(elections.year, year))
        .groupBy(electionRoll.electionId),
    ]);
    const counts = votes.perCandidate;
    const rollSize = new Map(rolls.map((row) => [row.electionId, row.n]));

    return rows.map((election) => {
      const showCounts =
        election.phase === "closed" || election.phase === "published";
      return {
        id: election.id,
        year: election.year,
        title: election.title,
        phase: election.phase,
        opensAt: election.opensAt,
        closesAt: election.closesAt,
        minCheckIns: election.minCheckIns,
        rollFrozenAt: election.rollFrozenAt,
        rollSize: election.rollFrozenAt
          ? (rollSize.get(election.id) ?? 0)
          : null,
        positions: positions
          .filter((position) => position.electionId === election.id)
          .map((position) => ({
            id: position.id,
            title: position.title,
            voters: votes.perPosition.get(position.id) ?? 0,
            candidates: candidates
              .filter((candidate) => candidate.positionId === position.id)
              .map((candidate) => ({
                id: candidate.id,
                name: candidate.name,
                email: candidate.email,
                statement: candidate.statement,
                status: candidate.status,
                votes: showCounts ? (counts.get(candidate.id) ?? 0) : null,
              })),
          })),
      };
    });
  }),

  create: adminProcedure
    .input(
      z.object({
        title: z.string().trim().min(1).max(120),
        positions: z.array(positionTitle).min(1).max(20),
        ...schedule,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const opensAt = input.opensAt ?? null;
      const closesAt = input.closesAt ?? null;
      checkSchedule(opensAt, closesAt, new Date());

      const created = await ctx.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(elections)
          .values({
            year: schoolYear(new Date()),
            title: input.title,
            opensAt,
            closesAt,
            ...(input.minCheckIns ? { minCheckIns: input.minCheckIns } : {}),
            createdById: ctx.session.user.id,
          })
          .returning();
        if (!created) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Could not create that election.",
          });
        }
        await tx.insert(electionPositions).values(
          input.positions.map((title, sortOrder) => ({
            electionId: created.id,
            title,
            sortOrder,
          })),
        );
        await recordAudit(tx, {
          actorId: ctx.session.user.id,
          action: "election.create",
          targetType: "election",
          targetId: created.id,
          targetLabel: created.title,
          after: {
            positions: input.positions.length,
            opensAt: opensAt?.toISOString() ?? null,
            closesAt: closesAt?.toISOString() ?? null,
            minCheckIns: created.minCheckIns,
          },
        });
        return created;
      });

      // A new election opens for nominations. Told after the commit.
      const notice = await notifyElectionPhase(
        ctx.db,
        created,
        created.phase,
        () => electionRecipients(ctx.db, created, new Date()),
      );
      return { ...created, notice };
    }),

  /**
   * Schedule and eligibility. While nominating all three can change; once
   * voting is open only the closing time can (to extend or shorten it), since
   * the voter list is already frozen. Nothing after that.
   */
  configure: adminProcedure
    .input(z.object({ electionId: z.string().min(1), ...schedule }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const [election] = await tx
          .select()
          .from(elections)
          .where(eq(elections.id, input.electionId))
          .for("update");
        if (!election) notFound("Election");

        const now = new Date();
        const opensAt =
          input.opensAt === undefined ? election.opensAt : input.opensAt;
        const closesAt =
          input.closesAt === undefined ? election.closesAt : input.closesAt;
        const minCheckIns = input.minCheckIns ?? election.minCheckIns;

        if (election.phase === "voting") {
          if (
            opensAt?.getTime() !== election.opensAt?.getTime() ||
            minCheckIns !== election.minCheckIns
          ) {
            badRequest(
              "The voter list is frozen once voting opens. Only the closing time can change.",
            );
          }
          checkSchedule(null, closesAt, now);
        } else if (election.phase === "nominating") {
          checkSchedule(opensAt, closesAt, now);
        } else {
          badRequest("This election is over; its schedule is fixed.");
        }

        const [updated] = await tx
          .update(elections)
          .set({ opensAt, closesAt, minCheckIns })
          .where(eq(elections.id, election.id))
          .returning({
            id: elections.id,
            opensAt: elections.opensAt,
            closesAt: elections.closesAt,
            minCheckIns: elections.minCheckIns,
          });
        const shape = (value: {
          opensAt: Date | null;
          closesAt: Date | null;
          minCheckIns: number;
        }) => ({
          opensAt: value.opensAt?.toISOString() ?? null,
          closesAt: value.closesAt?.toISOString() ?? null,
          minCheckIns: value.minCheckIns,
        });
        await recordAudit(tx, {
          actorId: ctx.session.user.id,
          action: "election.configure",
          targetType: "election",
          targetId: election.id,
          targetLabel: election.title,
          before: shape(election),
          after: shape(updated!),
        });
        return updated!;
      });
    }),

  /** Positions can be added, renamed and removed only while nominating. */
  addPosition: adminProcedure
    .input(z.object({ electionId: z.string().min(1), title: positionTitle }))
    .mutation(async ({ ctx, input }) =>
      whileNominating(
        ctx.db,
        input.electionId,
        "Positions are locked once voting opens.",
        async (tx, election) => {
          const [{ top } = { top: null }] = await tx
            .select({ top: max(electionPositions.sortOrder) })
            .from(electionPositions)
            .where(eq(electionPositions.electionId, input.electionId));
          const [{ n } = { n: 0 }] = await tx
            .select({ n: count() })
            .from(electionPositions)
            .where(eq(electionPositions.electionId, input.electionId));
          if (n >= 20) badRequest("An election has at most 20 positions.");
          const [created] = await tx
            .insert(electionPositions)
            .values({
              electionId: input.electionId,
              title: input.title,
              sortOrder: (top ?? -1) + 1,
            })
            .returning({
              id: electionPositions.id,
              title: electionPositions.title,
            });
          await recordAudit(tx, {
            actorId: ctx.session.user.id,
            action: "election.edit_positions",
            targetType: "election",
            targetId: input.electionId,
            targetLabel: election.title,
            after: { added: input.title },
          });
          return created!;
        },
      ),
    ),

  renamePosition: adminProcedure
    .input(z.object({ positionId: z.string().min(1), title: positionTitle }))
    .mutation(async ({ ctx, input }) => {
      const position = await positionWithElection(ctx.db, input.positionId);
      return whileNominating(
        ctx.db,
        position.electionId,
        "Positions are locked once voting opens.",
        async (tx, election) => {
          const [before] = await tx
            .select({ title: electionPositions.title })
            .from(electionPositions)
            .where(eq(electionPositions.id, input.positionId));
          await tx
            .update(electionPositions)
            .set({ title: input.title })
            .where(eq(electionPositions.id, input.positionId));
          await recordAudit(tx, {
            actorId: ctx.session.user.id,
            action: "election.edit_positions",
            targetType: "election",
            targetId: position.electionId,
            targetLabel: election.title,
            before: { renamed: before?.title ?? null },
            after: { renamed: input.title },
          });
          return { id: input.positionId, title: input.title };
        },
      );
    }),

  removePosition: adminProcedure
    .input(z.object({ positionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const position = await positionWithElection(ctx.db, input.positionId);
      return whileNominating(
        ctx.db,
        position.electionId,
        "Positions are locked once voting opens.",
        async (tx, election) => {
          const [{ n } = { n: 0 }] = await tx
            .select({ n: count() })
            .from(electionPositions)
            .where(eq(electionPositions.electionId, position.electionId));
          if (n <= 1) badRequest("An election needs at least one position.");
          const [removed] = await tx
            .delete(electionPositions)
            .where(eq(electionPositions.id, input.positionId))
            .returning({ title: electionPositions.title });
          await recordAudit(tx, {
            actorId: ctx.session.user.id,
            action: "election.edit_positions",
            targetType: "election",
            targetId: position.electionId,
            targetLabel: election.title,
            before: { removed: removed?.title ?? null },
          });
          return { id: input.positionId };
        },
      );
    }),

  /** The ballot is fixed once voting opens, so review happens while nominating. */
  setCandidateStatus: adminProcedure
    .input(
      z.object({
        candidateId: z.string().min(1),
        status: z.enum(["pending", "approved", "rejected"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [candidate] = await ctx.db
        .select({ positionId: electionCandidates.positionId })
        .from(electionCandidates)
        .where(eq(electionCandidates.id, input.candidateId));
      if (!candidate) notFound("Candidate");
      const position = await positionWithElection(ctx.db, candidate.positionId);
      return whileNominating(
        ctx.db,
        position.electionId,
        "The ballot is locked once voting opens.",
        async (tx, election) => {
          const [before] = await tx
            .select({
              status: electionCandidates.status,
              name: users.name,
              email: users.email,
            })
            .from(electionCandidates)
            .innerJoin(users, eq(users.id, electionCandidates.userId))
            .where(eq(electionCandidates.id, input.candidateId));
          const [updated] = await tx
            .update(electionCandidates)
            .set({ status: input.status })
            .where(eq(electionCandidates.id, input.candidateId))
            .returning({
              id: electionCandidates.id,
              status: electionCandidates.status,
            });
          await recordAudit(tx, {
            actorId: ctx.session.user.id,
            action: "election.review_candidate",
            targetType: "election",
            targetId: position.electionId,
            targetLabel: election.title,
            before: { status: before?.status ?? null },
            after: {
              status: input.status,
              candidate: before?.name ?? before?.email ?? null,
            },
          });
          return updated;
        },
      );
    }),

  setPhase: adminProcedure
    .input(
      z.object({
        electionId: z.string().min(1),
        phase: z.enum(ELECTION_PHASES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await advanceElection(ctx.db, {
        electionId: input.electionId,
        to: input.phase,
        actorId: ctx.session.user.id,
      });
      // Not scheduled, so it always changes or throws.
      if (!result.changed) badRequest(result.reason);
      return { id: result.id, phase: result.phase, notice: result.notice };
    }),

  /**
   * The tally as spreadsheet rows, once voting is closed. Counts only: there
   * is no voter anywhere in it. Logged before it is handed over.
   */
  exportTally: adminProcedure
    .input(z.object({ electionId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      await assertRateLimit(
        ctx.db,
        `export-tally:${ctx.session.user.id}`,
        EXPORT_ROSTER_LIMIT,
      );
      const { election, rows } = await tallyRows(ctx.db, input.electionId);
      await recordAudit(ctx.db, {
        actorId: ctx.session.user.id,
        action: "export.election_tally",
        targetType: "election",
        targetId: election.id,
        targetLabel: election.title,
        after: { rows: rows.length - 1, truncated: false },
      });
      return { title: election.title, year: election.year, rows };
    }),

  delete: adminProcedure
    .input(z.object({ electionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const election = await loadElection(ctx.db, input.electionId);
      if (election.phase !== "nominating") {
        badRequest("Only an election still taking nominations can be deleted.");
      }
      await ctx.db.transaction(async (tx) => {
        await tx.delete(elections).where(eq(elections.id, election.id));
        await recordAudit(tx, {
          actorId: ctx.session.user.id,
          action: "election.delete",
          targetType: "election",
          targetId: election.id,
          targetLabel: election.title,
        });
      });
      return { id: election.id };
    }),
});
