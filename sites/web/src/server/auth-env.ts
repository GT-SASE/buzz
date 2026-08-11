import { configureAdminEmails } from "@buzz/auth/admins";

// Relative import: this file is also loaded from `next.config.ts`, where the
// `~/*` path alias is not available during config transpile.
import { env } from "../env";

/**
 * Bridge `@t3-oss/env-nextjs` into `@buzz/auth` so officer allowlisting sees
 * the same validated values as the rest of the app (`emptyStringAsUndefined`,
 * production required secrets, etc.).
 *
 * Imported from the Auth.js route and from `next.config.ts` (via side effect)
 * so both the Node request path and config-time tooling agree.
 */
configureAdminEmails(() => env.ADMIN_EMAILS);
