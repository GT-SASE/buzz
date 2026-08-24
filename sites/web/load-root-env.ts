import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Next.js only auto-loads `.env` from this package directory. The one copy of
 * credentials lives at the repo root so drizzle-kit, vitest, and `pnpm dev`
 * all read the same file.
 *
 * Imported first from `next.config.ts` so `@t3-oss/env-nextjs` sees the values.
 */
const envFile = resolve(import.meta.dirname, "../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
