/**
 * Builds every body the bot sends to Discord. Build bodies only with these
 * functions; never write one by hand.
 *
 * Message text must be `SafeText`, so user text is already escaped. Every message
 * goes through `messageFields`, which sets `allowed_mentions` to only the users and
 * roles the caller names (never @everyone) and turns off link previews.
 *
 * A "direct-response" cannot post anything others can see, so the endpoint may
 * return it as its HTTP response. A "checked-response" can, so it goes through the
 * REST client, which checks the channel is managed first.
 */

import { isSnowflake } from "../lib/snowflake.ts";
import { checkedWireJson } from "./body-check.ts";
import {
  DISCORD_LIMITS,
  isWithinLimit,
  plainTextValue,
  safeTextValue,
} from "./safe-text.ts";
import type { PlainText, SafeText } from "./safe-text.ts";

const SUPPRESS_EMBEDS_FLAG = 4;
const EPHEMERAL_FLAG = 64;

const ResponseType = {
  Pong: 1,
  ChannelMessage: 4,
  DeferredChannelMessage: 5,
  DeferredUpdate: 6,
  UpdateMessage: 7,
  AutocompleteResult: 8,
  Modal: 9,
} as const;

const ComponentType = {
  ActionRow: 1,
  Button: 2,
  StringSelect: 3,
  TextInput: 4,
  RoleSelect: 6,
  ChannelSelect: 8,
} as const;

const ButtonStyle = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4,
} as const;
const TextInputStyle = { short: 1, paragraph: 2 } as const;

// Printable ASCII only, so that a custom ID cannot carry hidden or display text.
const COMPONENT_ID = /^[\x21-\x7e]+$/;

export type OutboundKind =
  | "channel-message"
  | "message-edit"
  | "direct-response"
  | "checked-response"
  | "follow-up"
  | "thread-create";

/** Thrown for input Discord would reject. The message never repeats the input. */
export class OutboundBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundBodyError";
  }
}

function isEphemeralFirstPayload(payload: unknown): boolean {
  const { type, data } = payload as {
    type?: unknown;
    data?: { flags?: unknown };
  };
  const flags = data?.flags;
  return (
    (type === ResponseType.ChannelMessage ||
      type === ResponseType.DeferredChannelMessage) &&
    typeof flags === "number" &&
    (flags & EPHEMERAL_FLAG) === EPHEMERAL_FLAG
  );
}

/** Reads what will actually be sent, never `kind`. */
function isDirectPayload(payload: unknown): boolean {
  const { type } = payload as { type?: unknown };
  return (
    type === ResponseType.Pong ||
    type === ResponseType.DeferredUpdate ||
    type === ResponseType.AutocompleteResult ||
    type === ResponseType.Modal ||
    isEphemeralFirstPayload(payload)
  );
}

// A type-only mark that only the builders in this file set, so that a body or part
// written by hand needs an explicit `as` to pass for one.
declare const built: unique symbol;

/** A body ready to send. `payload` is the JSON Discord receives. */
export interface OutboundBody<K extends OutboundKind> {
  readonly kind: K;
  readonly payload: object;
  readonly [built]: true;
}

function body<K extends OutboundKind>(
  kind: K,
  payload: object,
): OutboundBody<K> {
  return { kind, payload } as OutboundBody<K>;
}

/**
 * True only for a body that cannot post anything others can see: a pong, an
 * ephemeral first response, autocomplete results, a modal, or an acknowledgement
 * that changes nothing. Reads the payload, never `kind`.
 */
export function isSilentResponse(
  response: OutboundBody<"direct-response" | "checked-response">,
): boolean {
  return isDirectPayload(response.payload);
}

/**
 * For the endpoint's HTTP response, which runs no managed channel check. Throws unless
 * `isSilentResponse` holds for the body and it passes the same check the REST client
 * makes before every send. Both read the JSON that is returned, not the payload object.
 * `guildId` is the signed interaction's guild, or undefined for Discord's ping.
 */
export function serializeDirectResponse(
  response: OutboundBody<"direct-response">,
  guildId: string | undefined,
): string {
  const checked = checkedWireJson(response.payload, guildId);
  if (!checked.ok) {
    throw new OutboundBodyError(`Refused a response: ${checked.reason}`);
  }
  if (!isDirectPayload(checked.wire)) {
    throw new OutboundBodyError(
      "Refused a response that could post publicly without the managed check",
    );
  }
  return checked.json;
}

