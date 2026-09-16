import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/**
 * Production (Vercel production or NODE_ENV=production without skip) requires
 * the portal secrets. Local and preview builds can leave them empty so the
 * public site still prerenders; the portal then fails per-request instead.
 */
const requirePortalSecrets =
  process.env.VERCEL_ENV === "production" ||
  (process.env.NODE_ENV === "production" &&
    process.env.VERCEL_ENV !== "preview" &&
    process.env.VERCEL_ENV !== "development");

const secret = requirePortalSecrets ? z.string().min(1) : z.string().optional();
/** Auth.js rejects secrets shorter than 32 characters at runtime. */
const authSecret = requirePortalSecrets
  ? z.string().min(32)
  : z.string().optional();

export const env = createEnv({
  server: {
    AUTH_SECRET: authSecret,
    AUTH_GOOGLE_ID: secret,
    AUTH_GOOGLE_SECRET: secret,
    /**
     * Canonical Auth.js origin. Leave unset so the request host is used; the
     * Google callback is pinned via AUTH_REDIRECT_PROXY_URL instead.
     */
    AUTH_URL: z.url().optional(),
    /** Stable Auth.js path Google always returns to. */
    AUTH_REDIRECT_PROXY_URL: z.url().optional(),
    DATABASE_URL: requirePortalSecrets ? z.url() : z.url().optional(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
  },

  client: {},

  runtimeEnv: {
    AUTH_SECRET: process.env.AUTH_SECRET,
    AUTH_GOOGLE_ID: process.env.AUTH_GOOGLE_ID,
    AUTH_GOOGLE_SECRET: process.env.AUTH_GOOGLE_SECRET,
    AUTH_URL: process.env.AUTH_URL,
    AUTH_REDIRECT_PROXY_URL: process.env.AUTH_REDIRECT_PROXY_URL,
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    VERCEL_ENV: process.env.VERCEL_ENV,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
