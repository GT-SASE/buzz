import { relations, sql } from "drizzle-orm";
import {
  check,
  index,
  pgTableCreator,
  primaryKey,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { AdapterAccount } from "next-auth/adapters";

/**
 * This is an example of how to use the multi-project schema feature of Drizzle ORM. Use the same
 * database instance for multiple projects.
 *
 * @see https://orm.drizzle.team/docs/goodies#multi-project-schema
 */
export const createTable = pgTableCreator((name) => `buzz_${name}`);

/**
 * Index and constraint names have to carry the prefix too.
 *
 * `pgTableCreator` only renames tables, but Postgres keeps indexes and
 * constraints in one namespace per schema, not per table. This database is
 * shared with a sibling project whose own `account` table already owns
 * `account_user_id_idx`, so an unprefixed name here fails the push outright
 * with 42P07 rather than quietly coexisting.
 */
const idx = (name: string) => `buzz_${name}`;

/** Portal roles. Membership is free, so `MEMBER` is simply "has signed in". */
export type UserRole = "MEMBER" | "ADMIN";

export const users = createTable(
  "user",
  (d) => ({
    id: d
      .varchar({ length: 255 })
      .notNull()
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: d.varchar({ length: 255 }),
    /** Stored lowercase. Lookups and the unique index assume that. */
    email: d.varchar({ length: 255 }).notNull(),
    /**
     * No default: Auth.js writes the provider claim. Defaulting to `now()`
     * would mark every account verified even when the provider did not.
     */
    emailVerified: d.timestamp({
      mode: "date",
      withTimezone: true,
    }),
    image: d.varchar({ length: 255 }),
    /**
     * The whole role model — no separate admins table. The SQL default is
     * load-bearing: the Auth.js adapter inserts new users without knowing this
     * column exists, so anything `notNull` here needs a default at the database
     * level, not just in the builder.
     *
     * Officers are promoted from the roster by an existing officer, or by
     * hand in `pnpm db:studio`.
     */
    role: d
      .varchar({ length: 16 })
      .$type<UserRole>()
      .notNull()
      .default("MEMBER"),
  }),
  (t) => [
    /**
     * Unique on lower(email) so mixed-case duplicates cannot coexist. Writers
     * must store lowercase; see auth createUser and manualCheckIn.
     */
    uniqueIndex(idx("user_email_lower_idx")).on(sql`lower(${t.email})`),
    /** `$type` is a compile-time cast only; this is what the database enforces. */
    check(idx("user_role_check"), sql`${t.role} in ('MEMBER', 'ADMIN')`),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  checkIns: many(eventCheckIns),
}));

