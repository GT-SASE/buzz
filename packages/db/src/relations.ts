import { defineRelations } from "drizzle-orm";

import * as schema from "./schema";

/**
 * Relational Queries v2: every relation lives here, in one `defineRelations`
 * call, and `client.ts` hands it to `drizzle()`. Kept out of `schema.ts` so
 * drizzle-kit, which reads that file for tables, never loads it.
 *
 * `db.query.<table>` keys are the table export names in `schema.ts`.
 */
export const relations = defineRelations(schema, (r) => ({
  users: {
    accounts: r.many.accounts({
      from: r.users.id,
      to: r.accounts.userId,
    }),
    checkIns: r.many.eventCheckIns({
      from: r.users.id,
      to: r.eventCheckIns.userId,
    }),
  },
  accounts: {
    user: r.one.users({ from: r.accounts.userId, to: r.users.id }),
  },
  sessions: {
    user: r.one.users({ from: r.sessions.userId, to: r.users.id }),
  },
  events: {
    createdBy: r.one.users({ from: r.events.createdById, to: r.users.id }),
    checkIns: r.many.eventCheckIns({
      from: r.events.id,
      to: r.eventCheckIns.eventId,
    }),
  },
  eventCheckIns: {
    event: r.one.events({ from: r.eventCheckIns.eventId, to: r.events.id }),
    user: r.one.users({ from: r.eventCheckIns.userId, to: r.users.id }),
  },
  mentorshipEnrollments: {
    user: r.one.users({
      from: r.mentorshipEnrollments.userId,
      to: r.users.id,
    }),
  },
  kinGroups: {
    members: r.many.kinMemberships({
      from: r.kinGroups.id,
      to: r.kinMemberships.groupId,
    }),
  },
  kinMemberships: {
    group: r.one.kinGroups({
      from: r.kinMemberships.groupId,
      to: r.kinGroups.id,
    }),
    user: r.one.users({ from: r.kinMemberships.userId, to: r.users.id }),
  },
  committeeApplications: {
    user: r.one.users({
      from: r.committeeApplications.userId,
      to: r.users.id,
    }),
  },
  resumes: {
    user: r.one.users({ from: r.resumes.userId, to: r.users.id }),
  },
}));
