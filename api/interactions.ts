/**
 * Discord interactions endpoint.
 *
 * Do not log the request body or anything taken from it: every interaction
 * carries a token that lets its holder reply as the bot.
 *
 * Only the signature headers and content-length are read. Do not base a decision
 * on x-forwarded-*, host or x-vercel-* headers: the signed payload is the only
 * source of identity here.
 */

import { waitUntil } from "@vercel/functions";
import {
  isPingInteraction,
  parseAllowedGuildInteraction,
} from "../src/discord/interactions.ts";
import { pong, serializeDirectResponse } from "../src/discord/outbound.ts";
import type { OutboundBody } from "../src/discord/outbound.ts";
import {
  hasWellFormedSignatureHeaders,
  verifiedInteractionFrom,
  verifySignedRequest,
} from "../src/discord/verify.ts";
import { liveDependencies } from "../src/handlers/dependencies.ts";
import { ROUTER } from "../src/handlers/registry.ts";
import { ConfigError } from "../src/lib/config-error.ts";
import {
  getAllowedGuildIds,
  getDiscordAppId,
  getDiscordPublicKey,
} from "../src/lib/env.ts";
import {
  isDeclaredLengthWithin,
  readBodyWithin,
} from "../src/lib/read-body.ts";

const MAX_BODY_BYTES = 64 * 1024;

/**
 * The one way a body reaches Discord from here. No managed channel check runs on
 * this path, so it takes only bodies that cannot post anything others can see.
 * Anything public defers first, then sends through the REST client.
 */
function respond(body: OutboundBody<"direct-response">): Response {
  return new Response(serializeDirectResponse(body), {
    headers: { "content-type": "application/json" },
  });
}

function invalidSignature(): Response {
  return new Response("invalid request signature", { status: 401 });
}

function tooLarge(): Response {
  return new Response("request body too large", { status: 413 });
}

function forbidden(): Response {
  return new Response("forbidden", { status: 403 });
}

async function handle(request: Request): Promise<Response> {
  // Everything up to the signature check runs for anyone on the internet, so
  // refuse what can be refused before reading the body.
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (
    signature === null ||
    timestamp === null ||
    !hasWellFormedSignatureHeaders(signature, timestamp)
  ) {
    return invalidSignature();
  }
  const contentLength = request.headers.get("content-length");
  if (!isDeclaredLengthWithin(contentLength, MAX_BODY_BYTES)) {
    return tooLarge();
  }

  const body = await readBodyWithin(request, MAX_BODY_BYTES);
  if (body === undefined) {
    return tooLarge();
  }

  const signed = verifySignedRequest(
    { body, signature, timestamp },
    getDiscordPublicKey(),
    Date.now(),
  );
  if (signed === undefined) {
    return invalidSignature();
  }

  if (signed.payload === undefined) {
    return new Response("invalid request body", { status: 400 });
  }

  if (isPingInteraction(signed.payload)) {
    return respond(pong());
  }

  const interaction = parseAllowedGuildInteraction(signed.payload, {
    applicationId: getDiscordAppId(),
    allowedGuildIds: getAllowedGuildIds(),
  });
  const verified = interaction && verifiedInteractionFrom(signed);
  if (interaction === undefined || verified === undefined) {
    return forbidden();
  }

  const { reply, after } = await ROUTER.handle(
    interaction,
    verified,
    liveDependencies(),
  );
  // Vercel would otherwise stop the function as soon as the response is sent. This
  // does nothing, silently, if Vercel's request context is missing, so no test here
  // can prove it keeps the work alive. Only a real deployment can.
  if (after !== undefined) {
    waitUntil(after());
  }
  return respond(reply);
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await handle(request);
  } catch (error) {
    // ConfigError messages are written to be safe to log. Other errors could
    // quote request data, so only their type is recorded.
    console.error(
      error instanceof ConfigError
        ? error.message
        : `Interaction failed: ${error instanceof Error ? error.name : "unknown error"}`,
    );
    return new Response("internal error", { status: 500 });
  }
}