/**
 * True only for a first response that Discord shows to the invoking user alone.
 * Reads the payload, never `kind`. Updates and follow-ups never qualify.
 */
export function isEphemeralInitialResponse(
  response: OutboundBody<"direct-response" | "checked-response">,
): boolean {
  return isEphemeralFirstPayload(response.payload);
}

type PartKind = "button" | "select" | "row" | "modal-row";

/** A piece of a message or modal layout, made by the builders below. */
export interface Part<K extends PartKind> {
  readonly kind: K;
  readonly component: object;
  readonly [built]: true;
}

function part<K extends PartKind>(kind: K, component: object): Part<K> {
  return { kind, component } as Part<K>;
}

function componentId(value: string, limit: number): string {
  if (
    value === "" ||
    !COMPONENT_ID.test(value) ||
    !isWithinLimit(value, limit)
  ) {
    throw new OutboundBodyError(
      `A component ID or value must be 1 to ${String(limit)} printable ASCII characters`,
    );
  }
  return value;
}

function label(text: PlainText, limit: number, field: string): string {
  const value = plainTextValue(text);
  if (value.trim() === "" || !isWithinLimit(value, limit)) {
    throw new OutboundBodyError(
      `${field} must be 1 to ${String(limit)} characters`,
    );
  }
  return value;
}

export interface ButtonInput {
  readonly customId: string;
  readonly label: PlainText;
  readonly style?: keyof typeof ButtonStyle;
  readonly disabled?: boolean;
}

/** Link buttons are left out on purpose: no message should carry a user's URL. */
export function button(input: ButtonInput): Part<"button"> {
  return part("button", {
    type: ComponentType.Button,
    style: ButtonStyle[input.style ?? "secondary"],
    custom_id: componentId(input.customId, DISCORD_LIMITS.customId),
    label: label(input.label, DISCORD_LIMITS.buttonLabel, "A button label"),
    disabled: input.disabled === true,
  });
}

export interface SelectOption {
  readonly label: PlainText;
  readonly value: string;
}

export function stringSelect(input: {
  readonly customId: string;
  readonly placeholder?: PlainText;
  readonly options: readonly SelectOption[];
}): Part<"select"> {
  const { options } = input;
  if (options.length === 0 || options.length > DISCORD_LIMITS.selectOptions) {
    throw new OutboundBodyError(
      `A select needs 1 to ${String(DISCORD_LIMITS.selectOptions)} options`,
    );
  }
  return part("select", {
    type: ComponentType.StringSelect,
    custom_id: componentId(input.customId, DISCORD_LIMITS.customId),
    ...placeholder(input.placeholder),
    options: options.map((option) => ({
      label: label(
        option.label,
        DISCORD_LIMITS.selectOptionLabel,
        "An option label",
      ),
      value: componentId(option.value, DISCORD_LIMITS.selectOptionValue),
    })),
  });
}

function placeholder(text: PlainText | undefined) {
  return text === undefined
    ? {}
    : {
        placeholder: label(
          text,
          DISCORD_LIMITS.selectPlaceholder,
          "A placeholder",
        ),
      };
}

export function channelSelect(input: {
  readonly customId: string;
  readonly channelTypes: readonly number[];
  readonly placeholder?: PlainText;
}): Part<"select"> {
  return part("select", {
    type: ComponentType.ChannelSelect,
    custom_id: componentId(input.customId, DISCORD_LIMITS.customId),
    channel_types: [...input.channelTypes],
    ...placeholder(input.placeholder),
  });
}

export function roleSelect(input: {
  readonly customId: string;
  readonly placeholder?: PlainText;
}): Part<"select"> {
  return part("select", {
    type: ComponentType.RoleSelect,
    custom_id: componentId(input.customId, DISCORD_LIMITS.customId),
    ...placeholder(input.placeholder),
  });
}

