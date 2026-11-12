/**
 * Builds interactions the way the endpoint receives them, and runs them through a
 * router with no network: Discord is a fake.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  InteractionContextType,
  InteractionType,
} from "discord-api-types/v10";
import type {
  DiscordClient,
  GuildChannel,
  GuildRole,
} from "../../src/discord/client.ts";
import {
  parseAllowedGuildInteraction,
  type GuildInteraction,
} from "../../src/discord/interactions.ts";
import {
  verifiedInteractionFrom,
  verifySignedRequest,
  type VerifiedInteraction,
} from "../../src/discord/verify.ts";
import type { Router, RouterDependencies } from "../../src/handlers/router.ts";
import type { DbClient } from "../../src/db/client.ts";
import { fakeId } from "./ids.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY_HEX = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");
const SIGNED_AT = "1700000000";

export const GUILD_ID = fakeId();
export const APP_ID = fakeId();
export const MEMBER_ID = fakeId();
export const OFFICER_ROLE = fakeId();
export const ADMIN_ROLE = fakeId();
export const ADMINISTRATOR_BIT = String(1n << 3n);
const EPHEMERAL_FLAG = 64;

export interface MemberFields {
  readonly id?: string;
  readonly roles?: readonly string[];
  readonly permissions?: string;
}

export function member({
  id = MEMBER_ID,
  roles = [],
  permissions = "0",
}: MemberFields = {}): Record<string, unknown> {
  return { user: { id }, roles, permissions };
}

export const ADMINISTRATOR = member({ permissions: ADMINISTRATOR_BIT });
export const ADMIN = member({ roles: [ADMIN_ROLE] });
export const OFFICER = member({ roles: [OFFICER_ROLE] });
export const PLAIN_MEMBER = member();

function base(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    id: fakeId(),
    token: "test-interaction-token",
    application_id: APP_ID,
    guild_id: GUILD_ID,
    channel: { id: fakeId(), type: 0 },
    context: InteractionContextType.Guild,
    authorizing_integration_owners: { "0": GUILD_ID },
    member: ADMINISTRATOR,
    ...fields,
  };
}

export function commandPayload(
  name: string,
  fields: Record<string, unknown> = {},
  data: Record<string, unknown> = {},
): Record<string, unknown> {
  return base({
    type: InteractionType.ApplicationCommand,
    data: { type: ApplicationCommandType.ChatInput, name, ...data },
    ...fields,
  });
}

export function componentPayload(
  customId: unknown,
  fields: Record<string, unknown> = {},
  data: Record<string, unknown> = {},
): Record<string, unknown> {
  return base({
    type: InteractionType.MessageComponent,
    message: { id: fakeId(), flags: EPHEMERAL_FLAG },
    data: { custom_id: customId, component_type: 2, ...data },
    ...fields,
  });
}

export function modalPayload(
  customId: unknown,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return base({
    type: InteractionType.ModalSubmit,
    data: { custom_id: customId },
    ...fields,
  });
}

export function autocompletePayload(
  name: string,
  typed: unknown,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return base({
    type: InteractionType.ApplicationCommandAutocomplete,
    data: {
      type: ApplicationCommandType.ChatInput,
      name,
      options: [{ name: "event", type: 3, value: typed, focused: true }],
    },
    ...fields,
  });
}

/** The /setup options, in the order the command asks for them. */
export const SETUP_OPTIONS = [
  "eboard_role",
  "events_directors_role",
  "events_committee_role",
  "treasury_role",
  "marketing_role",
] as const;

export type SetupOption = (typeof SETUP_OPTIONS)[number];

/** A /setup command choosing these roles, each also given in `resolved` as Discord does. */
export function setupCommandPayload(
  roles: Record<SetupOption, GuildRole>,
  fields: Record<string, unknown> = {},
  extraOptions: unknown[] = [],
): Record<string, unknown> {
  return commandPayload("setup", fields, {
    options: [
      ...SETUP_OPTIONS.map((name) => ({
        name,
        type: ApplicationCommandOptionType.Role,
        value: roles[name].id,
      })),
      ...extraOptions,
    ],
    resolved: {
      roles: Object.fromEntries(
        SETUP_OPTIONS.map((name) => [
          roles[name].id,
          { ...roles[name], permissions: String(roles[name].permissions) },
        ]),
      ),
    },
  });
}

/** The custom_id on the first button of a reply, such as /setup's Confirm. */
export function firstCustomId(
  edit: { components?: unknown[] } | undefined,
): string {
  const [row] = (edit?.components ?? []) as {
    components: { custom_id: string }[];
  }[];
  return row?.components[0]?.custom_id ?? "";
}

