/**
 * Parsing for interaction payloads, checked with Zod schemas. Payloads are only
 * inspected after their signature has passed, but the parsers still check each
 * field they vouch for, so a change on Discord's side ends in a refusal and not a
 * crash.
 *
 * Each parser types exactly the fields it checked. Anything else on the payload
 * stays unknown until a parser has looked at it.
 */

import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  InteractionType,
} from "discord-api-types/v10";
import { z } from "zod";
import { parsePermissions } from "../lib/actor.ts";
import { isSnowflake } from "../lib/snowflake.ts";
import { DISCORD_LIMITS } from "./safe-text.ts";

export interface GuildAccessPolicy {
  applicationId: string;
  allowedGuildIds: ReadonlySet<string>;
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

const EPHEMERAL_FLAG = 64;

const Snowflake = z.string().refine(isSnowflake);
/** Any JSON object. Arrays and null are refused. */
const AnyObject = z.looseObject({});

// Loose objects keep the fields a later step reads, such as the member's roles and
// the command's options and resolved data.
const Guild = z.looseObject({
  application_id: Snowflake,
  guild_id: Snowflake,
  context: z.literal(InteractionContextType.Guild),
  authorizing_integration_owners: z.object({
    [ApplicationIntegrationType.GuildInstall]: z.unknown().optional(),
  }),
  member: z.looseObject({ user: z.object({ id: Snowflake }) }),
});
export type GuildInteraction = z.infer<typeof Guild>;

const ChatInputData = z.looseObject({
  type: z.literal(ApplicationCommandType.ChatInput),
  name: z.string(),
});
const ChatInput = z.object({
  type: z.literal(InteractionType.ApplicationCommand),
  data: ChatInputData,
});
export type ChatInputCommand = z.infer<typeof ChatInput>;

const Autocomplete = z.object({
  type: z.literal(InteractionType.ApplicationCommandAutocomplete),
  data: ChatInputData,
});
export type AutocompleteRequest = z.infer<typeof Autocomplete>;

const CustomIdData = z.object({ custom_id: z.string() });
const Component = z.object({
  type: z.literal(InteractionType.MessageComponent),
  data: CustomIdData,
});
export type ComponentInteraction = z.infer<typeof Component>;

const Modal = z.object({
  type: z.literal(InteractionType.ModalSubmit),
  data: CustomIdData,
});
export type ModalInteraction = z.infer<typeof Modal>;

const WithData = z.object({ data: z.unknown().optional() });
const WithOptions = z.object({
  options: z.array(z.unknown()).max(DISCORD_LIMITS.commandOptions),
});
const Subcommand = z.looseObject({
  type: z.literal(ApplicationCommandOptionType.Subcommand),
});
const SubcommandGroup = z.object({
  type: z.literal(ApplicationCommandOptionType.SubcommandGroup),
});
const NamedOption = z.looseObject({ name: z.string() });
const FocusedFlag = z.object({ focused: z.literal(true) });
const FocusedValue = z.object({ name: z.string(), value: z.string() });
export type FocusedOption = z.infer<typeof FocusedValue>;

const WithResolved = z.object({
  data: z.object({
    resolved: z.object({
      roles: z.unknown().optional(),
      channels: z.unknown().optional(),
      users: z.unknown().optional(),
      members: z.unknown().optional(),
    }),
  }),
});
const RoleEntry = z.object({
  id: z.string(),
  name: z.string(),
  managed: z.boolean(),
  position: z.number(),
  permissions: z.unknown().optional(),
});
const ChannelEntry = z.object({
  id: z.string(),
  type: z.number(),
  guild_id: Snowflake.optional(),
  app_permissions: z.unknown().optional(),
});
const UserEntry = z.object({
  id: z.string(),
  bot: z.unknown().optional(),
  system: z.unknown().optional(),
});

const SelectValues = z.object({
  values: z.array(z.string()).max(DISCORD_LIMITS.selectOptions),
});
const ComponentTypeData = z.object({ component_type: z.number() });
const EphemeralFlags = z.object({ message: z.object({ flags: z.number() }) });

/** Returns undefined for anything that is not UTF-8 encoded JSON. */
export function parseInteractionBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return undefined;
  }
}

export function isPingInteraction(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === InteractionType.Ping
  );
}

/**
 * The interaction, if it is for this application, from a member inside an allowed
 * server, and the server itself installed the application.
 */
export function parseAllowedGuildInteraction(
  value: unknown,
  { applicationId, allowedGuildIds }: GuildAccessPolicy,
): GuildInteraction | undefined {
  const parsed = Guild.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const guild = parsed.data;
  const allowed =
    guild.application_id === applicationId &&
    allowedGuildIds.has(guild.guild_id) &&
    guild.authorizing_integration_owners[
      ApplicationIntegrationType.GuildInstall
    ] === guild.guild_id;
  return allowed ? guild : undefined;
}

