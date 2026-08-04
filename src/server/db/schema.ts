import { relations } from "drizzle-orm";
import {
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

/** Portal roles. Membership is free, so `MEMBER` is simply "has signed in". */
export type UserRole = "MEMBER" | "ADMIN";

export const users = createTable("user", (d) => ({
  id: d
    .varchar({ length: 255 })
    .notNull()
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: d.varchar({ length: 255 }),
  email: d.varchar({ length: 255 }).notNull(),
  emailVerified: d
    .timestamp({
      mode: "date",
      withTimezone: true,
    })
    .$defaultFn(() => /* @__PURE__ */ new Date()),
  image: d.varchar({ length: 255 }),
  /**
   * The whole role model — no separate admins table. The SQL default is
   * load-bearing: the Auth.js adapter inserts new users without knowing this
   * column exists, so anything `notNull` here needs a default at the database
   * level, not just in the builder.
   *
   * Officers are promoted by hand for now: `npm run db:studio`, find the row,
   * set role to ADMIN. There is no in-app promotion UI.
   */
  role: d.varchar({ length: 16 }).$type<UserRole>().notNull().default("MEMBER"),
}));

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
      .references(() => users.id),
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
    index("account_user_id_idx").on(t.userId),
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
      .references(() => users.id),
    expires: d.timestamp({ mode: "date", withTimezone: true }).notNull(),
  }),
  (t) => [index("t_user_id_idx").on(t.userId)],
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
    uniqueIndex("event_check_in_code_idx").on(t.checkInCode),
    index("event_starts_at_idx").on(t.startsAt),
    index("event_created_by_idx").on(t.createdById),
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
    checkedInAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => /* @__PURE__ */ new Date())
      .notNull(),
  }),
  (t) => [
    unique("event_check_in_unique").on(t.eventId, t.userId),
    index("event_check_in_user_idx").on(t.userId),
    index("event_check_in_event_idx").on(t.eventId),
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
