import { TRPCError } from "@trpc/server";
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
} from "drizzle-orm";
import { z } from "zod";

import { notFound } from "../errors";
import { schoolYearStart } from "../periods";
import { isUniqueViolation } from "../pg-errors";
import { assertRateLimit, ELECTION_ACTION_LIMIT } from "../rate-limit";
import { schoolYear, schoolYearPattern } from "../terms";
import { adminProcedure, createTRPCRouter, protectedProcedure } from "../trpc";
import {
  electionCandidates,
  electionPositions,
  elections,
  electionVotes,
  eventCheckIns,
  users,
  type db as Db,
  type ElectionPhase,
} from "@buzz/db";

type Database = typeof Db;

const phases = ["nominating", "voting", "closed", "published"] as const;

/** Forward one step, or voting back to nominating while nobody has voted. */
const nextPhase: Record<ElectionPhase, ElectionPhase | null> = {
  nominating: "voting",
  voting: "closed",
  closed: "published",
  published: null,
};

function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

async function eligibility(db: Database, userId: string, now: Date) {
  const [row] = await db
    .select({ n: count() })
    .from(eventCheckIns)
    .where(
      and(
        eq(eventCheckIns.userId, userId),
        gte(eventCheckIns.checkedInAt, schoolYearStart(now)),
      ),
    );
  return (row?.n ?? 0) > 0;
}

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

async function tally(db: Database, positionIds: string[]) {
  if (positionIds.length === 0) return new Map<string, number>();
  const rows = await db
    .select({ candidateId: electionVotes.candidateId, votes: count() })
    .from(electionVotes)
    .where(inArray(electionVotes.positionId, positionIds))
    .groupBy(electionVotes.candidateId);
  return new Map(rows.map((row) => [row.candidateId, row.votes]));
}

async function electionTree(db: Database, electionIds: string[]) {
  if (electionIds.length === 0) return { positions: [], candidates: [] };
  const positions = await db
    .select()
    .from(electionPositions)
    .where(inArray(electionPositions.electionId, electionIds))
    .orderBy(asc(electionPositions.sortOrder));
  const positionIds = positions.map((position) => position.id);
  const candidates =
    positionIds.length === 0
      ? []
      : await db
          .select({
            id: electionCandidates.id,
            positionId: electionCandidates.positionId,
            userId: electionCandidates.userId,
            statement: electionCandidates.statement,
            status: electionCandidates.status,
            createdAt: electionCandidates.createdAt,
            name: users.name,
            email: users.email,
          })
          .from(electionCandidates)
          .innerJoin(users, eq(users.id, electionCandidates.userId))
          .where(inArray(electionCandidates.positionId, positionIds))
          .orderBy(asc(users.name));
  return { positions, candidates };
}

const yearInput = z
  .object({ year: z.string().regex(schoolYearPattern).optional() })
  .nullish();