export function parseChatInputCommand(
  value: unknown,
): ChatInputCommand | undefined {
  return ChatInput.safeParse(value).data;
}

export function parseAutocompleteRequest(
  value: unknown,
): AutocompleteRequest | undefined {
  return Autocomplete.safeParse(value).data;
}

export function parseComponentInteraction(
  value: unknown,
): ComponentInteraction | undefined {
  return Component.safeParse(value).data;
}

export function parseModalInteraction(
  value: unknown,
): ModalInteraction | undefined {
  return Modal.safeParse(value).data;
}

function dataOf(payload: unknown): unknown {
  return WithData.safeParse(payload).data?.data;
}

/** The options of a command or subcommand, or none if they are malformed. */
function optionList(container: unknown): readonly unknown[] {
  return WithOptions.safeParse(container).data?.options ?? [];
}

function subcommandOf(data: unknown): Record<string, unknown> | undefined {
  const [first] = optionList(data);
  return Subcommand.safeParse(first).data;
}

/**
 * The name a command is routed by: `name`, or `name sub` for a subcommand. A
 * subcommand group gets undefined, because the bot registers none.
 */
export function commandPath(
  command: ChatInputCommand | AutocompleteRequest,
): string | undefined {
  const [first] = optionList(command.data);
  if (SubcommandGroup.safeParse(first).success) {
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
  const matches = leafOptions(dataOf(payload)).flatMap((option) => {
    const named = NamedOption.safeParse(option).data;
    return named?.name === name ? [named] : [];
  });
  const [only] = matches;
  return matches.length === 1 && only?.type === type ? only.value : undefined;
}

/** The option being typed in an autocomplete request. */
export function focusedOption(payload: unknown): FocusedOption | undefined {
  const focused = leafOptions(dataOf(payload)).filter(
    (option) => FocusedFlag.safeParse(option).success,
  );
  const [only] = focused;
  return focused.length === 1 ? FocusedValue.safeParse(only).data : undefined;
}

/**
 * An entry of a map in `data.resolved`. The ID must have the shape of a Discord ID
 * and the entry must be the map's own, so `__proto__` and `constructor` find nothing.
 */
function ownEntry(map: unknown, id: string): unknown {
  if (!isSnowflake(id) || !AnyObject.safeParse(map).success) {
    return undefined;
  }
  const entries = map as Record<string, unknown>;
  return Object.hasOwn(entries, id) ? entries[id] : undefined;
}

function resolvedOf(payload: unknown) {
  return WithResolved.safeParse(payload).data?.data.resolved;
}

export function resolvedRole(
  payload: unknown,
  id: string,
): ResolvedRole | undefined {
  const entry = RoleEntry.safeParse(
    ownEntry(resolvedOf(payload)?.roles, id),
  ).data;
  const permissions = parsePermissions(entry?.permissions);
  if (entry?.id !== id || permissions === undefined) {
    return undefined;
  }
  const { name, managed, position } = entry;
  return { id, name, managed, position, permissions };
}

export function resolvedChannel(
  payload: unknown,
  id: string,
): ResolvedChannel | undefined {
  const entry = ChannelEntry.safeParse(
    ownEntry(resolvedOf(payload)?.channels, id),
  ).data;
  if (entry?.id !== id) {
    return undefined;
  }
  const appPermissions = parsePermissions(entry.app_permissions);
  // Present but malformed is not the same as absent, so it refuses the entry.
  if (entry.app_permissions !== undefined && appPermissions === undefined) {
    return undefined;
  }
  return { id, type: entry.type, guildId: entry.guild_id, appPermissions };
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
  const resolved = resolvedOf(payload);
  const user = UserEntry.safeParse(ownEntry(resolved?.users, id)).data;
  if (user?.id !== id) {
    return undefined;
  }
  return {
    id,
    isMember: AnyObject.safeParse(ownEntry(resolved?.members, id)).success,
    isBot: isSetFlag(user.bot) || isSetFlag(user.system),
  };
}

/** What a select submitted, or undefined if it is not a short list of strings. */
export function selectedValues(
  payload: unknown,
): readonly string[] | undefined {
  return SelectValues.safeParse(dataOf(payload)).data?.values;
}

export function isComponentType(payload: unknown, type: number): boolean {
  return (
    ComponentTypeData.safeParse(dataOf(payload)).data?.component_type === type
  );
}

/**
 * Whether the message a component sits on is seen by its viewer alone. The router's
 * deferred updates edit that message, so they must not run on a public one.
 */
export function isOnEphemeralMessage(payload: unknown): boolean {
  const flags = EphemeralFlags.safeParse(payload).data?.message.flags;
  return flags !== undefined && (flags & EPHEMERAL_FLAG) === EPHEMERAL_FLAG;
}
