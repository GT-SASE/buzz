/** What Vercel runs: the functions and the crons that call them. */

export const MAX_DURATION_SECONDS = 60;

/** Each function's route, and the file that serves it. */
export const FUNCTIONS = [
  { route: "api/interactions", source: "api/interactions.ts" },
  { route: "api/cron/reminders", source: "api/cron/reminders.ts" },
];

export const CRONS = [
  { path: "/api/cron/reminders", schedule: "0 15 * * *" },
  { path: "/api/cron/reminders", schedule: "0 17 * * *" },
];
