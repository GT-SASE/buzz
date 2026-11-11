/**
 * Builds interactions the way the endpoint receives them, and runs them through a
 * router with no network: the database answers from memory and Discord is a fake.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import {
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
  isAllowedGuildInteraction,
  type GuildInteraction,
} from "../../src/discord/interactions.ts";
import {
  verifiedInteractionFrom,
  verifySignedRequest,
  type VerifiedInteraction,
} from "../../src/discord/verify.ts";
import type { Router, RouterDependencies } from "../../src/handlers/router.ts";
import type { DbClient } from "../../src/db/client.ts";
import {
  mockPostgrest,
  testSnowflake,
  type RecordedRequest,
} from "./mock-postgrest.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY_HEX = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");
const SIGNED_AT = "1700000000";

export const GUILD_ID = testSnowflake();
export const APP_ID = testSnowflake();
export const MEMBER_ID = testSnowflake();
export const OFFICER_ROLE = testSnowflake();
export const ADMIN_ROLE = testSnowflake();
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
    id: testSnowflake(),
    token: "test-interaction-token",
    application_id: APP_ID,
    guild_id: GUILD_ID,
    channel: { id: testSnowflake(), type: 0 },
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
    message: { id: testSnowflake(), flags: EPHEMERAL_FLAG },
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
  const interaction = signed?.payload;
  const verified = signed && verifiedInteractionFrom(signed);
  if (
    verified === undefined ||
    !isAllowedGuildInteraction(interaction, {
      applicationId: APP_ID,
      allowedGuildIds: new Set([GUILD_ID]),
    })
  ) {
    throw new Error("Test payload was not accepted");
  }
  return { interaction, verified };
}

export interface ConfigRow {
  guild_id: string;
  officer_role_id: string;
  admin_role_id: string;
  timezone: string;
  reminders_enabled: boolean;
  version: number;
}

export function configRow(fields: Partial<ConfigRow> = {}): ConfigRow {
  return {
    guild_id: GUILD_ID,
    officer_role_id: OFFICER_ROLE,
    admin_role_id: ADMIN_ROLE,
    timezone: "America/New_York",
    reminders_enabled: true,
    version: 3,
    ...fields,
  };
}

interface ChannelRow {
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

export interface DbState {
  config: ConfigRow | null;
  channels: ChannelRow[];
  changes: ChangeRow[];
  /** Task rows for the open-task count, by channel. */
  openTasks: Map<string, number>;
  claimed: Set<string>;
  /** Event rows, for what reads them by channel or ID. */
  events?: Record<string, unknown>[];
  /** Fails a request whose path holds this text, with this status and code. */
  failing?: { path: string; status: number; code?: string };
}

const STALE = { status: 400, body: { code: "CF409", message: "row text" } };

