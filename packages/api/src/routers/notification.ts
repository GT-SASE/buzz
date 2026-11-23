import { eq } from "drizzle-orm";
import { z } from "zod";

import { isUndefinedTable } from "../pg-errors";
import { assertRateLimit, NOTIFICATION_PREFS_LIMIT } from "../rate-limit";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { notificationPreferences } from "@buzz/db";

/** What a member who never opened the settings page gets: everything on. */
const defaults = { eventEmails: true, electionEmails: true } as const;

export const notificationRouter = createTRPCRouter({
  /**
   * The caller's switches. Application decisions are not among them: they
   * answer something the member did and are always sent.
   */
  mine: protectedProcedure.query(async ({ ctx }) => {
    try {
      const row = await ctx.db.query.notificationPreferences.findFirst({
        where: eq(notificationPreferences.userId, ctx.session.user.id),
        columns: { eventEmails: true, electionEmails: true },
      });
      return row ?? defaults;
    } catch (error) {
      if (isUndefinedTable(error)) return defaults;
      throw error;
    }
  }),

  save: protectedProcedure
    .input(
      z.object({
        eventEmails: z.boolean(),
        electionEmails: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertRateLimit(
        ctx.db,
        `notification-prefs:${ctx.session.user.id}`,
        NOTIFICATION_PREFS_LIMIT,
      );
      const values = { ...input, updatedAt: new Date() };
      await ctx.db
        .insert(notificationPreferences)
        .values({ userId: ctx.session.user.id, ...values })
        .onConflictDoUpdate({
          target: notificationPreferences.userId,
          set: values,
        });
      return input;
    }),
});