export const electionRouter = createTRPCRouter({
  /**
   * This school year's elections as a member sees them. Approved candidates
   * only, the caller's own candidacies and ballots, and counts only once an
   * officer has published.
   */
  current: protectedProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const userId = ctx.session.user.id;
    const year = schoolYear(now);

    const rows = await ctx.db
      .select()
      .from(elections)
      .where(eq(elections.year, year))
      .orderBy(desc(elections.createdAt));
    const { positions, candidates } = await electionTree(
      ctx.db,
      rows.map((row) => row.id),
    );
    const positionIds = positions.map((position) => position.id);

    const [myVotes, eligible, counts] = await Promise.all([
      positionIds.length === 0
        ? []
        : ctx.db
            .select({
              positionId: electionVotes.positionId,
              candidateId: electionVotes.candidateId,
            })
            .from(electionVotes)
            .where(
              and(
                eq(electionVotes.voterId, userId),
                inArray(electionVotes.positionId, positionIds),
              ),
            ),
      eligibility(ctx.db, userId, now),
      tally(
        ctx.db,
        positions
          .filter(
            (position) =>
              rows.find((row) => row.id === position.electionId)?.phase ===
              "published",
          )
          .map((position) => position.id),
      ),
    ]);

    return {
      year,
      eligible,
      elections: rows.map((election) => ({
        id: election.id,
        title: election.title,
        phase: election.phase,
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
              myVote:
                myVotes.find((vote) => vote.positionId === position.id)
                  ?.candidateId ?? null,
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
      assertRateLimit(`election:${ctx.session.user.id}`, ELECTION_ACTION_LIMIT);
      const position = await positionWithElection(ctx.db, input.positionId);
      if (position.phase !== "nominating") {
        badRequest("Nominations are closed for this election.");
      }
      try {
        const [created] = await ctx.db
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
      assertRateLimit(`election:${ctx.session.user.id}`, ELECTION_ACTION_LIMIT);
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
      if (position.phase !== "nominating") {
        badRequest("Nominations are closed. Ask an officer.");
      }
      await ctx.db
        .delete(electionCandidates)
        .where(eq(electionCandidates.id, candidate.id));
      return { id: candidate.id };
    }),

  /** One ballot per position, final once cast. Returns no tally. */
  vote: protectedProcedure
    .input(
      z.object({
        positionId: z.string().min(1),
        candidateId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertRateLimit(`election:${ctx.session.user.id}`, ELECTION_ACTION_LIMIT);
      const now = new Date();
      const position = await positionWithElection(ctx.db, input.positionId);
      if (position.phase !== "voting") {
        badRequest("Voting is not open for this election.");
      }
      if (!(await eligibility(ctx.db, ctx.session.user.id, now))) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Voting needs at least one event check-in this school year.",
        });
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
        await ctx.db.insert(electionVotes).values({
          positionId: input.positionId,
          voterId: ctx.session.user.id,
          candidateId: input.candidateId,
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
    const rows = await ctx.db
      .select()
      .from(elections)
      .where(eq(elections.year, year))
      .orderBy(desc(elections.createdAt));
    const { positions, candidates } = await electionTree(
      ctx.db,
      rows.map((row) => row.id),
    );
    const positionIds = positions.map((position) => position.id);

    const [turnout, counts] = await Promise.all([
      positionIds.length === 0
        ? []
        : ctx.db
            .select({
              positionId: electionVotes.positionId,
              voters: countDistinct(electionVotes.voterId),
            })
            .from(electionVotes)
            .where(inArray(electionVotes.positionId, positionIds))
            .groupBy(electionVotes.positionId),
      tally(
        ctx.db,
        positions
          .filter((position) => {
            const phase = rows.find(
              (row) => row.id === position.electionId,
            )?.phase;
            return phase === "closed" || phase === "published";
          })
          .map((position) => position.id),
      ),
    ]);

    return rows.map((election) => {
      const showCounts =
        election.phase === "closed" || election.phase === "published";
      return {
        id: election.id,
        year: election.year,
        title: election.title,
        phase: election.phase,
        positions: positions
          .filter((position) => position.electionId === election.id)
          .map((position) => ({
            id: position.id,
            title: position.title,
            voters:
              turnout.find((row) => row.positionId === position.id)?.voters ??
              0,
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
        positions: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(elections)
          .values({
            year: schoolYear(new Date()),
            title: input.title,
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
        return created;
      });
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
      if (position.phase !== "nominating") {
        badRequest("The ballot is locked once voting opens.");
      }
      const [updated] = await ctx.db
        .update(electionCandidates)
        .set({ status: input.status })
        .where(eq(electionCandidates.id, input.candidateId))
        .returning({
          id: electionCandidates.id,
          status: electionCandidates.status,
        });
      return updated;
    }),

  setPhase: adminProcedure
    .input(
      z.object({
        electionId: z.string().min(1),
        phase: z.enum(phases),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const election = await loadElection(ctx.db, input.electionId);
      const forward = nextPhase[election.phase] === input.phase;
      const back = election.phase === "voting" && input.phase === "nominating";
      if (!forward && !back) {
        badRequest(
          `An election cannot go from ${election.phase} to ${input.phase}.`,
        );
      }

      if (back) {
        const [cast] = await ctx.db
          .select({ n: count() })
          .from(electionVotes)
          .innerJoin(
            electionPositions,
            eq(electionPositions.id, electionVotes.positionId),
          )
          .where(eq(electionPositions.electionId, election.id));
        if ((cast?.n ?? 0) > 0) {
          badRequest(
            "Votes have been cast, so voting cannot be reopened for nominations.",
          );
        }
      }

      if (input.phase === "voting") {
        const [approved] = await ctx.db
          .select({ n: count() })
          .from(electionCandidates)
          .innerJoin(
            electionPositions,
            eq(electionPositions.id, electionCandidates.positionId),
          )
          .where(
            and(
              eq(electionPositions.electionId, election.id),
              eq(electionCandidates.status, "approved"),
            ),
          );
        if ((approved?.n ?? 0) === 0) {
          badRequest("Approve at least one candidate before opening voting.");
        }
      }

      const [updated] = await ctx.db
        .update(elections)
        .set({ phase: input.phase })
        .where(eq(elections.id, election.id))
        .returning({ id: elections.id, phase: elections.phase });
      return updated;
    }),

  delete: adminProcedure
    .input(z.object({ electionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const election = await loadElection(ctx.db, input.electionId);
      if (election.phase !== "nominating") {
        badRequest("Only an election still taking nominations can be deleted.");
      }
      await ctx.db.delete(elections).where(eq(elections.id, election.id));
      return { id: election.id };
    }),
});
