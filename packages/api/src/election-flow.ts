import { TRPCError } from "@trpc/server";
import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

import { recordAudit } from "./audit";
import { notFound } from "./errors";
import {
  noNotice,
  notifyElectionPhase,
  type Notice,
  type Recipient,
} from "./notify";
import { schoolYearWindow } from "./periods";
import {
  electionBallots,
  electionCandidates,
  electionPositions,
  electionRoll,
  elections,
  electionVoters,
  eventCheckIns,
  events,
  users,
  type db as Db,
  type ElectionPhase,
} from "@buzz/db";

export type Database = typeof Db;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Who the audit log names for a flip no officer clicked. */
export const CRON_ACTOR = "system:cron";

export const ELECTION_PHASES = [
  "nominating",
  "voting",
  "closed",
  "published",
] as const;

/** Forward one step, or voting back to nominating while nobody has voted. */
const nextPhase: Record<ElectionPhase, ElectionPhase | null> = {
  nominating: "voting",
  voting: "closed",
  closed: "published",
  published: null,
};

export function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

/**
 * Members who meet an election's rule right now: at least `min` counted
 * check-ins (events not archived) in the school year `now` falls in. This is
 * both what the voter list is frozen from and what a member sees before it is.
 */
function qualifying(db: Database | Tx, now: Date, min: number) {
  const { from, to } = schoolYearWindow(now);
  return db
    .select({ userId: eventCheckIns.userId })
    .from(eventCheckIns)
    .innerJoin(events, eq(events.id, eventCheckIns.eventId))
    .where(
      and(
        gte(eventCheckIns.checkedInAt, from),
        lt(eventCheckIns.checkedInAt, to),
        isNull(events.archivedAt),
      ),
    )
    .groupBy(eventCheckIns.userId)
    .having(gte(count(), min));
}

/** Counted check-ins this school year, the number an election's rule is measured against. */
export async function checkInsThisYear(
  db: Database,
  userId: string,
  now: Date,
) {
  const { from, to } = schoolYearWindow(now);
  const [row] = await db
    .select({ n: count() })
    .from(eventCheckIns)
    .innerJoin(events, eq(events.id, eventCheckIns.eventId))
    .where(
      and(
        eq(eventCheckIns.userId, userId),
        gte(eventCheckIns.checkedInAt, from),
        lt(eventCheckIns.checkedInAt, to),
        isNull(events.archivedAt),
      ),
    );
  return row?.n ?? 0;
}

/** Who an announcement goes to: the frozen list once there is one, else the live rule. */
export async function electionRecipients(
  db: Database,
  election: { id: string; minCheckIns: number; rollFrozenAt: Date | null },
  now: Date,
): Promise<Recipient[]> {
  if (election.rollFrozenAt) {
    return db
      .select({ id: users.id, email: users.email })
      .from(electionRoll)
      .innerJoin(users, eq(users.id, electionRoll.userId))
      .where(eq(electionRoll.electionId, election.id));
  }
  const rule = qualifying(db, now, election.minCheckIns).as("rule");
  return db
    .select({ id: users.id, email: users.email })
    .from(rule)
    .innerJoin(users, eq(users.id, rule.userId));
}

async function freezeRoll(tx: Tx, electionId: string, min: number, now: Date) {
  const rows = await qualifying(tx, now, min);
  for (let i = 0; i < rows.length; i += 1000) {
    await tx
      .insert(electionRoll)
      .values(
        rows
          .slice(i, i + 1000)
          .map((row) => ({ electionId, userId: row.userId })),
      )
      .onConflictDoNothing();
  }
  return rows.length;
}

/**
 * Rewrites an election's ballots in random order under new random ids. While
 * voting, a ballot and its voter were written in one transaction, so a reader
 * of the database could pair them by `xmin` or physical order. After this
 * every ballot shares one `xmin` and the order says nothing. The caller holds
 * the election row FOR UPDATE, so no ballot can be cast meanwhile.
 */
async function shuffleBallots(tx: Tx, electionId: string) {
  await tx.execute(sql`
    with moved as (
      delete from ${electionBallots}
      where ${electionBallots.positionId} in (
        select ${electionPositions.id} from ${electionPositions}
        where ${electionPositions.electionId} = ${electionId}
      )
      returning ${electionBallots.positionId} as "positionId",
                ${electionBallots.candidateId} as "candidateId"
    )
    insert into ${electionBallots} (id, "positionId", "candidateId")
    select gen_random_uuid()::text, "positionId", "candidateId"
    from moved
    order by random()
  `);
}

export type AdvanceOptions = {
  electionId: string;
  to: ElectionPhase;
  /** The officer, or null for the cron. */
  actorId: string | null;
  /** Cron flips only act when the schedule says they are due. */
  scheduled?: boolean;
  now?: Date;
  /**
   * Send the notice after the response instead of awaiting it, so the
   * member's request that happened to trigger a flip never waits on mail.
   */
  defer?: (task: () => Promise<unknown>) => void;
};

