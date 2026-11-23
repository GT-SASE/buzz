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

/**
 * Portal roles. Membership is free, so `MEMBER` is simply "has signed in".
 * `ADMIN` is an officer. `SUPER_ADMIN` ranks above every officer and is the
 * only role that can change someone else's role.
 */
export type UserRole = "MEMBER" | "ADMIN" | "SUPER_ADMIN";

/** Officer tools: an admin, or a super admin who keeps every admin power. */
export function isOfficerRole(
  role: string | null | undefined,
): role is "ADMIN" | "SUPER_ADMIN" {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

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
     * Officers are `ADMIN`. The first `SUPER_ADMIN` is assigned by hand in the
     * database; the migration only allows the value. After that, only a super
     * admin can change roles from the roster.
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
    check(
      idx("user_role_check"),
      sql`${t.role} in ('MEMBER', 'ADMIN', 'SUPER_ADMIN')`,
    ),
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
    /**
     * Soft hide. An event with attendance is never deleted — that is history.
     * While set, its check-ins count for nothing: not points, the leaderboard,
     * or voting eligibility. Read-time only, so restoring undoes it.
     */
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

/**
 * Members waiting for a seat at a capped event, first come first served. A
 * table beside `event_rsvp` rather than a status column on it: code that
 * predates this table (a preview before its migration, the old build during a
 * deploy) counts every `event_rsvp` row as a confirmed seat and mails it a
 * calendar entry, so a waiting member must not be in that table. Promotion
 * moves the row across inside one transaction that holds the event row lock.
 */
export const eventWaitlist = createTable(
  "event_waitlist",
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
    index(idx("event_waitlist_queue_idx")).on(t.eventId, t.createdAt),
    index(idx("event_waitlist_user_idx")).on(t.userId),
  ],
);

/**
 * How often a recurring series repeats. Occurrences are real `event` rows, so
 * check-ins, RSVPs, points and the .ics feed work per occurrence; this table
 * only says which rows belong together. `position` is the occurrence's place in
 * the series as created (0 first). A table beside `event` for the same reason
 * as the waitlist: an old build never reads it, and a preview before the
 * migration just sees every event as a one-off.
 */
export const EVENT_CADENCES = ["weekly", "biweekly"] as const;
export type EventCadence = (typeof EVENT_CADENCES)[number];

