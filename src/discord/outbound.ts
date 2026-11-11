/**
 * Builds every body the bot sends to Discord, whether through the REST client or
 * as the endpoint's HTTP response.
 *
 * Message text only arrives as `SafeText`, so hostile text is inert before it gets
 * here. Every body with text sets `allowed_mentions` to exactly the users named by
 * the caller, and `SUPPRESS_EMBEDS` so that no link unfurls. Responses with no text
 * carry neither, and the edit that fills in a deferred response is built here too.
 *
 * `OutboundBody` is exported as a type only and is nominal through its private
 * field, so a plain object does not type-check in its place. Its constructor also
 * demands a key private to this module and refuses subclasses, so it cannot be
 * reached through `body.constructor`. Instances are frozen, and
 * `serializeOutboundBody` checks the body again at runtime.
 *
 * A response has one of two kinds. A "direct-response" cannot post anything others
 * can see, so the endpoint may return it as its HTTP response with no managed
 * channel check. A "checked-response" can, so it only goes through the REST client,
 * which runs the check.
 */

import { isSnowflake } from "../lib/snowflake.ts";
import {
  DISCORD_LIMITS,
  isWithinLimit,
  plainTextValue,
  safeTextValue,
} from "./safe-text.ts";
import type { PlainText, SafeText } from "./safe-text.ts";

const SUPPRESS_EMBEDS_FLAG = 4;
const EPHEMERAL_FLAG = 64;
const MINT = Symbol("OutboundBody");

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

class OutboundBody<K extends OutboundKind> {
  readonly kind: K;
  readonly #json: string;

  constructor(key: symbol, kind: K, payload: object) {
    if (key !== MINT || new.target !== OutboundBody) {
      throw new OutboundBodyError(
        "Outbound bodies can only be made by the outbound builders",
      );
    }
    this.kind = kind;
    this.#json = JSON.stringify(payload);
    Object.freeze(this);
  }

