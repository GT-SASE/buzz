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
     * Officers are promoted via ADMIN_EMAILS on sign-in, or by hand in
     * `pnpm db:studio`. There is no in-app promotion UI.
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

export type MentorshipRole = "mentor" | "mentee";
export type MentorshipStatus = "interested" | "enrolled" | "withdrawn";

/**
 * Mentor-family signup. Points here are a separate ledger from event
 * attendance — a coffee with your little does not count as a GBM, and a GBM
 * does not count as a family meeting.
 */
export const mentorshipEnrollments = createTable(
  "mentorship_enrollment",
  (d) => ({
    userId: d
      .varchar({ length: 255 })
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
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
    index(idx("mentorship_status_idx")).on(t.status),
    check(
      idx("mentorship_role_check"),
      sql`${t.role} in ('mentor', 'mentee')`,
    ),
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