/** Up to five buttons, or exactly one select. */
export function actionRow(
  ...items: readonly Part<"button">[] | readonly [Part<"select">]
): Part<"row"> {
  const components = items.map((item) => item.component);
  const isOneSelect =
    items.length === 1 && items.every((item) => item.kind === "select");
  const isButtons =
    items.length >= 1 &&
    items.length <= DISCORD_LIMITS.buttonsPerRow &&
    items.every((item) => item.kind === "button");
  if (!isOneSelect && !isButtons) {
    throw new OutboundBodyError(
      `A row holds 1 to ${String(DISCORD_LIMITS.buttonsPerRow)} buttons or one select`,
    );
  }
  return part("row", { type: ComponentType.ActionRow, components });
}

export function textInputRow(input: {
  readonly customId: string;
  readonly label: PlainText;
  readonly style?: keyof typeof TextInputStyle;
  readonly required?: boolean;
  readonly maxLength?: number;
}): Part<"modal-row"> {
  return part("modal-row", {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.TextInput,
        custom_id: componentId(input.customId, DISCORD_LIMITS.customId),
        label: label(
          input.label,
          DISCORD_LIMITS.textInputLabel,
          "A text input label",
        ),
        style: TextInputStyle[input.style ?? "short"],
        required: input.required !== false,
        ...(input.maxLength === undefined
          ? {}
          : { max_length: input.maxLength }),
      },
    ],
  });
}

export interface MessageInput {
  readonly content: SafeText;
  /** The only users this message may ping. Pass an empty list for nobody. */
  readonly mentionUserIds: readonly string[];
  /**
   * The only roles this message may ping. Left out, it pings none. Each ID must come
   * from the signed guild's config row, and `roleGuildId` must name that guild.
   */
  readonly mentionRoleIds?: readonly string[];
  /**
   * The guild of `mentionRoleIds`, needed with any role. A role whose ID equals it is
   * @everyone, which is always refused.
   */
  readonly roleGuildId?: string;
  readonly components?: readonly Part<"row">[];
}

export interface ThreadInput extends MessageInput {
  readonly name: PlainText;
}

function rows(parts: readonly Part<"row" | "modal-row">[]): unknown[] {
  if (parts.length > DISCORD_LIMITS.actionRows) {
    throw new OutboundBodyError(
      `A message or modal holds at most ${String(DISCORD_LIMITS.actionRows)} rows`,
    );
  }
  return parts.map((row) => row.component);
}

/** The roles a message may ping. Throws for any role that could reach everyone. */
function mentionedRoles(
  roleIds: readonly string[] | undefined,
  guildId: string | undefined,
): string[] {
  if (roleIds === undefined || roleIds.length === 0) {
    return [];
  }
  if (!isSnowflake(guildId)) {
    throw new OutboundBodyError("A role mention needs the guild it belongs to");
  }
  if (!roleIds.every(isSnowflake)) {
    throw new OutboundBodyError("Every mentioned role must be a Discord ID");
  }
  if (roleIds.includes(guildId)) {
    throw new OutboundBodyError("A message cannot mention @everyone");
  }
  const roles = [...new Set(roleIds)];
  if (roles.length > DISCORD_LIMITS.mentionedRoles) {
    throw new OutboundBodyError(
      `A message can mention at most ${String(DISCORD_LIMITS.mentionedRoles)} roles, got ${String(roles.length)}`,
    );
  }
  return roles;
}

function messageFields(
  {
    content,
    mentionUserIds,
    mentionRoleIds,
    roleGuildId,
    components,
  }: MessageInput,
  extraFlags = 0,
) {
  const text = safeTextValue(content);
  if (text.trim() === "" || !isWithinLimit(text, DISCORD_LIMITS.content)) {
    throw new OutboundBodyError(
      `Message content must be 1 to ${String(DISCORD_LIMITS.content)} characters, got ${String(text.length)}`,
    );
  }
  if (!mentionUserIds.every(isSnowflake)) {
    throw new OutboundBodyError("Every mentioned user must be a Discord ID");
  }
  const users = [...new Set(mentionUserIds)];
  if (users.length > DISCORD_LIMITS.mentionedUsers) {
    throw new OutboundBodyError(
      `A message can mention at most ${String(DISCORD_LIMITS.mentionedUsers)} users, got ${String(users.length)}`,
    );
  }
  const roles = mentionedRoles(mentionRoleIds, roleGuildId);
  return {
    content: text,
    allowed_mentions:
      roles.length === 0 ? { parse: [], users } : { parse: [], users, roles },
    flags: SUPPRESS_EMBEDS_FLAG | extraFlags,
    ...(components === undefined ? {} : { components: rows(components) }),
  };
}

