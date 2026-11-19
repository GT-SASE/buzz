/**
 * The daily cron endpoint. GET only, because that is what Vercel Cron sends, and any
 * other method gets the platform's 405 since this file exports no handler for it.
 *
 * The URL is assumed public, so a request is refused before anything else happens
 * unless its `Authorization` value is the secret. Only that header is read, and the
 * query string is ignored, so a secret placed there would not work.
 *
 * Responses are fixed text and say nothing about what the run found.
 */

import {
  isCronAuthorized,
  isCronSecretUsable,
} from "../../src/lib/cron-auth.ts";
import { runDailyJobs } from "../../src/reminders/daily.ts";

const NO_STORE = { "cache-control": "no-store" };

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!isCronSecretUsable(secret)) {
    // Every daily run is being refused, so say so. A wrong header is not logged: that
    // is only someone trying the URL.
    console.error("Cron secret is unset or too short");
    return new Response("unauthorized", { status: 401, headers: NO_STORE });
  }
  if (!isCronAuthorized(request.headers.get("authorization"), secret)) {
    return new Response("unauthorized", { status: 401, headers: NO_STORE });
  }
  return (await runDailyJobs())
    ? new Response("ok", { headers: NO_STORE })
    : new Response("internal error", { status: 500, headers: NO_STORE });
}