export const eventSeriesMembers = createTable(
  "event_series_member",
  (d) => ({
    eventId: d
      .varchar({ length: 255 })
      .primaryKey()
      .references(() => events.id, { onDelete: "cascade" }),
    seriesId: d.varchar({ length: 255 }).notNull(),
    cadence: d.varchar({ length: 12 }).$type<EventCadence>().notNull(),
    position: d.integer().notNull(),
  }),
  (t) => [
    index(idx("event_series_member_series_idx")).on(t.seriesId, t.position),
    check(
      idx("event_series_member_cadence_check"),
      sql`${t.cadence} in ('weekly', 'biweekly')`,
    ),
    check(idx("event_series_member_position_check"), sql`${t.position} >= 0`),
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
    wantsWebsite: d.boolean().notNull().default(false),
    discordHandle: d.varchar({ length: 80 }).notNull(),
    eventsWhy: d.varchar({ length: 2000 }),
    eventsCollabs: d.varchar({ length: 1000 }),
    marketingWhy: d.varchar({ length: 2000 }),
    marketingConnections: d.varchar({ length: 1000 }),
    treasuryWhy: d.varchar({ length: 2000 }),
    websiteWhy: d.varchar({ length: 2000 }),
    /** GitHub, a portfolio, anything they have built. Optional. */
    websiteLinks: d.varchar({ length: 1000 }),
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
      sql`${t.wantsEvents} or ${t.wantsMarketing} or ${t.wantsTreasury} or ${t.wantsWebsite}`,
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
 * The headshot a board member chose for the public board page: one per member,
 * re-encoded to a 400 px square WebP on upload, so the row stays small. Kept
 * beside `buzz_user` rather than on it (Auth.js reads whole user rows), and
 * base64 text like resumes. `etag` is a hash of the bytes and versions the
 * public URL.
 */
export const boardPhotos = createTable(
  "board_photo",
  (d) => ({
    userId: d
      .varchar({ length: 255 })
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    contentType: d.varchar({ length: 16 }).notNull(),
    byteSize: d.integer().notNull(),
    bytes: d.text().notNull(),
    etag: d.varchar({ length: 32 }).notNull(),
    updatedAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  }),
  (t) => [
    check(
      idx("board_photo_size_check"),
      sql`${t.byteSize} > 0 and ${t.byteSize} <= 204800`,
    ),
    check(idx("board_photo_type_check"), sql`${t.contentType} = 'image/webp'`),
  ],
);

/**
 * One committee recruiting window per semester, keyed `fall-2026`. Officers
 * open it and pick the close date in the portal; applications are accepted
 * while now is before `closesAt`. Closing early sets `closesAt` to now.
 */
export const committeeCycles = createTable("committee_cycle", (d) => ({
  id: d.varchar({ length: 32 }).primaryKey(),
  closesAt: d.timestamp({ withTimezone: true }).notNull(),
  committees: d
    .varchar({ length: 16 })
    .array()
    .default(
      sql`ARRAY['events','marketing','treasury','website']::varchar(16)[]`,
    )
    .notNull(),
  createdById: d.varchar({ length: 255 }).references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: d
    .timestamp({ withTimezone: true })
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: d.timestamp({ withTimezone: true }).$onUpdate(() => new Date()),
}));

/**
 * A page officers publish without a code change, served at `/{slug}`. Only
 * `published` rows render; a draft is a 404 to everyone, officers included,
 * and the editor preview is where it is read.
 */
export const pages = createTable(
  "page",
  (d) => ({
    id: d
      .varchar({ length: 255 })
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    slug: d.varchar({ length: 60 }).notNull(),
    title: d.varchar({ length: 200 }).notNull(),
    description: d.varchar({ length: 300 }).notNull().default(""),
    body: d.text().notNull().default(""),
    published: d.boolean().notNull().default(false),
    createdById: d.varchar({ length: 255 }).references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
    updatedAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .$onUpdate(() => new Date())
      .notNull(),
  }),
  (t) => [
    uniqueIndex(idx("page_slug_idx")).on(t.slug),
    index(idx("page_updated_at_idx")).on(t.updatedAt),
  ],
);

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
    /** When the cron opens voting. Null: officers flip by hand. */
    opensAt: d.timestamp({ withTimezone: true }),
    /** When the cron closes voting, and the last moment a ballot counts. */
    closesAt: d.timestamp({ withTimezone: true }),
    /** Counted check-ins this school year a member needs to be on the voter list. */
    minCheckIns: d.integer().notNull().default(1),
    /** Set when voting opened and the voter list was frozen. */
    rollFrozenAt: d.timestamp({ withTimezone: true }),
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
    check(idx("election_min_check_ins_check"), sql`${t.minCheckIns} >= 1`),
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
 * The voter list, frozen in the transaction that opens voting: everyone who
 * met the election's eligibility rule at that moment. Only these members may
 * vote, so a check-in after voting opens changes nothing.
 */
export const electionRoll = createTable(
  "election_roll",
  (d) => ({
    electionId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => elections.id, { onDelete: "cascade" }),
    userId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  }),
  (t) => [primaryKey({ columns: [t.electionId, t.userId] })],
);

/**
 * Who has voted on which position, and nothing about what they chose. The
 * primary key is what refuses a second vote. Written in the same transaction
 * as the ballot, but shares no column with `electionBallots` except the
 * position, so the two cannot be joined back into a choice.
 */
export const electionVoters = createTable(
  "election_voter",
  (d) => ({
    electionId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => elections.id, { onDelete: "cascade" }),
    positionId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => electionPositions.id, { onDelete: "cascade" }),
    voterId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  }),
  (t) => [
    primaryKey({ columns: [t.positionId, t.voterId] }),
    index(idx("election_voter_election_idx")).on(t.electionId),
  ],
);

/**
 * What was chosen, with no voter id and no timestamp: a random id and a
 * position and candidate. Tallies count these rows, so deleting a member
 * never changes a result.
 */
export const electionBallots = createTable(
  "election_ballot",
  (d) => ({
    id: d
      .varchar({ length: 255 })
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    positionId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => electionPositions.id, { onDelete: "cascade" }),
    candidateId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => electionCandidates.id, { onDelete: "cascade" }),
  }),
  (t) => [
    index(idx("election_ballot_position_idx")).on(t.positionId),
    index(idx("election_ballot_candidate_idx")).on(t.candidateId),
  ],
);