export type AdvanceResult =
  | { changed: true; id: string; phase: ElectionPhase; notice: Notice }
  | { changed: false; reason: string };

/**
 * The one way a phase changes, for the officer's button and the cron alike.
 * The election row is locked FOR UPDATE, so a ballot (FOR SHARE) either lands
 * before the flip or sees the new phase. Opening voting freezes the voter
 * list in the same transaction. The audit row commits with the change; the
 * notice goes out after, so a failed send never undoes a flip.
 */
export async function advanceElection(
  db: Database,
  options: AdvanceOptions,
): Promise<AdvanceResult> {
  const now = options.now ?? new Date();
  const outcome = await db.transaction(async (tx) => {
    const [election] = await tx
      .select()
      .from(elections)
      .where(eq(elections.id, options.electionId))
      .for("update");
    if (!election) notFound("Election");

    const forward = nextPhase[election.phase] === options.to;
    const back = election.phase === "voting" && options.to === "nominating";
    // Someone else (the cron, a manual flip, another request) got here first.
    if (options.scheduled && !forward) {
      return { changed: false as const, reason: "already moved" };
    }
    if (!forward && !back) {
      badRequest(
        `An election cannot go from ${election.phase} to ${options.to}.`,
      );
    }
    if (options.scheduled) {
      const dueAt =
        election.phase === "nominating"
          ? election.opensAt
          : election.phase === "voting"
            ? election.closesAt
            : null;
      const due = dueAt !== null && dueAt <= now;
      if (!due || back) {
        return { changed: false as const, reason: "not due" };
      }
    }

    if (back) {
      const [cast] = await tx
        .select({ n: count() })
        .from(electionVoters)
        .where(eq(electionVoters.electionId, election.id));
      if ((cast?.n ?? 0) > 0) {
        badRequest(
          "Votes have been cast, so voting cannot be reopened for nominations.",
        );
      }
    }

    let rollSize: number | null = null;
    if (options.to === "voting") {
      const [approved] = await tx
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
      rollSize = await freezeRoll(tx, election.id, election.minCheckIns, now);
    }
    if (back) {
      await tx
        .delete(electionRoll)
        .where(eq(electionRoll.electionId, election.id));
    }

    const [updated] = await tx
      .update(elections)
      .set({
        phase: options.to,
        ...(options.to === "voting" ? { rollFrozenAt: now } : {}),
        ...(back ? { rollFrozenAt: null } : {}),
      })
      .where(eq(elections.id, election.id))
      .returning();
    await recordAudit(tx, {
      actorId: options.actorId ?? CRON_ACTOR,
      action: "election.set_phase",
      targetType: "election",
      targetId: election.id,
      targetLabel: election.title,
      before: { phase: election.phase },
      after: {
        phase: options.to,
        ...(options.scheduled ? { scheduled: true } : {}),
        ...(rollSize === null ? {} : { voters: rollSize }),
      },
    });
    if (options.to === "closed") await shuffleBallots(tx, election.id);
    return {
      changed: true as const,
      updated: updated!,
      announce: forward,
    };
  });

  if (!outcome.changed) return outcome;
  // After the commit: a failed send never undoes the phase change.
  const send = () =>
    notifyElectionPhase(db, outcome.updated, options.to, () =>
      electionRecipients(db, outcome.updated, now),
    );
  let notice = noNotice;
  if (outcome.announce) {
    if (options.defer) options.defer(send);
    else notice = await send();
  }
  return {
    changed: true,
    id: outcome.updated.id,
    phase: outcome.updated.phase,
    notice,
  };
}

export type ScheduledRun = {
  flipped: { id: string; phase: ElectionPhase }[];
  skipped: { id: string; reason: string }[];
};

/**
 * What the cron does: every election whose open or close time has passed
 * moves one step, up to two (an outage can leave both times behind). An
 * election that cannot open, say with nobody approved, is skipped and tried
 * again on the next run.
 */
export async function runScheduledFlips(
  db: Database,
  now = new Date(),
  defer?: AdvanceOptions["defer"],
): Promise<ScheduledRun> {
  const due = await db
    .select({ id: elections.id })
    .from(elections)
    .where(
      or(
        and(eq(elections.phase, "nominating"), lte(elections.opensAt, now)),
        and(eq(elections.phase, "voting"), lte(elections.closesAt, now)),
      ),
    )
    .orderBy(asc(elections.createdAt));

  const run: ScheduledRun = { flipped: [], skipped: [] };
  for (const { id } of due) {
    for (let step = 0; step < 2; step++) {
      const [current] = await db
        .select({ phase: elections.phase })
        .from(elections)
        .where(eq(elections.id, id));
      const to = current ? nextPhase[current.phase] : null;
      if (to !== "voting" && to !== "closed") break;
      try {
        const result = await advanceElection(db, {
          electionId: id,
          to,
          actorId: null,
          scheduled: true,
          now,
          defer,
        });
        if (!result.changed) {
          if (step === 0) run.skipped.push({ id, reason: result.reason });
          break;
        }
        run.flipped.push({ id, phase: result.phase });
      } catch (error) {
        if (error instanceof TRPCError && error.code === "BAD_REQUEST") {
          run.skipped.push({ id, reason: error.message });
          break;
        }
        throw error;
      }
    }
  }
  return run;
}

