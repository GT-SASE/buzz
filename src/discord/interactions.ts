/**
 * Parsing and type guards for interaction payloads. Payloads are only inspected
 * after their signature has passed, but the guards still check each field they
 * vouch for, so a change on Discord's side ends in a refusal and not a crash.
 *
 * Each guard narrows to exactly the fields it checked. Anything else on the
 * payload stays unknown until a guard has looked at it.
 */

import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  InteractionType,
} from "discord-api-types/v10";
import { parsePermissions } from "../lib/actor.ts";
import { isSnowflake } from "../lib/snowflake.ts";

export interface PingInteraction {
  type: InteractionType.Ping;
}

export interface GuildInteraction {
  application_id: string;
  guild_id: string;
  context: InteractionContextType.Guild;
  authorizing_integration_owners: {
    [ApplicationIntegrationType.GuildInstall]: string;
  };
  member: { user: { id: string } };
}

export interface GuildAccessPolicy {
  applicationId: string;
  allowedGuildIds: ReadonlySet<string>;
}

export interface ChatInputCommand {
  type: InteractionType.ApplicationCommand;
  data: { type: ApplicationCommandType.ChatInput; name: string };
}

export interface AutocompleteRequest {
  type: InteractionType.ApplicationCommandAutocomplete;
  data: { type: ApplicationCommandType.ChatInput; name: string };
}

export interface ComponentInteraction {
  type: InteractionType.MessageComponent;
  data: { custom_id: string };
}

export interface ModalInteraction {
  type: InteractionType.ModalSubmit;
  data: { custom_id: string };
}

/** A role from `resolved`, with its name still untrusted text. */
export interface ResolvedRole {
  readonly id: string;
  readonly name: string;
  readonly managed: boolean;
  readonly position: number;
  readonly permissions: bigint;
}

/** A channel from `resolved`. Discord does not always include the guild. */
export interface ResolvedChannel {
  readonly id: string;
  readonly type: number;
  readonly guildId: string | undefined;
  /** The app's permissions in this channel, if Discord included them. */
  readonly appPermissions: bigint | undefined;
}

/**
 * A person from `resolved`. Discord lists a user who is not in the guild under
 * `users` only, so finding them under `members` too is what shows they belong here.
 * Nothing else is read from either entry: names and nicknames are never rendered.
 */
export interface ResolvedPerson {
  readonly id: string;
  readonly isMember: boolean;
  readonly isBot: boolean;
}

export interface FocusedOption {
  readonly name: string;
  readonly value: string;
}

const EPHEMERAL_FLAG = 64;
const MAX_OPTIONS = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns undefined for anything that is not UTF-8 encoded JSON. */
export function parseInteractionBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return undefined;
  }
}

export function isPingInteraction(value: unknown): value is PingInteraction {
  return isRecord(value) && value.type === InteractionType.Ping;
}

/**
 * The interaction is for this application, from a member inside an allowed
 * server, and the server itself installed the application.
 */
export function isAllowedGuildInteraction(
  value: unknown,
  { applicationId, allowedGuildIds }: GuildAccessPolicy,
): value is GuildInteraction {
  return (
    isRecord(value) &&
    isSnowflake(value.application_id) &&
    value.application_id === applicationId &&
    isSnowflake(value.guild_id) &&
    allowedGuildIds.has(value.guild_id) &&
    value.context === InteractionContextType.Guild &&
    isRecord(value.authorizing_integration_owners) &&
    value.authorizing_integration_owners[
      ApplicationIntegrationType.GuildInstall
    ] === value.guild_id &&
    isRecord(value.member) &&
    isRecord(value.member.user) &&
    isSnowflake(value.member.user.id)
  );
}

export function isChatInputCommand(value: unknown): value is ChatInputCommand {
  return (
    isRecord(value) &&
    value.type === InteractionType.ApplicationCommand &&
    isRecord(value.data) &&
    value.data.type === ApplicationCommandType.ChatInput &&
    typeof value.data.name === "string"
  );
}

export function isAutocompleteRequest(
  value: unknown,
): value is AutocompleteRequest {
  return (
    isRecord(value) &&
    value.type === InteractionType.ApplicationCommandAutocomplete &&
    isRecord(value.data) &&
    value.data.type === ApplicationCommandType.ChatInput &&
    typeof value.data.name === "string"
  );
}

function hasCustomId(value: Record<string, unknown>): boolean {
  return isRecord(value.data) && typeof value.data.custom_id === "string";
}

export function isComponentInteraction(
  value: unknown,
): value is ComponentInteraction {
  return (
    isRecord(value) &&
    value.type === InteractionType.MessageComponent &&
    hasCustomId(value)
  );
}

export function isModalInteraction(value: unknown): value is ModalInteraction {
  return (
    isRecord(value) &&
    value.type === InteractionType.ModalSubmit &&
    hasCustomId(value)
  );
}

function optionList(container: unknown): readonly unknown[] {
  const options = isRecord(container) ? container.options : undefined;
  return Array.isArray(options) && options.length <= MAX_OPTIONS ? options : [];
}

function subcommandOf(data: unknown): Record<string, unknown> | undefined {
  const [first] = optionList(data);
  return isRecord(first) &&
    first.type === ApplicationCommandOptionType.Subcommand
    ? first
    : undefined;
}

/**
 * The name a command is routed by: `name`, or `name sub` for a subcommand. A
 * subcommand group gets undefined, because the bot registers none.
 */
