import { and, asc, count, desc, eq } from "drizzle-orm";

import {
  boardPhotos,
  electionBallots,
  electionCandidates,
  electionPositions,
  elections,
  users,
  type db as Db,
} from "@buzz/db";

export type BoardSeat = {
  role: string;
  name?: string;
  /** Who holds the seat; read on the server only, never sent to a browser. */
  userId?: string;
  /** The stored headshot's etag, when the member uploaded one. */
  photoVersion?: string;
};

/**
 * The board as the latest published election decided it: for each position,
 * the approved candidate with the most ballots (everyone tied at the top
 * shares the seat), with their name and profile photo. A position nobody voted
 * in is an open seat. Null when no election has been published.
 */
export async function boardFromResults(
  db: typeof Db,
): Promise<BoardSeat[] | null> {
  const [latest] = await db
    .select({ id: elections.id })
    .from(elections)
    .where(eq(elections.phase, "published"))
    .orderBy(desc(elections.year), desc(elections.createdAt))
    .limit(1);
  if (!latest) return null;

  const [positions, results] = await Promise.all([
    db
      .select({ id: electionPositions.id, title: electionPositions.title })
      .from(electionPositions)
      .where(eq(electionPositions.electionId, latest.id))
      .orderBy(asc(electionPositions.sortOrder)),
    db
      .select({
        positionId: electionCandidates.positionId,
        userId: users.id,
        name: users.name,
        photoVersion: boardPhotos.etag,
        votes: count(electionBallots.id),
      })
      .from(electionCandidates)
      .innerJoin(
        electionPositions,
        eq(electionPositions.id, electionCandidates.positionId),
      )
      .innerJoin(users, eq(users.id, electionCandidates.userId))
      .leftJoin(
        electionBallots,
        eq(electionBallots.candidateId, electionCandidates.id),
      )
      .leftJoin(boardPhotos, eq(boardPhotos.userId, users.id))
      .where(
        and(
          eq(electionPositions.electionId, latest.id),
          eq(electionCandidates.status, "approved"),
        ),
      )
      .groupBy(electionCandidates.id, users.id, boardPhotos.etag)
      .orderBy(asc(users.name)),
  ]);

  const seats: BoardSeat[] = [];
  for (const position of positions) {
    const here = results.filter((row) => row.positionId === position.id);
    const top = Math.max(0, ...here.map((row) => row.votes));
    const winners = top > 0 ? here.filter((row) => row.votes === top) : [];
    if (winners.length === 0) {
      seats.push({ role: position.title });
      continue;
    }
    for (const winner of winners) {
      seats.push({
        role: position.title,
        name: winner.name ?? "Officer",
        userId: winner.userId,
        photoVersion: winner.photoVersion ?? undefined,
      });
    }
  }
  return seats;
}
