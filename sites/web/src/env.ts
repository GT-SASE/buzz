import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/**
 * Every server var is optional. The public site is prerendered and reads
 * neither session nor database, so it must build with an empty environment.
 * Set all of them to turn the portal on.
 */
export const env = createEnv({
  server: {
    AUTH_SECRET: z.string().optional(),
    AUTH_GOOGLE_ID: z.string().optional(),
    AUTH_GOOGLE_SECRET: z.string().optional(),
    DATABASE_URL: z.url().optional(),
    /** Comma-separated. Exact addresses, or `@domain` for a whole domain. */
    ADMIN_EMAILS: z.string().optional(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
  },

  client: {},

  runtimeEnv: {
    AUTH_SECRET: process.env.AUTH_SECRET,
    AUTH_GOOGLE_ID: process.env.AUTH_GOOGLE_ID,
    AUTH_GOOGLE_SECRET: process.env.AUTH_GOOGLE_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
    ADMIN_EMAILS: process.env.ADMIN_EMAILS,
    NODE_ENV: process.env.NODE_ENV,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
