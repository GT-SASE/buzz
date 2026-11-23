import {
  isCronAuthorized,
  isCronSecretUsable,
  runScheduledFlips,
} from "@buzz/api";
import { db } from "@buzz/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Vercel Cron, GET only. Opens voting and closes it when an election's
 * scheduled time has passed, then sends the same notices a manual flip does.
 *
 * The URL is public, so nothing happens until the `Authorization` header is
 * `Bearer ${CRON_SECRET}`; the query string is never read. The reply says
 * only how many elections moved.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!isCronSecretUsable(secret)) {
    console.error("CRON_SECRET is unset or shorter than 32 characters");
    return new Response("unauthorized", { status: 401, headers: NO_STORE });
  }
  if (!isCronAuthorized(request.headers.get("authorization"), secret)) {
    return new Response("unauthorized", { status: 401, headers: NO_STORE });
  }

  try {
    const run = await runScheduledFlips(db);
    return Response.json(
      { flipped: run.flipped.length, skipped: run.skipped.length },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "cron.elections",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return new Response("internal error", { status: 500, headers: NO_STORE });
  }
}
