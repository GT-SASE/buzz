/**
 * The last check on a body before it reaches Discord, whatever built it. The REST client
 * and the interactions endpoint both send only what `checkedWireJson` returns.
 *
 * It reads the JSON exactly as it goes out: the body is serialized once, that string is
 * parsed back and checked, and the same string is sent. A `toJSON` or a getter on the
 * body therefore cannot show the check one thing and Discord another.
 */

import { isSnowflake } from "../lib/snowflake.ts";

/** Why a body was refused before it was sent. Fixed text, safe to log. */
export type UnsafeBodyReason =
  | "the body is not a JSON object"
  | "allowed_mentions missing"
  | "allowed_mentions parses mentions"
  | "allowed_mentions names a user that is not an ID"
  | "allowed_mentions names a role that is not an ID"
  | "allowed_mentions names @everyone as a role"
  | "allowed_mentions names a role with no guild to check it against"
  | "allowed_mentions pings the replied-to user"
  | "an embed"
  | "a link button or URL in the components"
  | "a live @everyone or @here in the components"
  | "a masked link in the components"
  | "a live @everyone or @here in the content"
  | "a masked link in the content";

// An @everyone or @here with no backslash before it, or with an even number of them,
// which escape each other and leave the @ live.
const LIVE_EVERYONE = /(?<!\\)(?:\\\\)*@(?:everyone|here)/u;
// The `](` that joins a masked link's text to its URL, unless the bracket is escaped.
const MASKED_LINK = /(?<!\\)(?:\\\\)*\]\s*\(/u;
const LINK_BUTTON_STYLE = 5;
const BUTTON_TYPE = 2;
const MODAL_RESPONSE_TYPE = 9;

// Any of these makes an object a message, which must then say who it may ping.
const MESSAGE_KEYS = [
  "content",
  "embeds",
  "components",
  "attachments",
  "sticker_ids",
  "poll",
  "allowed_mentions",
  "message_reference",
  "tts",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIdList(value: unknown): boolean {
  return (
    value === undefined || (Array.isArray(value) && value.every(isSnowflake))
  );
}

/** Why anything under the components is unsafe: every value at every depth is read. */
function unsafeComponents(value: unknown): UnsafeBodyReason | undefined {
  if (typeof value === "string") {
    if (LIVE_EVERYONE.test(value)) {
      return "a live @everyone or @here in the components";
    }
    return MASKED_LINK.test(value)
      ? "a masked link in the components"
      : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = unsafeComponents(item);
      if (reason !== undefined) {
        return reason;
      }
    }
    return undefined;
  }
  if (!isObject(value)) {
    return undefined;
  }
  if (
    "url" in value ||
    (value.type === BUTTON_TYPE && value.style === LINK_BUTTON_STYLE)
  ) {
    return "a link button or URL in the components";
  }
  return unsafeComponents(Object.values(value));
}

function unsafeMentions(
  mentions: unknown,
  guildId: string | undefined,
): UnsafeBodyReason | undefined {
  if (!isObject(mentions)) {
    return "allowed_mentions missing";
  }
  if (!Array.isArray(mentions.parse) || mentions.parse.length > 0) {
    return "allowed_mentions parses mentions";
  }
  if (!isIdList(mentions.users)) {
    return "allowed_mentions names a user that is not an ID";
  }
  if (!isIdList(mentions.roles)) {
    return "allowed_mentions names a role that is not an ID";
  }
  if (mentions.replied_user !== undefined && mentions.replied_user !== false) {
    return "allowed_mentions pings the replied-to user";
  }
  const roles = Array.isArray(mentions.roles) ? mentions.roles : [];
  if (roles.length > 0 && guildId === undefined) {
    return "allowed_mentions names a role with no guild to check it against";
  }
  if (roles.includes(guildId)) {
    return "allowed_mentions names @everyone as a role";
  }
  return undefined;
}

/**
 * Checks one object that may be a message. `modal` is for a modal's data, which has
 * components but posts nothing, so it needs no allowed_mentions.
 */
function unsafeMessage(
  message: Record<string, unknown>,
  guildId: string | undefined,
  modal: boolean,
): UnsafeBodyReason | undefined {
  const isMessage = !modal && MESSAGE_KEYS.some((key) => key in message);
  if (isMessage) {
    const reason = unsafeMentions(message.allowed_mentions, guildId);
    if (reason !== undefined) {
      return reason;
    }
  }
  if ("embeds" in message) {
    return "an embed";
  }
  const inComponents = unsafeComponents(message.components);
  if (inComponents !== undefined) {
    return inComponents;
  }
  const content = message.content;
  if (typeof content === "string") {
    if (LIVE_EVERYONE.test(content)) {
      return "a live @everyone or @here in the content";
    }
    if (MASKED_LINK.test(content)) {
      return "a masked link in the content";
    }
  }
  return undefined;
}

/**
 * Why this payload must not be sent to this guild, or undefined if it may. It reads a
 * message at the top level, in a forum post's `message`, and in an interaction
 * response's `data`. `guildId` is undefined only where there is no guild, such as the
 * endpoint's answer to Discord's ping, and then no role may be named.
 */
export function unsafeBodyReason(
  payload: unknown,
  guildId: string | undefined,
): UnsafeBodyReason | undefined {
  if (!isObject(payload) || Array.isArray(payload)) {
    return "the body is not a JSON object";
  }
  const modal = payload.type === MODAL_RESPONSE_TYPE;
  const candidates: [unknown, boolean][] = [
    [payload, false],
    [payload.message, false],
    [payload.data, modal],
  ];
  for (const [message, isModal] of candidates) {
    if (isObject(message)) {
      const reason = unsafeMessage(message, guildId, isModal);
      if (reason !== undefined) {
        return reason;
      }
    }
  }
  return undefined;
}

export type WireJson =
  | { readonly ok: true; readonly json: string; readonly wire: object }
  | { readonly ok: false; readonly reason: UnsafeBodyReason };

/**
 * Serializes the payload once and checks what that string parses back to. Send `json`,
 * and read anything else about the body from `wire`, never from the payload.
 */
export function checkedWireJson(
  payload: unknown,
  guildId: string | undefined,
): WireJson {
  let json: unknown;
  try {
    json = JSON.stringify(payload);
  } catch {
    return { ok: false, reason: "the body is not a JSON object" };
  }
  if (typeof json !== "string") {
    return { ok: false, reason: "the body is not a JSON object" };
  }
  const wire: unknown = JSON.parse(json);
  const reason = unsafeBodyReason(wire, guildId);
  if (reason !== undefined || !isObject(wire)) {
    return { ok: false, reason: reason ?? "the body is not a JSON object" };
  }
  return { ok: true, json, wire };
}
