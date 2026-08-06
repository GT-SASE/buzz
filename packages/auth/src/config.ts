import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { type DefaultSession, type NextAuthConfig } from "next-auth";
import GoogleProvider from "next-auth/providers/google";

import {
  accounts,
  db,
  sessions,
  users,
  verificationTokens,
  type UserRole,
} from "@buzz/db";
import { isOfficerEmail } from "./admins";

/**
 * Module augmentation for `next-auth` types. Allows us to add custom properties to the `session`
 * object and keep type safety.
 *
 * @see https://next-auth.js.org/getting-started/typescript#module-augmentation
 */
declare module "next-auth" {
  interface Session extends DefaultSession {
    user: {
      id: string;
      role: UserRole;
    } & DefaultSession["user"];
  }

  interface User {
    role?: UserRole;
  }
}

/**
 * The `user` handed to the session callback below is an `AdapterUser`, not the
 * `User` above, so the role has to be declared on both or the callback cannot
 * see the column the adapter selected.
 */
declare module "@auth/core/adapters" {
  interface AdapterUser {
    role: UserRole;
  }
}

/**
 * Options for NextAuth.js used to configure adapters, providers, callbacks, etc.
 *
 * @see https://next-auth.js.org/configuration/options
 */
export const authConfig = {
  // Google only. Every member already has a Georgia Tech Google account, which
  // makes it the one provider nobody has to go create something for.
  // Credentials are read from AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET.
  providers: [GoogleProvider],
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  events: {
    /**
     * Seed the role from the allowlist.
     *
     * `createUser` covers the first sign-in; `signIn` covers an account that
     * already existed when its address was added. Deliberately one-way: it
     * never demotes, so an officer who leaves the allowlist keeps access until
     * somebody actually edits the row, rather than losing it silently the next
     * time an environment variable changes.
     */
    createUser: async ({ user }) => {
      if (!user.id || !isOfficerEmail(user.email)) return;
      await db
        .update(users)
        .set({ role: "ADMIN" })
        .where(eq(users.id, user.id));
    },
    signIn: async ({ user }) => {
      if (!user.id || user.role === "ADMIN") return;
      if (!isOfficerEmail(user.email)) return;
      await db
        .update(users)
        .set({ role: "ADMIN" })
        .where(eq(users.id, user.id));
    },
  },
  callbacks: {
    // Database sessions, so `user` is the freshly-read row: carrying the role
    // here costs no extra query, and a revoked officer loses access on their
    // next request rather than whenever a token happens to expire.
    session: ({ session, user }) => ({
      ...session,
      user: {
        ...session.user,
        id: user.id,
        role: user.role ?? "MEMBER",
      },
    }),
  },
} satisfies NextAuthConfig;
