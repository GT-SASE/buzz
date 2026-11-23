import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  lt,
  or,
  sql,
  sum,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { asInt } from "../aggregates";
import { adminProcedure, createTRPCRouter } from "../trpc";
import { escapeLikePattern } from "./member";
import {
  AUDIT_ACTIONS,
  auditLog,
  POINTS_SOURCES,
  pointsLedger,
  users,
} from "@buzz/db";

/** `from` is the first instant included, `to` the first one left out. */
const paging = {
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
};

/**
 * The officer page's two lists. Both are read-only: the rows are written by
 * the mutations they describe, in the same transaction, and nothing here can
 * add, edit or remove one.
 */
export const auditRouter = createTRPCRouter({
  /** Newest first. */
  log: adminProcedure
    .input(
      z.object({
        actorId: z.string().min(1).max(255).optional(),
        action: z.enum(AUDIT_ACTIONS).optional(),
        ...paging,
      }),
    )
    .query(async ({ ctx, input }) => {
      const actor = alias(users, "actor");
      const target = alias(users, "target");

      const where = and(
        input.actorId ? eq(auditLog.actorId, input.actorId) : undefined,
        input.action ? eq(auditLog.action, input.action) : undefined,
        input.from ? gte(auditLog.at, input.from) : undefined,
        input.to ? lt(auditLog.at, input.to) : undefined,
      );

      const [rows, [totals]] = await Promise.all([
        ctx.db
          .select({
            id: auditLog.id,
            at: auditLog.at,
            action: auditLog.action,
            actorId: auditLog.actorId,
            actorName: actor.name,
            actorEmail: actor.email,
            targetType: auditLog.targetType,
            targetId: auditLog.targetId,
            targetLabel: auditLog.targetLabel,
            targetName: target.name,
            targetEmail: target.email,
            before: auditLog.before,
            after: auditLog.after,
          })
          .from(auditLog)
          .leftJoin(actor, eq(actor.id, auditLog.actorId))
          // A member target is shown by their name today; the stored label is
          // what the row falls back to once the account is gone.
          .leftJoin(
            target,
            and(
              eq(auditLog.targetType, "member"),
              eq(target.id, auditLog.targetId),
            ),
          )
          .where(where)
          .orderBy(desc(auditLog.at), desc(auditLog.id))
          .limit(input.limit)
          .offset(input.offset),
        ctx.db.select({ total: count() }).from(auditLog).where(where),
      ]);

      return { rows, total: asInt(totals?.total) };
    }),

  /** Everyone who appears in the log, for the actor filter. */
  actors: adminProcedure.query(async ({ ctx }) => {
    const actor = alias(users, "actor");
    return ctx.db
      .select({
        id: auditLog.actorId,
        name: actor.name,
        email: actor.email,
      })
      .from(auditLog)
      .leftJoin(actor, eq(actor.id, auditLog.actorId))
      .groupBy(auditLog.actorId, actor.name, actor.email)
      .orderBy(
        sql`lower(coalesce(${actor.name}, ${actor.email}, ${auditLog.actorId}))`,
      )
      .limit(200);
  }),

  /** Newest first. `net` is the sum of every row the filters match, not of the page. */
  ledger: adminProcedure
    .input(
      z.object({
        search: z.string().trim().max(100).optional(),
        source: z.enum(POINTS_SOURCES).optional(),
        ...paging,
      }),
    )
    .query(async ({ ctx, input }) => {
      const actor = alias(users, "actor");

      const pattern = input.search
        ? `%${escapeLikePattern(input.search)}%`
        : undefined;
      const where: SQL | undefined = and(
        pattern
          ? or(ilike(users.name, pattern), ilike(users.email, pattern))
          : undefined,
        input.source ? eq(pointsLedger.source, input.source) : undefined,
        input.from ? gte(pointsLedger.at, input.from) : undefined,
        input.to ? lt(pointsLedger.at, input.to) : undefined,
      );

      const [rows, [totals]] = await Promise.all([
        ctx.db
          .select({
            id: pointsLedger.id,
            at: pointsLedger.at,
            delta: pointsLedger.delta,
            reason: pointsLedger.reason,
            source: pointsLedger.source,
            eventId: pointsLedger.eventId,
            userId: users.id,
            name: users.name,
            email: users.email,
            actorName: actor.name,
            actorEmail: actor.email,
          })
          .from(pointsLedger)
          .innerJoin(users, eq(users.id, pointsLedger.userId))
          .leftJoin(actor, eq(actor.id, pointsLedger.actedByUserId))
          .where(where)
          .orderBy(desc(pointsLedger.at), desc(pointsLedger.id))
          .limit(input.limit)
          .offset(input.offset),
        ctx.db
          .select({ total: count(), net: sum(pointsLedger.delta) })
          .from(pointsLedger)
          .innerJoin(users, eq(users.id, pointsLedger.userId))
          .where(where),
      ]);

      return { rows, total: asInt(totals?.total), net: asInt(totals?.net) };
    }),
});