export const accounts = createTable(
  "account",
  (d) => ({
    userId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: d.varchar({ length: 255 }).$type<AdapterAccount["type"]>().notNull(),
    provider: d.varchar({ length: 255 }).notNull(),
    providerAccountId: d.varchar({ length: 255 }).notNull(),
    refresh_token: d.text(),
    access_token: d.text(),
    expires_at: d.integer(),
    token_type: d.varchar({ length: 255 }),
    scope: d.varchar({ length: 255 }),
    id_token: d.text(),
    session_state: d.varchar({ length: 255 }),
  }),
  (t) => [
    primaryKey({ columns: [t.provider, t.providerAccountId] }),
    index(idx("account_user_id_idx")).on(t.userId),
  ],
);

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const sessions = createTable(
  "session",
  (d) => ({
    sessionToken: d.varchar({ length: 255 }).notNull().primaryKey(),
    userId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires: d.timestamp({ mode: "date", withTimezone: true }).notNull(),
  }),
  (t) => [index(idx("session_user_id_idx")).on(t.userId)],
);

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const verificationTokens = createTable(
  "verification_token",
  (d) => ({
    identifier: d.varchar({ length: 255 }).notNull(),
    token: d.varchar({ length: 255 }).notNull(),
    expires: d.timestamp({ mode: "date", withTimezone: true }).notNull(),
  }),
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

/**
 * A chapter event that members earn points for attending.
 *
 * `checkInCode` is a bearer credential — whoever holds it can check in — so no
 * member-facing query may ever select it, and rotating it is how an officer
 * revokes a photographed poster.
 */
export const events = createTable(
  "event",
  (d) => ({
    id: d
      .varchar({ length: 255 })
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    title: d.varchar({ length: 200 }).notNull(),
    description: d.text(),
    location: d.varchar({ length: 200 }),
    startsAt: d.timestamp({ withTimezone: true }).notNull(),
    /** What attending is worth. Snapshotted onto the check-in row, never read back. */
    pointsValue: d.integer().notNull().default(10),
    checkInCode: d.varchar({ length: 12 }).notNull(),
    checkInEnabled: d.boolean().notNull().default(true),
    /** Null means uncapped. */
    maxCheckIns: d.integer(),
    /**
     * Denormalized on purpose: it is what lets the capacity gate be settled
     * inside the same UPDATE that mutates it, so two simultaneous scans cannot
     * both pass on the same stale count.
     */
    currentCheckIns: d.integer().notNull().default(0),
    /** Soft hide. An event with attendance is never deleted — that is history. */
    archivedAt: d.timestamp({ withTimezone: true }),
    createdById: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => users.id),
    createdAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    updatedAt: d.timestamp({ withTimezone: true }).$onUpdate(() => new Date()),
  }),
  (t) => [
    uniqueIndex(idx("event_check_in_code_idx")).on(t.checkInCode),
    index(idx("event_starts_at_idx")).on(t.startsAt),
    index(idx("event_created_by_idx")).on(t.createdById),
    check(idx("event_points_value_check"), sql`${t.pointsValue} >= 0`),
    check(
      idx("event_max_check_ins_check"),
      sql`${t.maxCheckIns} is null or ${t.maxCheckIns} > 0`,
    ),
    check(idx("event_current_check_ins_check"), sql`${t.currentCheckIns} >= 0`),
  ],
);

/**
 * One attendance record. The unique constraint — not the read that precedes the
 * insert — is what actually settles a double submission, and it holds for the
 * manual admin path too.
 */
export const eventCheckIns = createTable(
  "event_check_in",
  (d) => ({
    id: d
      .varchar({ length: 255 })
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    eventId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    method: d
      .varchar({ length: 16 })
      .$type<"code" | "manual">()
      .notNull()
      .default("code"),
    /**
     * Deliberately no default. Points are snapshotted from the event at the
     * moment of check-in, so re-pricing an event later cannot retroactively
     * rewrite anybody's history. A default here would let a writer forget.
     */
    pointsEarned: d.integer().notNull(),
    /**
     * Officer who added or last removed via the manual path. Null for a
     * member's own code check-in.
     */
    actedByUserId: d.varchar({ length: 255 }).references(() => users.id, {
      onDelete: "set null",
    }),
    checkedInAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  }),
  (t) => [
    unique(idx("event_check_in_unique")).on(t.eventId, t.userId),
    index(idx("event_check_in_event_checked_in_idx")).on(
      t.eventId,
      t.checkedInAt.desc(),
    ),
    index(idx("event_check_in_user_checked_in_idx")).on(
      t.userId,
      t.checkedInAt.desc(),
    ),
    check(idx("check_in_method_check"), sql`${t.method} in ('code', 'manual')`),
    check(idx("check_in_points_earned_check"), sql`${t.pointsEarned} >= 0`),
  ],
);

export const eventsRelations = relations(events, ({ one, many }) => ({
  createdBy: one(users, {
    fields: [events.createdById],
    references: [users.id],
  }),
  checkIns: many(eventCheckIns),
}));

