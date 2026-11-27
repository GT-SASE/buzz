import { eq } from "drizzle-orm";
import { z } from "zod";

import { recordAudit } from "../audit";
import { boardFromResults, type BoardSeat } from "../board";
import { notFound } from "../errors";
import { headshotUrl } from "../headshot";
import { isUndefinedTable } from "../pg-errors";
import { adminProcedure, createTRPCRouter, protectedProcedure } from "../trpc";
import { boardPhotos, users, type db as Db } from "@buzz/db";

/** The seats of the latest published election; none before migration 0017 has run. */
async function currentSeats(db: typeof Db): Promise<BoardSeat[]> {
  try {
    return (await boardFromResults(db)) ?? [];
  } catch (error) {
    if (isUndefinedTable(error)) return [];
    throw error;
  }
}

/**
 * Headshots for the public board. A member uploads their own from settings
 * (through the upload route, which resizes it), and only while they hold a
 * seat on the current board. Officers can take one down.
 */
export const headshotRouter = createTRPCRouter({
  /** The caller's seat, if they hold one, and whether they have a photo. */
  mine: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const seats = (await currentSeats(ctx.db)).filter(
      (seat) => seat.userId === userId,
    );
    const [first] = seats;
    if (!first) return { roles: [] as string[], photo: null };
    return {
      roles: seats.map((seat) => seat.role),
      photo: first.photoVersion
        ? headshotUrl(userId, first.photoVersion)
        : null,
    };
  }),

  /** Everyone on the current board, for the officer's takedown list. */
  seats: adminProcedure.query(async ({ ctx }) => {
    const seats = await currentSeats(ctx.db);
    return seats
      .filter((seat) => seat.userId)
      .map((seat) => ({
        userId: seat.userId!,
        name: seat.name ?? "Officer",
        role: seat.role,
        hasPhoto: seat.photoVersion !== undefined,
      }));
  }),

  /** An officer takes a member's photo down. Logged. */
  remove: adminProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const [member] = await tx
          .select({ email: users.email, name: users.name })
          .from(users)
          .where(eq(users.id, input.userId));
        const removed = await tx
          .delete(boardPhotos)
          .where(eq(boardPhotos.userId, input.userId))
          .returning({ userId: boardPhotos.userId });
        if (removed.length === 0) notFound("Headshot");
        await recordAudit(tx, {
          actorId: ctx.session.user.id,
          action: "board.remove_photo",
          targetType: "member",
          targetId: input.userId,
          targetLabel: member?.email ?? null,
          before: { photo: true },
        });
        return { userId: input.userId };
      });
    }),
});