export function commandPath(
  command: ChatInputCommand | AutocompleteRequest,
): string | undefined {
  const [first] = optionList(command.data);
  if (
    isRecord(first) &&
    first.type === ApplicationCommandOptionType.SubcommandGroup
  ) {
    return undefined;
  }
  const subcommand = subcommandOf(command.data);
  if (subcommand === undefined) {
    return command.data.name;
  }
  return typeof subcommand.name === "string"
    ? `${command.data.name} ${subcommand.name}`
    : undefined;
}

function leafOptions(data: unknown): readonly unknown[] {
  return optionList(subcommandOf(data) ?? data);
}

/**
 * One option's value, if it has this name and type and appears once. An option the
 * caller does not ask for by name is never read, so extra ones change nothing.
 */
export function commandOptionValue(
  payload: unknown,
  name: string,
  type: ApplicationCommandOptionType,
): unknown {
  const data = isRecord(payload) ? payload.data : undefined;
  const matches = leafOptions(data).filter(
    (option) => isRecord(option) && option.name === name,
  );
  const [only] = matches;
  return matches.length === 1 && isRecord(only) && only.type === type
    ? only.value
    : undefined;
}

/** The option being typed in an autocomplete request. */
export function focusedOption(payload: unknown): FocusedOption | undefined {
  const data = isRecord(payload) ? payload.data : undefined;
  const focused = leafOptions(data).filter(
    (option) => isRecord(option) && option.focused === true,
  );
  const [only] = focused;
  return focused.length === 1 &&
    isRecord(only) &&
    typeof only.name === "string" &&
    typeof only.value === "string"
    ? { name: only.name, value: only.value }
    : undefined;
}

/**
 * An entry of `data.resolved`. The ID must have the shape of a Discord ID and the
 * entry must be the map's own, so `__proto__` and `constructor` find nothing.
 */
function resolvedEntry(
  payload: unknown,
  kind: "roles" | "channels",
  id: string,
): Record<string, unknown> | undefined {
  const data = isRecord(payload) ? payload.data : undefined;
  const resolved = isRecord(data) ? data.resolved : undefined;
  const entries = isRecord(resolved) ? resolved[kind] : undefined;
  if (!isSnowflake(id) || !isRecord(entries) || !Object.hasOwn(entries, id)) {
    return undefined;
  }
  const entry = entries[id];
  return isRecord(entry) && entry.id === id ? entry : undefined;
}

export function resolvedRole(
  payload: unknown,
  id: string,
): ResolvedRole | undefined {
  const entry = resolvedEntry(payload, "roles", id);
  if (entry === undefined) {
    return undefined;
  }
  const { name, managed, position } = entry;
  const permissions = parsePermissions(entry.permissions);
  return typeof name === "string" &&
    typeof managed === "boolean" &&
    typeof position === "number" &&
    permissions !== undefined
    ? { id, name, managed, position, permissions }
    : undefined;
}

export function resolvedChannel(
  payload: unknown,
  id: string,
): ResolvedChannel | undefined {
  const entry = resolvedEntry(payload, "channels", id);
  if (entry === undefined || typeof entry.type !== "number") {
    return undefined;
  }
  const guildId = entry.guild_id;
  if (guildId !== undefined && !isSnowflake(guildId)) {
    return undefined;
  }
  const appPermissions = parsePermissions(entry.app_permissions);
  // Present but malformed is not the same as absent, so it refuses the entry.
  if (entry.app_permissions !== undefined && appPermissions === undefined) {
    return undefined;
  }
  return { id, type: entry.type, guildId, appPermissions };
}

function ownEntry(
  map: unknown,
  id: string,
): Record<string, unknown> | undefined {
  if (!isRecord(map) || !Object.hasOwn(map, id)) {
    return undefined;
  }
  const entry = map[id];
  return isRecord(entry) ? entry : undefined;
}

/** Anything but absent or false counts, so an odd value refuses rather than allows. */
function isSetFlag(value: unknown): boolean {
  return value !== undefined && value !== false;
}

/** Undefined if the payload does not describe this ID as a user at all. */
export function resolvedPerson(
  payload: unknown,
  id: string,
): ResolvedPerson | undefined {
  const data = isRecord(payload) ? payload.data : undefined;
  const resolved = isRecord(data) ? data.resolved : undefined;
  if (!isSnowflake(id) || !isRecord(resolved)) {
    return undefined;
  }
  const user = ownEntry(resolved.users, id);
  if (user?.id !== id) {
    return undefined;
  }
  return {
    id,
    isMember: ownEntry(resolved.members, id) !== undefined,
    isBot: isSetFlag(user.bot) || isSetFlag(user.system),
  };
}

/** What a select submitted, or undefined if it is not a short list of strings. */
export function selectedValues(
  payload: unknown,
): readonly string[] | undefined {
  const data = isRecord(payload) ? payload.data : undefined;
  const values = isRecord(data) ? data.values : undefined;
  if (!Array.isArray(values) || values.length > MAX_OPTIONS) {
    return undefined;
  }
  const items: unknown[] = values;
  return items.every((item) => typeof item === "string") ? items : undefined;
}

export function isComponentType(payload: unknown, type: number): boolean {
  const data = isRecord(payload) ? payload.data : undefined;
  return isRecord(data) && data.component_type === type;
}

/**
 * Whether the message a component sits on is seen by its viewer alone. The router's
 * deferred updates edit that message, so they must not run on a public one.
 */
export function isOnEphemeralMessage(payload: unknown): boolean {
  const message = isRecord(payload) ? payload.message : undefined;
  const flags = isRecord(message) ? message.flags : undefined;
  return (
    typeof flags === "number" && (flags & EPHEMERAL_FLAG) === EPHEMERAL_FLAG
  );
}