/**
 * Ballots per candidate and per position across one year's elections, with no
 * phase filter: callers decide from the phase on the rows they display
 * whether to show counts.
 */
export async function yearTally(db: Database, year: string) {
  const rows = await db
    .select({
      positionId: electionBallots.positionId,
      candidateId: electionBallots.candidateId,
      votes: count(),
    })
    .from(electionBallots)
    .where(
      inArray(
        electionBallots.positionId,
        db
          .select({ id: electionPositions.id })
          .from(electionPositions)
          .innerJoin(elections, eq(elections.id, electionPositions.electionId))
          .where(eq(elections.year, year)),
      ),
    )
    .groupBy(electionBallots.positionId, electionBallots.candidateId);
  const perCandidate = new Map<string, number>();
  const perPosition = new Map<string, number>();
  for (const row of rows) {
    perCandidate.set(row.candidateId, row.votes);
    perPosition.set(
      row.positionId,
      (perPosition.get(row.positionId) ?? 0) + row.votes,
    );
  }
  return { perCandidate, perPosition };
}

export const tallyHeader = [
  "Election",
  "School year",
  "Position",
  "Candidate",
  "Email",
  "Votes",
  "Share of ballots",
] as const;

/**
 * The tally as rows for a spreadsheet: one per approved candidate, with the
 * votes and their share of that position's ballots, and a turnout row for
 * each position. Only counts, never a voter.
 */
export async function tallyRows(db: Database, electionId: string) {
  const [election] = await db
    .select()
    .from(elections)
    .where(eq(elections.id, electionId));
  if (!election) notFound("Election");
  if (election.phase !== "closed" && election.phase !== "published") {
    badRequest("The tally can be exported once voting is closed.");
  }

  const [positions, candidates, ballots, voters, [roll]] = await Promise.all([
    db
      .select()
      .from(electionPositions)
      .where(eq(electionPositions.electionId, electionId))
      .orderBy(asc(electionPositions.sortOrder)),
    db
      .select({
        id: electionCandidates.id,
        positionId: electionCandidates.positionId,
        name: users.name,
        email: users.email,
      })
      .from(electionCandidates)
      .innerJoin(
        electionPositions,
        eq(electionPositions.id, electionCandidates.positionId),
      )
      .innerJoin(users, eq(users.id, electionCandidates.userId))
      .where(
        and(
          eq(electionPositions.electionId, electionId),
          eq(electionCandidates.status, "approved"),
        ),
      )
      .orderBy(asc(users.name)),
    db
      .select({ candidateId: electionBallots.candidateId, votes: count() })
      .from(electionBallots)
      .innerJoin(
        electionPositions,
        eq(electionPositions.id, electionBallots.positionId),
      )
      .where(eq(electionPositions.electionId, electionId))
      .groupBy(electionBallots.candidateId),
    db
      .select({ positionId: electionVoters.positionId, voters: count() })
      .from(electionVoters)
      .where(eq(electionVoters.electionId, electionId))
      .groupBy(electionVoters.positionId),
    db
      .select({ n: count() })
      .from(electionRoll)
      .where(eq(electionRoll.electionId, electionId)),
  ]);

  const votes = new Map(ballots.map((row) => [row.candidateId, row.votes]));
  const turnout = new Map(voters.map((row) => [row.positionId, row.voters]));
  const rows: (string | number)[][] = [[...tallyHeader]];
  for (const position of positions) {
    const here = candidates.filter((c) => c.positionId === position.id);
    const total = here.reduce((sum, c) => sum + (votes.get(c.id) ?? 0), 0);
    for (const candidate of here) {
      const n = votes.get(candidate.id) ?? 0;
      rows.push([
        election.title,
        election.year,
        position.title,
        candidate.name ?? "",
        candidate.email,
        n,
        total === 0 ? "0%" : `${Math.round((n / total) * 1000) / 10}%`,
      ]);
    }
    rows.push([
      election.title,
      election.year,
      position.title,
      "Ballots cast",
      `of ${roll?.n ?? 0} eligible voters`,
      turnout.get(position.id) ?? 0,
      "",
    ]);
  }
  return { election, rows };
}