/** An in-memory stand-in with the version rules of the real database functions. */
export function fakeDb(fields: Partial<DbState> = {}): {
  db: DbClient;
  state: DbState;
  requests: RecordedRequest[];
  rpcBodies: (name: string) => Record<string, unknown>[];
} {
  const state: DbState = {
    config: null,
    channels: [],
    changes: [],
    openTasks: new Map(),
    claimed: new Set(),
    ...fields,
  };

  function roleBindings(args: Record<string, unknown>) {
    const current = state.config?.version ?? 0;
    if (args.p_expected_version !== current) {
      return STALE;
    }
    state.config = configRow({
      officer_role_id: args.p_officer_role_id as string,
      admin_role_id: args.p_admin_role_id as string,
      version: current + 1,
    });
    return { body: current + 1 };
  }

  function configChange(args: Record<string, unknown>) {
    if (
      state.config === null ||
      args.p_expected_version !== state.config.version
    ) {
      return STALE;
    }
    for (const id of args.p_remove_channel_ids as string[]) {
      const row = state.channels.find(
        (channel) => channel.channel_id === id && channel.status !== "removed",
      );
      if (row === undefined) {
        return { status: 400, body: { code: "22023", message: "row text" } };
      }
      row.status = "removed";
    }
    for (const id of args.p_add_channel_ids as string[]) {
      const row = state.channels.find((channel) => channel.channel_id === id);
      if (row === undefined) {
        state.channels.push(managedRow(id));
      } else {
        row.status = "active";
      }
    }
    if (typeof args.p_reminders_enabled === "boolean") {
      state.config.reminders_enabled = args.p_reminders_enabled;
    }
    state.config.version += 1;
    return { body: state.config.version };
  }

  const { db, requests } = mockPostgrest((request) => {
    const path = request.target.split("?")[0] ?? "";
    if (state.failing !== undefined && path.includes(state.failing.path)) {
      return {
        status: state.failing.status,
        body: {
          code: state.failing.code ?? "XX000",
          message: "canary row text",
        },
      };
    }
    const args = (request.body ?? {}) as Record<string, unknown>;
    if (path.endsWith("/rpc/claim_interaction")) {
      const id = args.p_interaction_id as string;
      const first = !state.claimed.has(id);
      state.claimed.add(id);
      return { body: first };
    }
    if (path.endsWith("/rpc/apply_role_bindings")) {
      return roleBindings(args);
    }
    if (path.endsWith("/rpc/apply_config_change")) {
      return configChange(args);
    }
    if (path.endsWith("/guild_config")) {
      return { body: state.config === null ? [] : [{ ...state.config }] };
    }
    if (path.endsWith("/managed_channels")) {
      const match = /channel_id=eq\.([0-9]+)/.exec(request.target);
      return {
        body: state.channels.filter(
          (row) => match === null || row.channel_id === match[1],
        ),
      };
    }
    if (path.endsWith("/events")) {
      const id = /[?&]id=eq\.([0-9a-f-]+)/.exec(request.target)?.[1];
      const limit = /[?&]limit=([0-9]+)/.exec(request.target)?.[1];
      return {
        body: (state.events ?? [])
          .filter((row) => id === undefined || row.id === id)
          .slice(0, limit === undefined ? undefined : Number(limit)),
      };
    }
    if (path.endsWith("/config_audit")) {
      return { body: state.changes };
    }
    if (path.endsWith("/tasks")) {
      const match = /events\.channel_id=eq\.([0-9]+)/.exec(request.target);
      const count = state.openTasks.get(match?.[1] ?? "") ?? 0;
      return {
        body: Array.from({ length: count }, (_, index) => ({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          events: { channel_id: match?.[1] },
        })),
      };
    }
    return { status: 500, body: { message: "unexpected test request" } };
  });

  return {
    db,
    state,
    requests,
    rpcBodies: (name) =>
      requests
        .filter((request) => request.target.startsWith(`/rest/v1/rpc/${name}`))
        .map((request) => request.body as Record<string, unknown>),
  };
}

export interface FakeDiscordData {
  roles?: readonly GuildRole[] | "fail";
  channels?: readonly GuildChannel[] | "fail";
  botRoleIds?: readonly string[] | "fail";
}

function orFail<T>(value: T | "fail"): Promise<T> {
  return value === "fail"
    ? Promise.reject(new Error("canary discord failure"))
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
      edits.push(body.toJSON() as (typeof edits)[number]);
      return Promise.resolve({ id: testSnowflake() });
    },
    getGuildRoles: () => orFail(data.roles ?? []),
    getGuildChannels: () => orFail(data.channels ?? []),
    getGuildMemberRoleIds: () => orFail(data.botRoleIds ?? []),
    describeChannel: () => Promise.reject(new Error("canary discord failure")),
    listActiveThreads: () =>
      Promise.reject(new Error("canary discord failure")),
    listArchivedThreads: () =>
      Promise.reject(new Error("canary discord failure")),
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
    reply: outcome.reply.toJSON() as Ran["reply"],
    deferred: outcome.after !== undefined,
  };
}