export const eventCheckInsRelations = relations(eventCheckIns, ({ one }) => ({
  event: one(events, {
    fields: [eventCheckIns.eventId],
    references: [events.id],
  }),
  user: one(users, { fields: [eventCheckIns.userId], references: [users.id] }),
}));

/** A member saying they plan to come. Separate from check-in, which is proof. */
export const eventRsvps = createTable(
  "event_rsvp",
  (d) => ({
    eventId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  }),
  (t) => [
    primaryKey({ columns: [t.eventId, t.userId] }),
    index(idx("event_rsvp_user_idx")).on(t.userId),
  ],
);

export type MentorshipRole = "mentor" | "mentee";
export type MentorshipStatus = "interested" | "enrolled" | "withdrawn";

/**
 * A kin group. Officers create them; members join an open one themselves or
 * an officer places them. Null capacity means uncapped.
 *
 * Groups belong to one semester (`fall-2026`), so every Fall and Spring gets
 * a fresh set. `year` is the school year that semester falls in, kept for
 * filtering. Past semesters stay as history.
 */
export const kinGroups = createTable(
  "kin_group",
  (d) => ({
    id: d
      .varchar({ length: 255 })
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    year: d.varchar({ length: 9 }).notNull(),
    semester: d.varchar({ length: 16 }).notNull(),
    name: d.varchar({ length: 80 }).notNull(),
    description: d.varchar({ length: 600 }),
    capacity: d.integer(),
    isOpen: d.boolean().notNull().default(true),
    createdAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    updatedAt: d.timestamp({ withTimezone: true }).$onUpdate(() => new Date()),
  }),
  (t) => [
    uniqueIndex(idx("kin_group_semester_name_idx")).on(
      t.semester,
      sql`lower(${t.name})`,
    ),
    index(idx("kin_group_year_idx")).on(t.year),
    check(
      idx("kin_group_capacity_check"),
      sql`${t.capacity} is null or ${t.capacity} > 0`,
    ),
  ],
);

/**
 * Mentor-family signup. Points here are a separate ledger from event
 * attendance — a coffee with your little does not count as a GBM, and a GBM
 * does not count as a family meeting.
 *
 * One row per member per school year: role and KIN points carry from Fall
 * into Spring, and every August starts fresh. Which group someone is in is
 * per semester and lives in `kinMemberships`.
 */
export const mentorshipEnrollments = createTable(
  "mentorship_enrollment",
  (d) => ({
    userId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    year: d.varchar({ length: 9 }).notNull(),
    role: d.varchar({ length: 16 }).$type<MentorshipRole>().notNull(),
    status: d
      .varchar({ length: 16 })
      .$type<MentorshipStatus>()
      .notNull()
      .default("interested"),
    note: d.varchar({ length: 400 }),
    points: d.integer().notNull().default(0),
    enrolledAt: d.timestamp({ withTimezone: true }),
    createdAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    updatedAt: d.timestamp({ withTimezone: true }).$onUpdate(() => new Date()),
  }),
  (t) => [
    primaryKey({ columns: [t.userId, t.year] }),
    index(idx("mentorship_status_idx")).on(t.status),
    index(idx("mentorship_year_idx")).on(t.year),
    check(idx("mentorship_role_check"), sql`${t.role} in ('mentor', 'mentee')`),
    check(
      idx("mentorship_status_check"),
      sql`${t.status} in ('interested', 'enrolled', 'withdrawn')`,
    ),
    check(idx("mentorship_points_check"), sql`${t.points} >= 0`),
  ],
);

export const mentorshipEnrollmentsRelations = relations(
  mentorshipEnrollments,
  ({ one }) => ({
    user: one(users, {
      fields: [mentorshipEnrollments.userId],
      references: [users.id],
    }),
  }),
);

/**
 * One member in one kin group for one semester. The primary key keeps a
 * member to a single group per semester. `points` is what they earned with
 * this group, for semester standings; the yearly total stays on the
 * enrollment row.
 */
