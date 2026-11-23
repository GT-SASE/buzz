import { announcementRouter } from "./routers/announcement";
import { auditRouter } from "./routers/audit";
import { chapterRouter } from "./routers/chapter";
import { electionRouter } from "./routers/election";
import { committeeRouter } from "./routers/committee";
import { eventRouter } from "./routers/event";
import { memberRouter } from "./routers/member";
import { mentorshipRouter } from "./routers/mentorship";
import { notificationRouter } from "./routers/notification";
import { pageRouter } from "./routers/page";
import { resumeRouter } from "./routers/resume";
import { createCallerFactory, createTRPCRouter } from "./trpc";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  announcement: announcementRouter,
  audit: auditRouter,
  chapter: chapterRouter,
  committee: committeeRouter,
  election: electionRouter,
  event: eventRouter,
  member: memberRouter,
  mentorship: mentorshipRouter,
  notification: notificationRouter,
  page: pageRouter,
  resume: resumeRouter,
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