export function channelMessage(
  input: MessageInput,
): OutboundBody<"channel-message"> {
  return body("channel-message", messageFields(input));
}

/** For an edit to a channel message or to the original interaction reply. */
export function messageEdit(input: MessageInput): OutboundBody<"message-edit"> {
  return body("message-edit", messageFields(input));
}

/** A new forum post, whose first message is nested in the thread body. */
export function threadCreate(
  input: ThreadInput,
): OutboundBody<"thread-create"> {
  return body("thread-create", {
    name: label(input.name, DISCORD_LIMITS.threadName, "A thread name"),
    message: messageFields(input),
  });
}

function direct(type: number, data?: object): OutboundBody<"direct-response"> {
  return body(
    "direct-response",
    data === undefined ? { type } : { type, data },
  );
}

function checked(
  type: number,
  data?: object,
): OutboundBody<"checked-response"> {
  return body(
    "checked-response",
    data === undefined ? { type } : { type, data },
  );
}

/** Answers Discord's endpoint check. */
export function pong(): OutboundBody<"direct-response"> {
  return direct(ResponseType.Pong);
}

/** A reply everyone in the channel can see. */
export function interactionReply(
  input: MessageInput,
): OutboundBody<"checked-response"> {
  return checked(ResponseType.ChannelMessage, messageFields(input));
}

/** A reply only the invoking user can see. */
export function ephemeralReply(
  input: MessageInput,
): OutboundBody<"direct-response"> {
  return direct(
    ResponseType.ChannelMessage,
    messageFields(input, EPHEMERAL_FLAG),
  );
}

/** Acknowledges now. The reply that follows is public. */
export function deferredReply(): OutboundBody<"checked-response"> {
  return checked(ResponseType.DeferredChannelMessage);
}

/** Acknowledges now. The reply that follows is seen by the invoking user alone. */
export function deferredEphemeralReply(): OutboundBody<"direct-response"> {
  return direct(ResponseType.DeferredChannelMessage, {
    flags: EPHEMERAL_FLAG,
  });
}

/** Acknowledges a component and changes nothing. Any later edit is checked. */
export function deferredUpdate(): OutboundBody<"direct-response"> {
  return direct(ResponseType.DeferredUpdate);
}

/** Replaces the message a component is attached to, which others may see. */
export function updateMessage(
  input: MessageInput,
): OutboundBody<"checked-response"> {
  return checked(ResponseType.UpdateMessage, messageFields(input));
}

export interface AutocompleteChoice {
  readonly name: PlainText;
  readonly value: string;
}

export function autocompleteResult(
  choices: readonly AutocompleteChoice[],
): OutboundBody<"direct-response"> {
  if (choices.length > DISCORD_LIMITS.autocompleteChoices) {
    throw new OutboundBodyError(
      `Autocomplete allows at most ${String(DISCORD_LIMITS.autocompleteChoices)} choices`,
    );
  }
  return direct(ResponseType.AutocompleteResult, {
    choices: choices.map((choice) => ({
      name: label(
        choice.name,
        DISCORD_LIMITS.autocompleteChoiceName,
        "A choice name",
      ),
      value: componentId(choice.value, DISCORD_LIMITS.autocompleteChoiceValue),
    })),
  });
}

export function modal(input: {
  readonly customId: string;
  readonly title: PlainText;
  readonly rows: readonly Part<"modal-row">[];
}): OutboundBody<"direct-response"> {
  if (input.rows.length === 0) {
    throw new OutboundBodyError("A modal needs at least one text input");
  }
  return direct(ResponseType.Modal, {
    custom_id: componentId(input.customId, DISCORD_LIMITS.customId),
    title: label(input.title, DISCORD_LIMITS.modalTitle, "A modal title"),
    components: rows(input.rows),
  });
}

/** A further message after the first response. Always goes through the check. */
export function followUp(
  input: MessageInput & { readonly ephemeral?: boolean },
): OutboundBody<"follow-up"> {
  return body(
    "follow-up",
    messageFields(input, input.ephemeral === true ? EPHEMERAL_FLAG : 0),
  );
}
