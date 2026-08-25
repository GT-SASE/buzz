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

const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;

async function storeEmailLowercase(user: {
  id?: string;
  email?: string | null;
}) {
  if (!user.id) return;
  const email = user.email?.trim().toLowerCase();
  if (email && email !== user.email) {
    await db.update(users).set({ email }).where(eq(users.id, user.id));
  }
}

/**
 * Options for NextAuth.js used to configure adapters, providers, callbacks, etc.
 *
 * @see https://next-auth.js.org/configuration/options
 */
export const authConfig = {
  // Vercel (and any reverse proxy) sets the host header; Auth.js needs to
  // trust it or every callback URL is built against localhost.
  trustHost: true,
  // Google only. Any Google account may join; there is no school-domain gate.
  // Credentials are read from AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET.
  // allowDangerousEmailAccountLinking lets a Google login attach to a user row
  // that already exists with the same address. Without it, an officer seeded
  // straight into the database cannot sign in at all — Auth.js throws
  // OAuthAccountNotLinked. Safe here because Google is the only provider and it
  // verifies the address; it would not be with an unverified email provider.
  providers: [GoogleProvider({ allowDangerousEmailAccountLinking: true })],
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: {
    strategy: "database",
    maxAge: SESSION_MAX_AGE_SEC,
    updateAge: 24 * 60 * 60,
  },
  cookies: {
    sessionToken: {
      name:
        process.env.NODE_ENV === "production"
          ? "__Secure-authjs.session-token"
          : "authjs.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
  },
  events: {
    /**
     * Store email lowercase so roster search and the unique index agree.
     * Officer access is the `role` column — promote from the roster, never
     * from an env allowlist on sign-in.
     */
    createUser: async ({ user }) => {
      await storeEmailLowercase(user);
    },
    signIn: async ({ user }) => {
      await storeEmailLowercase(user);
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