export const kinMemberships = createTable(
  "kin_membership",
  (d) => ({
    userId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    semester: d.varchar({ length: 16 }).notNull(),
    groupId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => kinGroups.id, { onDelete: "cascade" }),
    points: d.integer().notNull().default(0),
    joinedAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  }),
  (t) => [
    primaryKey({ columns: [t.userId, t.semester] }),
    index(idx("kin_membership_group_idx")).on(t.groupId),
    check(idx("kin_membership_points_check"), sql`${t.points} >= 0`),
  ],
);

export const kinGroupsRelations = relations(kinGroups, ({ many }) => ({
  members: many(kinMemberships),
}));

export const kinMembershipsRelations = relations(kinMemberships, ({ one }) => ({
  group: one(kinGroups, {
    fields: [kinMemberships.groupId],
    references: [kinGroups.id],
  }),
  user: one(users, { fields: [kinMemberships.userId], references: [users.id] }),
}));

export type CommitteeId = "events" | "marketing" | "treasury";
export type CommitteeApplicationStatus =
  "submitted" | "interviewing" | "accepted" | "declined" | "withdrawn";

/**
 * One committee application per member per recruiting cycle.
 *
 * Answers are the Google Form fields. Status and officerNotes are the
 * interview sheet — members never read those columns.
 */
export const committeeApplications = createTable(
  "committee_application",
  (d) => ({
    id: d
      .varchar({ length: 255 })
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `fall-2026`. A new cycle is a new row, not an overwrite. */
    cycle: d.varchar({ length: 32 }).notNull(),
    wantsEvents: d.boolean().notNull().default(false),
    wantsMarketing: d.boolean().notNull().default(false),
    wantsTreasury: d.boolean().notNull().default(false),
    discordHandle: d.varchar({ length: 80 }).notNull(),
    eventsWhy: d.varchar({ length: 2000 }),
    eventsCollabs: d.varchar({ length: 1000 }),
    marketingWhy: d.varchar({ length: 2000 }),
    marketingConnections: d.varchar({ length: 1000 }),
    treasuryWhy: d.varchar({ length: 2000 }),
    otherOrgs: d.varchar({ length: 1000 }),
    comments: d.varchar({ length: 1000 }),
    status: d
      .varchar({ length: 16 })
      .$type<CommitteeApplicationStatus>()
      .notNull()
      .default("submitted"),
    officerNotes: d.varchar({ length: 4000 }),
    submittedAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    createdAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    updatedAt: d.timestamp({ withTimezone: true }).$onUpdate(() => new Date()),
  }),
  (t) => [
    unique(idx("committee_app_user_cycle")).on(t.userId, t.cycle),
    index(idx("committee_app_cycle_status_idx")).on(t.cycle, t.status),
    check(
      idx("committee_app_status_check"),
      sql`${t.status} in ('submitted', 'interviewing', 'accepted', 'declined', 'withdrawn')`,
    ),
    check(
      idx("committee_app_committee_check"),
      sql`${t.wantsEvents} or ${t.wantsMarketing} or ${t.wantsTreasury}`,
    ),
  ],
);

export const committeeApplicationsRelations = relations(
  committeeApplications,
  ({ one }) => ({
    user: one(users, {
      fields: [committeeApplications.userId],
      references: [users.id],
    }),
  }),
);

/** 2 MiB. The CHECK below must stay at 2097152. */
export const RESUME_MAX_BYTES = 2 * 1024 * 1024;

/**
 * One resume per member. The PDF bytes live in Postgres so the resume book
 * does not depend on a separate object store.
 *
 * Stored as base64 text: drizzle 0.45 has no bytea helper in the callback
 * column builder, and a 2 MiB cap keeps the row well inside typical limits.
 */
