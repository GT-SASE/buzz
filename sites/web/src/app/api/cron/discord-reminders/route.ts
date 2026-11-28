export { GET } from "@buzz/discord-bot/cron";

// Vercel Cron calls this, and the handler checks `Bearer ${CRON_SECRET}` itself.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
