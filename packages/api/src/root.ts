import { chapterRouter } from "./routers/chapter";
import { committeeRouter } from "./routers/committee";
import { eventRouter } from "./routers/event";
import { memberRouter } from "./routers/member";
import { mentorshipRouter } from "./routers/mentorship";
import { createCallerFactory, createTRPCRouter } from "./trpc";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  chapter: chapterRouter,
  committee: committeeRouter,
  event: eventRouter,
  member: memberRouter,
  mentorship: mentorshipRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the tRPC API.
 * @example
 * const trpc = createCaller(createContext);
 * const res = await trpc.event.myStats();
 */
export const createCaller = createCallerFactory(appRouter);
