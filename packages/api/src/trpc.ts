import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";

import { auth } from "@buzz/auth";
import { db, isOfficerRole } from "@buzz/db";

export type Defer = (task: () => Promise<unknown>) => void;

export const createTRPCContext = async (opts: {
  headers: Headers;
  /**
   * Runs work after the response has gone out (Next's `after`). Absent in
   * tests and scripts, where the work is awaited in place.
   */
  defer?: Defer;
}) => {
  const session = await auth();

  return {
    db,
    session,
    ...opts,
  };
};

// ZodErrors are flattened into the error shape so the client can type them.
const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createCallerFactory = t.createCallerFactory;

export const createTRPCRouter = t.router;

/**
 * Logs procedure time in development. No extra wait — that was hiding how
 * slow a real round-trip felt and making every portal screen lag locally.
 */
const timingMiddleware = t.middleware(async ({ next, path }) => {
  const start = Date.now();
  const result = await next();

  if (t._config.isDev) {
    console.log(`[TRPC] ${path} took ${Date.now() - start}ms to execute`);
  }

  return result;
});

/** Signed-in members only: guarantees `ctx.session.user` is not null. */
export const protectedProcedure = t.procedure
  .use(timingMiddleware)
  .use(({ ctx, next }) => {
    if (!ctx.session?.user) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    return next({
      ctx: {
        // infers the `session` as non-nullable
        session: { ...ctx.session, user: ctx.session.user },
      },
    });
  });

/**
 * Officer (admin) procedure.
 *
 * This is the real gate on everything under /portal/admin. The route layout
 * also redirects non-officers, but that is a courtesy so nobody sees a flash of
 * an admin screen — it is not what keeps a member out of these procedures.
 *
 * The role rides on the database session, so no extra round trip is needed and
 * a demotion takes effect on the caller's very next request.
 */
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!isOfficerRole(ctx.session.user.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Officer access required.",
    });
  }
  return next({ ctx });
});

/**
 * Super admin procedure.
 *
 * Role changes go through here. An officer (`ADMIN`) keeps every other admin
 * power via `adminProcedure`, and cannot promote, demote, or edit a super
 * admin. The check is the procedure, not the screen that calls it.
 */
export const superAdminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.session.user.role !== "SUPER_ADMIN") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Super admin access required.",
    });
  }
  return next({ ctx });
});