/** Passes the real signature check, which is the only way to get these two values. */
export function verify(payload: unknown): {
  interaction: GuildInteraction;
  verified: VerifiedInteraction;
} {
  const body = Buffer.from(JSON.stringify(payload));
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(SIGNED_AT), body]),
    privateKey,
  ).toString("hex");
  const signed = verifySignedRequest(
    { body, signature, timestamp: SIGNED_AT },
    PUBLIC_KEY_HEX,
    Number(SIGNED_AT) * 1000,
  );
  const verified = signed && verifiedInteractionFrom(signed);
  const interaction = parseAllowedGuildInteraction(signed?.payload, {
    applicationId: APP_ID,
    allowedGuildIds: new Set([GUILD_ID]),
  });
  if (verified === undefined || interaction === undefined) {
    throw new Error("Test payload was not accepted");
  }
  return { interaction, verified };
}

export interface ConfigRow {
  guild_id: string;
  officer_role_id: string;
  admin_role_id: string;
  eboard_role_id: string | null;
  events_committee_role_id: string | null;
  treasury_role_id: string | null;
  marketing_role_id: string | null;
  timezone: string;
  reminders_enabled: boolean;
  version: number;
}

export function configRow(fields: Partial<ConfigRow> = {}): ConfigRow {
  return {
    guild_id: GUILD_ID,
    officer_role_id: OFFICER_ROLE,
    admin_role_id: ADMIN_ROLE,
    eboard_role_id: null,
    events_committee_role_id: null,
    treasury_role_id: null,
    marketing_role_id: null,
    timezone: "America/New_York",
    reminders_enabled: true,
    version: 3,
    ...fields,
  };
}

export interface ChannelRow {
  guild_id: string;
  channel_id: string;
  status: "active" | "unavailable" | "removed";
}

export function managedRow(
  channelId: string,
  status: ChannelRow["status"] = "active",
): ChannelRow {
  return { guild_id: GUILD_ID, channel_id: channelId, status };
}

export interface ChangeRow {
  id: number;
  actor_id: string;
  action: string;
  old_values: unknown;
  new_values: unknown;
  version_after: number;
  created_at: string;
}

export interface DraftRow {
  guild_id: string;
  actor_id: string;
  officer_role_id: string;
  admin_role_id: string;
  eboard_role_id: string;
  events_committee_role_id: string;
  treasury_role_id: string;
  marketing_role_id: string;
  fingerprint: string;
  created_at: string;
}

export interface FakeDiscordData {
  roles?: readonly GuildRole[] | "fail";
  channels?: readonly GuildChannel[] | "fail";
  botRoleIds?: readonly string[] | "fail";
}

function orFail<T>(value: T | "fail"): Promise<T> {
  return value === "fail"
    ? Promise.reject(new Error("discord failure"))
    : Promise.resolve(value);
}

/** Records edits to the original reply, and refuses every way of posting elsewhere. */
export function fakeDiscord(data: FakeDiscordData = {}): {
  discord: DiscordClient;
  edits: { content: string; components?: unknown[]; flags: number }[];
} {
  const edits: { content: string; components?: unknown[]; flags: number }[] =
    [];
  const refuse = () =>
    Promise.reject(new Error("This route must not post to a channel"));
  const discord: DiscordClient = {
    getChannel: refuse,
    sendMessage: refuse,
    editMessage: refuse,
    reopenThread: refuse,
    createThread: refuse,
    replyToInteraction: refuse,
    editInteractionReply: refuse,
    sendFollowUp: refuse,
    respondEphemerally: refuse,
    editEphemeralReply: (_interaction, body) => {
      edits.push(body.payload as (typeof edits)[number]);
      return Promise.resolve({ id: fakeId() });
    },
    getGuildRoles: () => orFail(data.roles ?? []),
    getGuildChannels: () => orFail(data.channels ?? []),
    getGuildChannel: (_guildId, channelId) =>
      orFail(data.channels ?? []).then((channels) => {
        const found = channels.find((channel) => channel.id === channelId);
        return found ?? Promise.reject(new Error("discord failure"));
      }),
    getGuildMemberRoleIds: () => orFail(data.botRoleIds ?? []),
    describeChannel: () => Promise.reject(new Error("discord failure")),
    listActiveThreads: () => Promise.reject(new Error("discord failure")),
    listArchivedThreads: () => Promise.reject(new Error("discord failure")),
  };
  return { discord, edits };
}

export function dependenciesFor(
  db: DbClient,
  discord: DiscordClient,
): RouterDependencies {
  return { db: () => db, finishDb: () => db, discord: () => discord };
}

export interface Ran {
  /** What the endpoint would answer over HTTP. */
  reply: { type: number; data?: Record<string, unknown> };
  deferred: boolean;
}

/** Runs one interaction to the end, including the work done after the reply. */
export async function run(
  router: Router,
  payload: unknown,
  dependencies: RouterDependencies,
): Promise<Ran> {
  const { interaction, verified } = verify(payload);
  const outcome = await router.handle(interaction, verified, dependencies);
  await outcome.after?.();
  return {
    reply: outcome.reply.payload as Ran["reply"],
    deferred: outcome.after !== undefined,
  };
}
