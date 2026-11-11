/**
 * Verifies that an interaction request came from Discord.
 *
 * The signature covers the timestamp header followed by the exact bytes of the
 * body, so the body must reach this module unparsed and undecoded.
 *
 * `SignedPayload` and `VerifiedInteraction` are exported as types only, and their
 * constructors demand a key private to this module. The only route to either goes
 * through `verifySignedRequest`, so neither can exist unless a signature passed.
 */

import { createPublicKey, verify } from "node:crypto";
import { isSnowflake } from "../lib/snowflake.ts";
import { parseInteractionBody } from "./interactions.ts";

// DER header for an Ed25519 SubjectPublicKeyInfo (RFC 8410). Discord publishes
// only the raw 32-byte key, and Node needs this wrapper to load it.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// Either case decodes to the same bytes, so one signature has more than one
// accepted spelling. Never use the signature string as a dedupe key.
const SIGNATURE_HEX = /^[0-9a-f]{128}$/i;
const UNIX_SECONDS = /^\d{1,12}$/;

export const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

const MINT = Symbol("verify");

// Announcement, public and private threads.
const THREAD_CHANNEL_TYPES: ReadonlySet<unknown> = new Set([10, 11, 12]);

export interface SignedRequest {
  body: Uint8Array;
  signature: string;
  timestamp: string;
}

/** Cheap enough to run before reading the body of an unauthenticated request. */
export function hasWellFormedSignatureHeaders(
  signature: string,
  timestamp: string,
): boolean {
  return SIGNATURE_HEX.test(signature) && UNIX_SECONDS.test(timestamp);
}

export function hasValidSignature(
  { body, signature, timestamp }: SignedRequest,
  publicKeyHex: string,
): boolean {
  // Buffer.from silently truncates bad hex, so check the shape first.
  if (!hasWellFormedSignatureHeaders(signature, timestamp)) {
    return false;
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
    format: "der",
    type: "spki",
  });
  return verify(
    null,
    Buffer.concat([Buffer.from(timestamp, "utf8"), body]),
    publicKey,
    Buffer.from(signature, "hex"),
  );
}

/**
 * Limits how long a captured request can be replayed. Only meaningful once the
 * signature has passed, because the signature is what makes the timestamp
 * trustworthy.
 */
export function isFreshTimestamp(timestamp: string, nowMs: number): boolean {
  if (!UNIX_SECONDS.test(timestamp)) {
    return false;
  }
  return Math.abs(nowMs - Number(timestamp) * 1000) <= MAX_TIMESTAMP_SKEW_MS;
}

class SignedPayload {
  // Private so that serializing this does not show the interaction token.
  readonly #payload: unknown;

  constructor(key: symbol, payload: unknown) {
    if (key !== MINT || new.target !== SignedPayload) {
      throw new TypeError("A signed payload needs a verified signature");
    }
    this.#payload = payload;
    Object.freeze(this);
  }

  /** Undefined if the signed bytes are not UTF-8 encoded JSON. */
  get payload(): unknown {
    return this.#payload;
  }

  static isSigned(value: unknown): boolean {
    return typeof value === "object" && value !== null && #payload in value;
  }
}

Object.freeze(SignedPayload.prototype);
Object.freeze(SignedPayload);

export type { SignedPayload };

/** Returns undefined unless the signature passes and the timestamp is fresh. */
export function verifySignedRequest(
  request: SignedRequest,
  publicKeyHex: string,
  nowMs: number,
): SignedPayload | undefined {
  if (
    !hasValidSignature(request, publicKeyHex) ||
    !isFreshTimestamp(request.timestamp, nowMs)
  ) {
    return undefined;
  }
  return new SignedPayload(MINT, parseInteractionBody(request.body));
}

/** A thread's `parent_id` is its channel. Elsewhere it is only a category. */
export function isThreadChannelType(type: unknown): boolean {
  return THREAD_CHANNEL_TYPES.has(type);
}

interface VerifiedInteractionFields {
  readonly id: string;
  readonly token: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly channelType: number;
  /** Set only for a thread, and only if the payload included it. */
  readonly parentId: string | undefined;
}

/**
 * An interaction from a signed payload. This is what ties a reply to the channel
 * it lands in: the channel comes from what Discord signed, not from the caller.
 */
class VerifiedInteraction {
  readonly id: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly channelType: number;
  readonly parentId: string | undefined;
  // Private so that it stays out of logs, inspection and JSON.
  readonly #token: string;

  constructor(key: symbol, fields: VerifiedInteractionFields) {
    if (key !== MINT || new.target !== VerifiedInteraction) {
      throw new TypeError("A verified interaction needs a signed payload");
    }
    this.id = fields.id;
    this.guildId = fields.guildId;
    this.channelId = fields.channelId;
    this.channelType = fields.channelType;
    this.parentId = fields.parentId;
    this.#token = fields.token;
    Object.freeze(this);
  }

  static tokenOf(interaction: object): string | undefined {
    return #token in interaction ? interaction.#token : undefined;
  }
}

Object.freeze(VerifiedInteraction.prototype);
Object.freeze(VerifiedInteraction);

export type { VerifiedInteraction };

/** Returns undefined for anything that was not made by this module. */
export function interactionToken(
  interaction: VerifiedInteraction,
): string | undefined {
  return VerifiedInteraction.tokenOf(interaction);
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

/**
 * Returns undefined if the payload does not name everything a reply needs, such
 * as an interaction from a direct message, which has no guild.
 */
export function verifiedInteractionFrom(
  signed: SignedPayload,
): VerifiedInteraction | undefined {
  if (!SignedPayload.isSigned(signed)) {
    return undefined;
  }
  const { payload } = signed;
  const id = field(payload, "id");
  const token = field(payload, "token");
  const guildId = field(payload, "guild_id");
  const channel = field(payload, "channel");
  const channelId = field(channel, "id");
  const channelType = field(channel, "type");
  // A token of "." or ".." would turn into path traversal in the request URL.
  if (
    !isSnowflake(id) ||
    !isSnowflake(guildId) ||
    !isSnowflake(channelId) ||
    typeof channelType !== "number" ||
    typeof token !== "string" ||
    token === "" ||
    token === "." ||
    token === ".."
  ) {
    return undefined;
  }

  let parentId: string | undefined;
  if (isThreadChannelType(channelType)) {
    const parent = field(channel, "parent_id");
    if (parent !== undefined && parent !== null) {
      if (!isSnowflake(parent)) {
        return undefined;
      }
      parentId = parent;
    }
  }

  return new VerifiedInteraction(MINT, {
    id,
    token,
    guildId,
    channelId,
    channelType,
    parentId,
  });
}