export const resumes = createTable(
  "resume",
  (d) => ({
    userId: d
      .varchar({ length: 255 })
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    fileName: d.varchar({ length: 180 }).notNull(),
    mimeType: d.varchar({ length: 80 }).notNull(),
    byteSize: d.integer().notNull(),
    fileBytes: d.text().notNull(),
    uploadedAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  }),
  (t) => [
    check(
      idx("resume_size_check"),
      sql`${t.byteSize} > 0 and ${t.byteSize} <= 2097152`,
    ),
    check(idx("resume_mime_check"), sql`${t.mimeType} = 'application/pdf'`),
  ],
);

export const resumesRelations = relations(resumes, ({ one }) => ({
  user: one(users, { fields: [resumes.userId], references: [users.id] }),
}));

/**
 * One committee recruiting window per semester, keyed `fall-2026`. Officers
 * open it and pick the close date in the portal; applications are accepted
 * while now is before `closesAt`. Closing early sets `closesAt` to now.
 */
export const committeeCycles = createTable("committee_cycle", (d) => ({
  id: d.varchar({ length: 32 }).primaryKey(),
  closesAt: d.timestamp({ withTimezone: true }).notNull(),
  createdById: d.varchar({ length: 255 }).references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: d
    .timestamp({ withTimezone: true })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: d.timestamp({ withTimezone: true }).$onUpdate(() => new Date()),
}));

export type ElectionPhase = "nominating" | "voting" | "closed" | "published";
export type CandidateStatus = "pending" | "approved" | "rejected";

/**
 * A yearly officer election. Officers move it through the phases by hand:
 * nominating (members run), voting (approved candidates only), closed (counts
 * visible to officers), published (counts visible to members).
 */
export const elections = createTable(
  "election",
  (d) => ({
    id: d
      .varchar({ length: 255 })
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    year: d.varchar({ length: 9 }).notNull(),
    title: d.varchar({ length: 120 }).notNull(),
    phase: d
      .varchar({ length: 16 })
      .$type<ElectionPhase>()
      .notNull()
      .default("nominating"),
    createdById: d.varchar({ length: 255 }).references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    updatedAt: d.timestamp({ withTimezone: true }).$onUpdate(() => new Date()),
  }),
  (t) => [
    index(idx("election_year_idx")).on(t.year),
    check(
      idx("election_phase_check"),
      sql`${t.phase} in ('nominating', 'voting', 'closed', 'published')`,
    ),
  ],
);

export const electionPositions = createTable(
  "election_position",
  (d) => ({
    id: d
      .varchar({ length: 255 })
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    electionId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => elections.id, { onDelete: "cascade" }),
    title: d.varchar({ length: 80 }).notNull(),
    sortOrder: d.integer().notNull().default(0),
  }),
  (t) => [index(idx("election_position_election_idx")).on(t.electionId)],
);

export const electionCandidates = createTable(
  "election_candidate",
  (d) => ({
    id: d
      .varchar({ length: 255 })
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    positionId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => electionPositions.id, { onDelete: "cascade" }),
    userId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    statement: d.varchar({ length: 1000 }).notNull(),
    status: d
      .varchar({ length: 16 })
      .$type<CandidateStatus>()
      .notNull()
      .default("pending"),
    createdAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  }),
  (t) => [
    unique(idx("election_candidate_unique")).on(t.positionId, t.userId),
    check(
      idx("election_candidate_status_check"),
      sql`${t.status} in ('pending', 'approved', 'rejected')`,
    ),
  ],
);

/**
 * One ballot per voter per position; the primary key is what refuses a
 * second vote. No query may return voterId alongside candidateId — officers
 * see counts, never who voted for whom.
 */
export const electionVotes = createTable(
  "election_vote",
  (d) => ({
    positionId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => electionPositions.id, { onDelete: "cascade" }),
    voterId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    candidateId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => electionCandidates.id, { onDelete: "cascade" }),
    castAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  }),
  (t) => [
    primaryKey({ columns: [t.positionId, t.voterId] }),
    index(idx("election_vote_candidate_idx")).on(t.candidateId),
  ],
);
