import NextAuth from "next-auth";
import { cache } from "react";

import { authConfig } from "./config";

// Keep in sync with `site.url`. Google only has the production callback
// registered; this makes every other origin (Vercel preview, localhost) send
// that redirect_uri and then bounce back after Google returns.
process.env.AUTH_REDIRECT_PROXY_URL ??=
  "https://buzzsase.vercel.app/api/auth";

const { auth: uncachedAuth, handlers, signIn, signOut } = NextAuth(authConfig);

const auth = cache(uncachedAuth);

export { auth, handlers, signIn, signOut };
export { configureAdminEmails, isOfficerEmail } from "./admins";