  /** Returns a copy, so that a caller cannot change what will be sent. */
  toJSON(): unknown {
    return JSON.parse(this.#json);
  }

  static serialize(body: object, expected: OutboundKind): string {
    if (!(#json in body) || body.kind !== expected) {
      throw new OutboundBodyError(
        `Refused a body that is not an outbound ${expected} body`,
      );
    }
    return body.#json;
  }

  static isSilent(body: object): boolean {
    return #json in body && isDirectPayload(JSON.parse(body.#json));
  }

  static serializeDirect(body: object): string {
    if (!OutboundBody.isSilent(body) || !(#json in body)) {
      throw new OutboundBodyError(
        "Refused a response that could post publicly without the managed check",
      );
    }
    return body.#json;
  }

  static isEphemeralInitialResponse(body: object): boolean {
    if (!(#json in body)) {
      return false;
    }
    return isEphemeralFirstPayload(JSON.parse(body.#json));
  }
}

Object.freeze(OutboundBody.prototype);
Object.freeze(OutboundBody);

export type { OutboundBody };

export function serializeOutboundBody<K extends OutboundKind>(
  body: OutboundBody<K>,
  expected: NoInfer<K>,
): string {
  return OutboundBody.serialize(body, expected);
}

/**
 * True only for a body that cannot post anything others can see: a pong, an
 * ephemeral first response, autocomplete results, a modal, or an acknowledgement
 * that changes nothing. Reads what will actually be sent, never `kind`.
 */
export function isSilentResponse(
  body: OutboundBody<"direct-response" | "checked-response">,
): boolean {
  return OutboundBody.isSilent(body);
}

/**
 * For the endpoint's HTTP response, which runs no managed channel check. Throws
 * unless `isSilentResponse` holds for the body.
 */
export function serializeDirectResponse(
  body: OutboundBody<"direct-response">,
): string {
  return OutboundBody.serializeDirect(body);
}

/**
 * True only for a first response to an interaction that Discord shows to the
 * invoking user alone. Reads what will actually be sent, never `kind`. Updates
 * (types 6 and 7) and follow-ups never qualify.
 */
export function isEphemeralInitialResponse(
  body: OutboundBody<"direct-response" | "checked-response">,
): boolean {
  return OutboundBody.isEphemeralInitialResponse(body);
}

type PartKind = "button" | "select" | "row" | "modal-row";

/** A piece of a message or modal layout, only made by the builders below. */
class Part<K extends PartKind> {
  readonly kind: K;
  readonly #payload: string;

  constructor(key: symbol, kind: K, payload: object) {
    if (key !== MINT || new.target !== Part) {
      throw new OutboundBodyError(
        "Components can only be made by the outbound builders",
      );
    }
    this.kind = kind;
    this.#payload = JSON.stringify(payload);
    Object.freeze(this);
  }

  static read(part: object, expected: readonly PartKind[]): unknown {
    if (!(#payload in part) || !expected.includes(part.kind)) {
      throw new OutboundBodyError("Refused a component not made here");
    }
    return JSON.parse(part.#payload);
  }
}

Object.freeze(Part.prototype);
Object.freeze(Part);

export type { Part };

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
  return new Part(MINT, "button", {
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
  return new Part(MINT, "select", {
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
  return new Part(MINT, "select", {
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
  return new Part(MINT, "select", {
    type: ComponentType.RoleSelect,
    custom_id: componentId(input.customId, DISCORD_LIMITS.customId),
    ...placeholder(input.placeholder),
  });
}

/** Up to five buttons, or exactly one select. */
export function actionRow(
  ...items: readonly Part<"button">[] | readonly [Part<"select">]
): Part<"row"> {
  const components = items.map((item) => Part.read(item, ["button", "select"]));
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
  return new Part(MINT, "row", { type: ComponentType.ActionRow, components });
}

export function textInputRow(input: {
  readonly customId: string;
  readonly label: PlainText;
  readonly style?: keyof typeof TextInputStyle;
  readonly required?: boolean;
  readonly maxLength?: number;
}): Part<"modal-row"> {
  return new Part(MINT, "modal-row", {
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
  readonly components?: readonly Part<"row">[];
}

export interface ThreadInput extends MessageInput {
  readonly name: PlainText;
}

function rows<K extends "row" | "modal-row">(
  parts: readonly Part<K>[],
  kind: K,
): unknown[] {
  if (parts.length > DISCORD_LIMITS.actionRows) {
    throw new OutboundBodyError(
      `A message or modal holds at most ${String(DISCORD_LIMITS.actionRows)} rows`,
    );
  }
  return parts.map((part) => Part.read(part, [kind]));
}

function messageFields(
  { content, mentionUserIds, components }: MessageInput,
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
  return {
    content: text,
    allowed_mentions: { parse: [], users },
    flags: SUPPRESS_EMBEDS_FLAG | extraFlags,
    ...(components === undefined
      ? {}
      : { components: rows(components, "row") }),
  };
}

export function channelMessage(
  input: MessageInput,
): OutboundBody<"channel-message"> {
  return new OutboundBody(MINT, "channel-message", messageFields(input));
}

/** For an edit to a channel message or to the original interaction reply. */
export function messageEdit(input: MessageInput): OutboundBody<"message-edit"> {
  return new OutboundBody(MINT, "message-edit", messageFields(input));
}

/** A new forum post, whose first message is nested in the thread body. */
export function threadCreate(
  input: ThreadInput,
): OutboundBody<"thread-create"> {
  return new OutboundBody(MINT, "thread-create", {
    name: label(input.name, DISCORD_LIMITS.threadName, "A thread name"),
    message: messageFields(input),
  });
}

function direct(type: number, data?: object): OutboundBody<"direct-response"> {
  return new OutboundBody(
    MINT,
    "direct-response",
    data === undefined ? { type } : { type, data },
  );
}

function checked(
  type: number,
  data?: object,
): OutboundBody<"checked-response"> {
  return new OutboundBody(
    MINT,
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
    components: rows(input.rows, "modal-row"),
  });
}

/** A further message after the first response. Always goes through the check. */
export function followUp(
  input: MessageInput & { readonly ephemeral?: boolean },
): OutboundBody<"follow-up"> {
  return new OutboundBody(
    MINT,
    "follow-up",
    messageFields(input, input.ephemeral === true ? EPHEMERAL_FLAG : 0),
  );
}