/**
 * Fixed-window request counters behind the API rate limiter. One row per
 * caller key per window: `key` is the call site's string (`check-in:<userId>`),
 * `windowStart` is the window's start, `floor(now / intervalMs) * intervalMs`,
 * and `count` is the hits so far in it. Every hit is one atomic upsert on the
 * primary key, so serverless instances share one count. Rows are dead once
 * their window ends; the limiter deletes them an hour after it starts, which
 * is what the `windowStart` index serves.
 */
export const rateLimits = createTable(
  "rate_limit",
  (d) => ({
    key: d.varchar({ length: 255 }).notNull(),
    windowStart: d.timestamp({ withTimezone: true }).notNull(),
    count: d.integer().notNull(),
  }),
  (t) => [
    primaryKey({ columns: [t.key, t.windowStart] }),
    index(idx("rate_limit_window_start_idx")).on(t.windowStart),
  ],
);

/**
 * What an officer did, for the audit page. The vocabulary is open on purpose:
 * a feature that adds an officer action adds a name here, with no migration,
 * because nothing reads this column except the filter on that page.
 */
export const AUDIT_ACTIONS = [
  "member.set_role",
  "member.set_graduation_year",
  "committee.set_status",
  "event.manual_check_in",
  "event.remove_check_in",
  "event.create",
  "event.create_series",
  "event.update",
  "event.update_series",
  "event.archive",
  "event.archive_series",
  "event.set_check_in",
  "event.revoke_codes",
  "mentorship.award_points",
  "mentorship.award_group_points",
  "kin_group.carry_forward",
  "election.create",
  "election.configure",
  "election.set_phase",
  "election.edit_positions",
  "election.review_candidate",
  "election.delete",
  "export.election_tally",
  "board.remove_photo",
  "export.roster",
  "export.attendance",
  "export.committee",
  "resume.download",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditTargetType =
  | "member"
  | "application"
  | "event"
  | "kin_group"
  | "roster"
  | "cycle"
  | "election";

/**
 * Append-only record of officer actions. A row is written in the same
 * transaction as the change it describes, so a change with no row, or a row
 * for a change that rolled back, cannot exist.
 *
 * `actorId` and `targetId` carry no foreign key: history has to outlive the
 * account or event it names. `targetLabel` is what the target was called at
 * the time (a member's email, an event's title), so the page still reads
 * after a rename or a deletion. `before` and `after` hold the fields that
 * changed; an export or a download has no before, and puts what was asked
 * for and how many rows came back in `after`. Never put a secret, a resume
 * or a check-in code in either.
 */
export const auditLog = createTable(
  "audit_log",
  (d) => ({
    id: d
      .varchar({ length: 255 })
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    actorId: d.varchar({ length: 255 }).notNull(),
    action: d.varchar({ length: 48 }).$type<AuditAction>().notNull(),
    targetType: d.varchar({ length: 24 }).$type<AuditTargetType>().notNull(),
    targetId: d.varchar({ length: 255 }),
    targetLabel: d.varchar({ length: 255 }),
    before: d.jsonb().$type<Record<string, unknown>>(),
    after: d.jsonb().$type<Record<string, unknown>>(),
    at: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
  }),
  (t) => [
    index(idx("audit_log_at_idx")).on(t.at.desc()),
    index(idx("audit_log_actor_at_idx")).on(t.actorId, t.at.desc()),
    index(idx("audit_log_action_at_idx")).on(t.action, t.at.desc()),
  ],
);

/**
 * Where a ledger row came from. `check_in` and `manual_check_in` are an
 * attendance grant, `check_in_removed` takes one back; `kin_award` and
 * `kin_group_award` are SASE KIN points an officer gave; `opening_balance`
 * is the KIN total a member already held when the ledger began, which was
 * only ever stored as a number, never as separate awards.
 */
export const POINTS_SOURCES = [
  "check_in",
  "manual_check_in",
  "check_in_removed",
  "kin_award",
  "kin_group_award",
  "opening_balance",
] as const;
export type PointsSource = (typeof POINTS_SOURCES)[number];

/**
 * Every change to a member's points, one signed row each. Event attendance
 * and KIN points are separate scores that never add together, so a reader
 * sums one family of sources, not the whole table.
 *
 * The stores a member's totals are read from (`event_check_in.pointsEarned`,
 * `mentorship_enrollment.points`) stay the source of truth for the screens,
 * and every writer updates them and appends here in one transaction. That
 * keeps every existing read as it was, and `points-ledger.integration.test.ts`
 * holds the two equal.
 *
 * Archiving an event is a read-time rule (its check-ins count for nothing,
 * and count again on restore), so the ledger keeps those rows too. A reader
 * that wants live attendance joins `eventId` to `event` and drops archived
 * events, the way the roster does.
 */
export const pointsLedger = createTable(
  "points_ledger",
  (d) => ({
    id: d
      .varchar({ length: 255 })
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Signed. A zero-point event still gets its row, one per check-in. */
    delta: d.integer().notNull(),
    reason: d.varchar({ length: 255 }).notNull(),
    source: d.varchar({ length: 24 }).$type<PointsSource>().notNull(),
    /** Set for the attendance sources. Gone with the event, like its check-ins. */
    eventId: d.varchar({ length: 255 }).references(() => events.id, {
      onDelete: "cascade",
    }),
    /** The officer behind a manual grant, a removal or a KIN award. */
    actedByUserId: d.varchar({ length: 255 }).references(() => users.id, {
      onDelete: "set null",
    }),
    at: d.timestamp({ withTimezone: true }).defaultNow().notNull(),
  }),
  (t) => [
    index(idx("points_ledger_user_at_idx")).on(t.userId, t.at.desc()),
    index(idx("points_ledger_at_idx")).on(t.at.desc()),
    index(idx("points_ledger_source_at_idx")).on(t.source, t.at.desc()),
    index(idx("points_ledger_event_idx")).on(t.eventId),
    check(
      idx("points_ledger_source_check"),
      sql`${t.source} in ('check_in', 'manual_check_in', 'check_in_removed', 'kin_award', 'kin_group_award', 'opening_balance')`,
    ),
  ],
);

/**
 * Which optional emails a member has switched off. A row exists only once a
 * member has saved a choice; no row means every switch is on, so adding a
 * member or a category needs no backfill. Application decisions are not here
 * on purpose: they answer something the member did and are always sent.
 *
 * A table beside `user` rather than columns on it: Auth.js reads whole user
 * rows on every sign-in, and a preview build shares the production database
 * before its migration has run, so a new `user` column would break sign-in
 * there. Nothing but the notify module reads this table.
 */
export const notificationPreferences = createTable(
  "notification_preference",
  (d) => ({
    userId: d
      .varchar({ length: 255 })
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Time or place changes and cancellations of an event the member RSVPed to. */
    eventEmails: d.boolean().notNull().default(true),
    /** Nominations open, voting open and results published. */
    electionEmails: d.boolean().notNull().default(true),
    updatedAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  }),
);

/**
 * A member's say over the leaderboard. A row exists only once a member has
 * saved a choice; no row means the name shows. `hideName` keeps the member on
 * the board at their true rank, shown as "Anonymous member", so every other
 * rank and the viewer's own stay honest.
 *
 * A table beside `user` for the reason `notification_preference` is: a new
 * `user` column would break Auth.js sign-in on a preview that shares the
 * production database before its migration has run.
 */
export const leaderboardPreferences = createTable(
  "leaderboard_preference",
  (d) => ({
    userId: d
      .varchar({ length: 255 })
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    hideName: d.boolean().notNull().default(false),
    updatedAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  }),
);

/**
 * What a member says about themselves that the account row does not hold: the
 * year they graduate. A row exists only once someone has set something; no row
 * means unset. Members set it in settings and officers can correct it.
 *
 * A table beside `user` for the reason `notification_preference` is: a new
 * `user` column would break Auth.js sign-in on a preview that shares the
 * production database before its migration has run. It is separate from
 * `leaderboard_preference` because that one is only the member's own switch,
 * while an officer also edits this one, with an audit row.
 */
export const memberProfiles = createTable(
  "member_profile",
  (d) => ({
    userId: d
      .varchar({ length: 255 })
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    graduationYear: d.smallint(),
    updatedAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  }),
  (t) => [
    check(
      idx("member_profile_graduation_year_check"),
      sql`${t.graduationYear} is null or ${t.graduationYear} between 2000 and 2100`,
    ),
  ],
);
