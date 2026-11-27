export { POST } from "@buzz/discord-bot/interactions";

// Discord calls this server to server and the handler checks the request's
// ed25519 signature itself, over the raw body, so nothing here may read it first.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
