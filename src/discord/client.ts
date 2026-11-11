/**
 * The one module meant to call Discord's REST API.
 *
 * Every send names its target, and the injected check must accept that target
 * before the send is made. A thread is judged by its parent, which comes from
 * Discord or from a signed payload and never from the caller. The only exception
 * is an ephemeral first response or an edit of one, which is seen by the invoking
 * user alone and posts nothing to the channel.
 *
 * Nothing here logs, and errors carry no request or response content and no
 * underlying cause: URLs can hold interaction tokens, bodies hold user text, and
 * lower-level errors can quote either.
 *
 * Make one client per run or request. It remembers within its lifetime that the
 * token was refused or a channel is unavailable, and does not ask Discord again,
 * because Discord restricts an IP after too many 401, 403 and 429 responses.
 */

import { setTimeout as delay } from "node:timers/promises";
import { parsePermissions } from "../lib/actor.ts";
import { ConfigError } from "../lib/config-error.ts";
import { isSnowflake } from "../lib/snowflake.ts";
import {
  isEphemeralInitialResponse,
  serializeOutboundBody,
} from "./outbound.ts";
import type { OutboundBody } from "./outbound.ts";
import { interactionToken, isThreadChannelType } from "./verify.ts";
import type { VerifiedInteraction } from "./verify.ts";

const API_BASE = "https://discord.com/api/v10";
const WEB_BASE = "https://discord.com/channels";
// The format Discord requires: a URL for the project and its version.
const USER_AGENT = "DiscordBot (https://github.com/GT-SASE/discordBot, 0.0.0)";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_WAIT_MS = 1_000;
// Discord drops an interaction that is not answered within 3 seconds.
const DEFAULT_CALLBACK_BUDGET_MS = 2_500;
const DEFAULT_OPERATION_BUDGET_MS = 8_000;
const EPHEMERAL_FLAG = 64;
// A deferred reply can take a moment to exist after the acknowledgement, and Discord's
// webhook routes can fail for a moment. The total stays inside the operation budget.
const ORIGINAL_RETRY_WAITS_MS = [250, 500, 1000];
const FORUM_CHANNEL_TYPES: ReadonlySet<unknown> = new Set([15, 16]);

/** Discord error codes that callers are expected to act on. */
export const DiscordErrorCode = {
  UnknownChannel: 10003,
  UnknownMessage: 10008,
  UnknownInteraction: 10062,
  MissingAccess: 50001,
  MissingPermissions: 50013,
  ThreadArchived: 50083,
  ForumTagRequired: 40067,
  AutoModBlocked: 200000,
} as const;

export type ChannelTarget = Readonly<{
  kind: "channel";
  guildId: string;
  channelId: string;
}>;
export type ThreadTarget = Readonly<{
  kind: "thread";
  guildId: string;
  threadId: string;
}>;
/**
 * `kind` is a label for the caller. Only the IDs decide anything. Take them, and
 * any message ID, from a row loaded for this guild, never from a `custom_id` or
 * command input.
 */
export type SendTarget = ChannelTarget | ThreadTarget;

/**
 * Decides whether the bot may post to a channel of a guild. A thread's ID is
 * unknown to it and the client then asks about the thread's parent. An error thrown
 * from here refuses the send, as does any answer other than `true`.
 */
export interface ManagedChannelCheck {
  isManaged(guildId: string, channelId: string): Promise<boolean>;
}

export type DiscordFailure =
  /** An ID, token or interaction was malformed. Nothing was sent. */
  | Readonly<{ kind: "invalid_target" }>
  /** The check refused the channel. Nothing was sent. */
  | Readonly<{ kind: "unmanaged_target"; channelId: string }>
  /** The check failed or ran out of time, so the send was refused. */
  | Readonly<{ kind: "check_failed"; channelId: string }>
  /** Forum posts can only be created in a forum or media channel. */
  | Readonly<{ kind: "not_forum"; channelId: string }>
  /** Could not confirm that this response or reply is ephemeral. */
  | Readonly<{ kind: "not_ephemeral" }>
  /** Still limited after the retries, or the wait would not fit the budget. */
  | Readonly<{
      kind: "rate_limited";
      retryAfterMs: number;
      attempts: number;
      /** `X-RateLimit-Scope`: user, global or shared, if Discord sent it. */
      scope: string | undefined;
    }>
  /** Discord refused the bot token. Nothing further will work in this run. */
  | Readonly<{ kind: "unauthorized" }>
  /** Discord said it cannot use this channel. Do not try it again. */
  | Readonly<{
      kind: "channel_unavailable";
      channelId: string;
      status: number;
      code: number | undefined;
    }>
  /** The operation's time ran out before a request could start. */
  | Readonly<{ kind: "budget_exhausted" }>
  /** Discord refused a request. `code` is absent if it sent no usable one. */
  | Readonly<{ kind: "api"; status: number; code: number | undefined }>
  /** No response arrived, so a send may or may not have taken effect. */
  | Readonly<{ kind: "network" }>
  /** A success response did not have the expected shape. */
  | Readonly<{ kind: "invalid_response"; status: number }>;

type Operation =
  | "send message"
  | "edit message"
  | "reopen thread"
  | "create thread"
  | "reply to interaction"
  | "edit interaction reply"
  | "send follow-up"
  | "read channel"
  | "read guild";

function describeFailure(failure: DiscordFailure): string {
  switch (failure.kind) {
    case "invalid_target":
      return "the target has a malformed ID or token";
    case "unmanaged_target":
      return "the target is not a managed channel";
    case "check_failed":
      return "the managed channel check failed";
    case "not_forum":
      return "the target is not a forum or media channel";
    case "not_ephemeral":
      return "could not confirm the response is ephemeral";
    case "rate_limited":
      return `rate limited after ${String(failure.attempts)} attempts, retry after ${String(failure.retryAfterMs)} ms`;
    case "unauthorized":
      return "Discord refused the bot token";
    case "channel_unavailable":
      return `the channel is unavailable, status ${String(failure.status)}, code ${String(failure.code)}`;
    case "budget_exhausted":
      return "the operation ran out of time";
    case "api":
      return `Discord responded ${String(failure.status)}, code ${String(failure.code)}`;
    case "network":
      return "no response from Discord";
    case "invalid_response":
      return `unexpected success response, status ${String(failure.status)}`;
  }
}

export class DiscordClientError extends Error {
  readonly operation: Operation;
  readonly failure: DiscordFailure;

  constructor(operation: Operation, failure: DiscordFailure) {
    super(`Could not ${operation}: ${describeFailure(failure)}`);
    this.name = "DiscordClientError";
    this.operation = operation;
    this.failure = failure;
  }
}

/** What a run should do after a failure. */
export type FailureAction =
  /** Stop the whole run: more requests cannot work and count against the bot. */
  | "stop_run"
  /** Mark the channel unavailable and go on with other channels. */
  | "mark_channel_unavailable"
  /** Leave this item for the next run. */
  | "retry_later"
  /** Discord blames this item's text. Record it as failed and go on. */
  | "skip_item";

/**
 * Codes with which Discord blames the text of a message: AutoMod's two blocks and an
 * invalid form body. A locked thread (160005) or a proxy's refusal (40333) says nothing
 * about the text, and neither does a 4xx with no code at all.
 */
const TEXT_REFUSED: ReadonlySet<number | undefined> = new Set([
  200000, 240000, 50035,
]);

export function actionForFailure(failure: DiscordFailure): FailureAction {
  switch (failure.kind) {
    case "unauthorized":
      return "stop_run";
    case "channel_unavailable":
      return "mark_channel_unavailable";
    case "rate_limited":
      return failure.scope === "global" ? "stop_run" : "retry_later";
    case "api":
      return failure.status === 400 && TEXT_REFUSED.has(failure.code)
        ? "skip_item"
        : "retry_later";
    case "check_failed":
    case "budget_exhausted":
    case "network":
    case "invalid_response":
    case "invalid_target":
    case "unmanaged_target":
    case "not_forum":
    case "not_ephemeral":
      return "retry_later";
  }
}

export interface DiscordResource {
  readonly id: string;
}

export interface DiscordChannel {
  readonly type: number;
  /** As Discord reports it, or undefined if it sent none. */
  readonly guildId: string | undefined;
}

/** A new forum post. Discord gives its first message the post's own ID. */
export interface ForumPost extends DiscordResource {
  readonly firstMessageId: string;
}

/** What Discord says a channel or thread is now. Judge it by these, not by a payload. */
export interface ChannelSummary {
  readonly id: string;
  readonly type: number;
  readonly guildId: string | undefined;
  readonly parentId: string | undefined;
  /** For a thread, who started it. */
  readonly ownerId: string | undefined;
  /** Anyone who can name a post controls this, so normalise it before use. */
  readonly name: string | undefined;
}

export interface ThreadSummary {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly ownerId: string | undefined;
  /** Anyone who can name a post controls this, so normalise it before use. */
  readonly name: string;
}

export interface GuildRole {
  readonly id: string;
  /** Any member with Manage Roles can set this, so render it only once escaped. */
  readonly name: string;
  readonly permissions: bigint;
  readonly position: number;
  /** Owned by an integration: Discord assigns it and nobody can grant it. */
  readonly managed: boolean;
}

export interface PermissionOverwrite {
  readonly id: string;
  /** 0 for a role, 1 for a member. */
  readonly type: number;
  readonly allow: bigint;
  readonly deny: bigint;
}

export interface GuildChannel {
  readonly id: string;
  /** Anyone who can manage the channel can set this, so escape it to render it. */
  readonly name: string;
  readonly type: number;
  readonly overwrites: readonly PermissionOverwrite[];
}

export interface DiscordClient {
  sendMessage(
    target: SendTarget,
    body: OutboundBody<"channel-message">,
  ): Promise<DiscordResource>;
  editMessage(
    target: SendTarget,
    messageId: string,
    body: OutboundBody<"message-edit">,
  ): Promise<DiscordResource>;
  /**
   * Unarchives a managed thread, so that its messages can be edited. Discord asks for
   * Send Messages unless the thread is also locked. Posts nothing.
   */
  reopenThread(target: ThreadTarget): Promise<void>;
  /** Reads a channel, to see that it is still there. Posts nothing. */
  getChannel(guildId: string, channelId: string): Promise<DiscordChannel>;
  /** Creates a post in a managed forum or media channel. */
  createThread(
    parent: ChannelTarget,
    body: OutboundBody<"thread-create">,
  ): Promise<ForumPost>;
  /** Sends a first response, after checking the interaction's channel. */
  replyToInteraction(
    interaction: VerifiedInteraction,
    body: OutboundBody<"checked-response">,
  ): Promise<void>;
  /** Edits the original response, after checking the interaction's channel. */
  editInteractionReply(
    interaction: VerifiedInteraction,
    body: OutboundBody<"message-edit">,
  ): Promise<DiscordResource>;
  /** Sends a further message, after checking the interaction's channel. */
  sendFollowUp(
    interaction: VerifiedInteraction,
    body: OutboundBody<"follow-up">,
  ): Promise<DiscordResource>;
  /** Sends a first response that must be ephemeral, in any channel. */
  respondEphemerally(
    interaction: VerifiedInteraction,
    body: OutboundBody<"direct-response">,
  ): Promise<void>;
  /** Edits the original response, in any channel, if Discord says it is ephemeral. */
  editEphemeralReply(
    interaction: VerifiedInteraction,
    body: OutboundBody<"message-edit">,
  ): Promise<DiscordResource>;
  /** Every role in the guild, as Discord reports it now. */
  getGuildRoles(guildId: string): Promise<readonly GuildRole[]>;
  /** Every channel in the guild, as Discord reports it now. */
  getGuildChannels(guildId: string): Promise<readonly GuildChannel[]>;
  /** Everything Discord reports about a channel or thread, whichever guild it is in. */
  describeChannel(channelId: string): Promise<ChannelSummary>;
  /** The guild's threads that are not archived, as Discord reports them now. */
  listActiveThreads(guildId: string): Promise<readonly ThreadSummary[]>;
  /**
   * A forum's public archived threads, most recently archived first, up to one page.
   * Discord asks for Read Message History here, and a refusal says nothing against the
   * forum: it does not stop this client from using the forum afterwards.
   */
  listArchivedThreads(channelId: string): Promise<readonly ThreadSummary[]>;
  /** The roles a member holds, leaving out the @everyone role. */
  getGuildMemberRoleIds(
    guildId: string,
    userId: string,
  ): Promise<readonly string[]>;
}

export interface DiscordClientOptions {
  readonly check: ManagedChannelCheck;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly sleep?: (ms: number) => Promise<unknown>;
  readonly now?: () => number;
  /** Total time per operation, including checks, lookups and retries. */
  readonly budget?: Readonly<{ callbackMs?: number; operationMs?: number }>;
}

/** A link to a message, for use in message text. */
export function messageUrl(
  guildId: string,
  channelId: string,
  messageId: string,
): string {
  if (![guildId, channelId, messageId].every(isSnowflake)) {
    throw new RangeError("A message link needs three Discord IDs");
  }
  return `${WEB_BASE}/${guildId}/${channelId}/${messageId}`;
}

function readBotToken(env: DiscordClientOptions["env"]): string {
  const token = env?.DISCORD_BOT_TOKEN;
  if (token === undefined || token === "") {
    throw new ConfigError("DISCORD_BOT_TOKEN", "must be set");
  }
  // A value that is not valid in a header would make fetch throw an error that
  // quotes it, so it is refused here first.
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new ConfigError(
      "DISCORD_BOT_TOKEN",
      "must be the bare token, with no spaces or prefix",
    );
  }
  return token;
}

function readAppId(env: DiscordClientOptions["env"]): string {
  const appId = env?.DISCORD_APP_ID;
  if (appId === undefined || !isSnowflake(appId)) {
    throw new ConfigError("DISCORD_APP_ID", "must be a Discord ID");
  }
  return appId;
}

/**
 * Discord's own fault, or no answer at all. Safe to repeat only where the request is
 * idempotent, so this is for reading and editing an interaction's original reply and
 * not for anything that creates a message.
 */
function isTransient(error: unknown): boolean {
  if (!(error instanceof DiscordClientError)) {
    return false;
  }
  const { failure } = error;
  return (
    failure.kind === "network" ||
    (failure.kind === "api" && failure.status >= 500)
  );
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof DiscordClientError &&
    error.failure.kind === "api" &&
    error.failure.status === 404
  );
}

function targetChannelId(target: SendTarget): string {
  return target.kind === "channel" ? target.channelId : target.threadId;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

function secondsToMs(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds * 1000)
    : undefined;
}

function retryWaitMs(response: Response, body: unknown): number {
  return (
    secondsToMs(response.headers.get("retry-after")) ??
    secondsToMs(field(body, "retry_after")) ??
    DEFAULT_RETRY_WAIT_MS
  );
}

/**
 * A 429 with no JSON body comes from the network edge, not a route, so it counts
 * as global.
 */
function rateLimitScope(response: Response, body: unknown): string | undefined {
  return (
    response.headers.get("x-ratelimit-scope") ??
    (response.headers.get("x-ratelimit-global") === "true" ||
    field(body, "global") === true ||
    body === undefined
      ? "global"
      : undefined)
  );
}

function parseRole(value: unknown): GuildRole | undefined {
  const id = field(value, "id");
  const name = field(value, "name");
  const position = field(value, "position");
  const managed = field(value, "managed");
  const permissions = parsePermissions(field(value, "permissions"));
  return isSnowflake(id) &&
    typeof name === "string" &&
    typeof position === "number" &&
    typeof managed === "boolean" &&
    permissions !== undefined
    ? { id, name, permissions, position, managed }
    : undefined;
}

function parseOverwrite(value: unknown): PermissionOverwrite | undefined {
  const id = field(value, "id");
  const type = field(value, "type");
  const allow = parsePermissions(field(value, "allow"));
  const deny = parsePermissions(field(value, "deny"));
  return isSnowflake(id) &&
    typeof type === "number" &&
    allow !== undefined &&
    deny !== undefined
    ? { id, type, allow, deny }
    : undefined;
}

/** All or nothing: half a list could hide the role or overwrite that matters. */
function parseAll<T>(
  value: unknown,
  parse: (item: unknown) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items: T[] = [];
  for (const item of value as unknown[]) {
    const parsed = parse(item);
    if (parsed === undefined) {
      return undefined;
    }
    items.push(parsed);
  }
  return items;
}

function parseChannel(value: unknown): GuildChannel | undefined {
  const id = field(value, "id");
  const name = field(value, "name");
  const type = field(value, "type");
  const overwrites = parseAll(
    field(value, "permission_overwrites"),
    parseOverwrite,
  );
  return isSnowflake(id) &&
    typeof name === "string" &&
    typeof type === "number" &&
    overwrites !== undefined
    ? { id, name, type, overwrites }
    : undefined;
}

function optionalSnowflake(value: unknown): string | undefined {
  return isSnowflake(value) ? value : undefined;
}

function parseThreadSummary(value: unknown): ThreadSummary | undefined {
  const id = field(value, "id");
  const name = field(value, "name");
  return isSnowflake(id) && typeof name === "string"
    ? {
        id,
        name,
        parentId: optionalSnowflake(field(value, "parent_id")),
        ownerId: optionalSnowflake(field(value, "owner_id")),
      }
    : undefined;
}

function parseRoleId(value: unknown): string | undefined {
  return isSnowflake(value) ? value : undefined;
}

interface Route {
  readonly method: "GET" | "POST" | "PATCH";
  readonly path: string;
  /** Interaction routes are authorized by the token in their path. */
  readonly auth: "bot" | "none";
  /** The channel a 403 or 404 from this route counts against. */
  readonly channelId?: string;
}

type Remaining = () => number;

export function createDiscordClient(
  options: DiscordClientOptions,
): DiscordClient {
  const { check, env = process.env, sleep = delay, now = Date.now } = options;
  const callbackBudgetMs =
    options.budget?.callbackMs ?? DEFAULT_CALLBACK_BUDGET_MS;
  const operationBudgetMs =
    options.budget?.operationMs ?? DEFAULT_OPERATION_BUDGET_MS;
  const botToken = readBotToken(env);
  const appId = readAppId(env);
  let tokenRefused = false;
  const unavailableChannels = new Map<string, DiscordFailure>();

  function startBudget(ms: number): Remaining {
    const deadline = now() + ms;
    return () => deadline - now();
  }

  async function request(
    operation: Operation,
    route: Route,
    json: string | undefined,
    remaining: Remaining,
  ): Promise<Response> {
    if (route.auth === "bot" && tokenRefused) {
      throw new DiscordClientError(operation, { kind: "unauthorized" });
    }
    const unavailable =
      route.channelId === undefined
        ? undefined
        : unavailableChannels.get(route.channelId);
    if (unavailable !== undefined) {
      throw new DiscordClientError(operation, unavailable);
    }

    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (route.auth === "bot") {
      headers.Authorization = `Bot ${botToken}`;
    }

    for (let attempt = 1; ; attempt++) {
      const left = remaining();
      if (left <= 0) {
        throw new DiscordClientError(operation, { kind: "budget_exhausted" });
      }

      let response: Response;
      try {
        response = await fetch(`${API_BASE}${route.path}`, {
          method: route.method,
          headers,
          ...(json === undefined ? {} : { body: json }),
          redirect: "error",
          signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, left)),
        });
      } catch {
        throw new DiscordClientError(operation, { kind: "network" });
      }

      if (response.status !== 429) {
        if (response.ok) {
          return response;
        }
        const body = field(await readJson(response), "code");
        const code = typeof body === "number" ? body : undefined;
        const { status } = response;
        if (status === 401 && route.auth === "bot") {
          tokenRefused = true;
          throw new DiscordClientError(operation, { kind: "unauthorized" });
        }
        if (
          (status === 403 || status === 404) &&
          route.channelId !== undefined &&
          (code === DiscordErrorCode.UnknownChannel ||
            code === DiscordErrorCode.MissingAccess ||
            code === DiscordErrorCode.MissingPermissions)
        ) {
          const failure: DiscordFailure = {
            kind: "channel_unavailable",
            channelId: route.channelId,
            status,
            code,
          };
          unavailableChannels.set(route.channelId, failure);
          throw new DiscordClientError(operation, failure);
        }
        throw new DiscordClientError(operation, { kind: "api", status, code });
      }

      // Reading the body also releases the connection for the next attempt.
      const body = await readJson(response);
      const waitMs = retryWaitMs(response, body);
      const scope = rateLimitScope(response, body);
      if (
        scope === "global" ||
        attempt >= MAX_ATTEMPTS ||
        waitMs >= remaining()
      ) {
        throw new DiscordClientError(operation, {
          kind: "rate_limited",
          retryAfterMs: waitMs,
          attempts: attempt,
          scope,
        });
      }
      await sleep(waitMs);
    }
  }

  async function isManaged(
    operation: Operation,
    guildId: string,
    channelId: string,
    remaining: Remaining,
  ): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(reject, Math.max(0, remaining()));
    });
    try {
      const managed: unknown = await Promise.race([
        check.isManaged(guildId, channelId),
        expired,
      ]);
      return managed === true;
    } catch {
      throw new DiscordClientError(operation, {
        kind: "check_failed",
        channelId,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function lookUpChannel(
    operation: Operation,
    channelId: string,
    remaining: Remaining,
  ): Promise<{
    type: number;
    parentId: unknown;
    guildId: unknown;
    ownerId: unknown;
    name: unknown;
  }> {
    const response = await request(
      operation,
      { method: "GET", path: `/channels/${channelId}`, auth: "bot", channelId },
      undefined,
      remaining,
    );
    const channel = await readJson(response);
    const type = field(channel, "type");
    if (typeof type !== "number") {
      throw new DiscordClientError(operation, {
        kind: "invalid_response",
        status: response.status,
      });
    }
    return {
      type,
      parentId: field(channel, "parent_id"),
      guildId: field(channel, "guild_id"),
      ownerId: field(channel, "owner_id"),
      name: field(channel, "name"),
    };
  }

  /** The parent Discord reports, if the channel really is a thread of the guild. */
  async function lookUpThreadParent(
    operation: Operation,
    guildId: string,
    channelId: string,
    remaining: Remaining,
  ): Promise<string | undefined> {
    const channel = await lookUpChannel(operation, channelId, remaining);
    return channel.guildId === guildId &&
      isThreadChannelType(channel.type) &&
      isSnowflake(channel.parentId)
      ? channel.parentId
      : undefined;
  }

  function refuseUnmanaged(
    operation: Operation,
    channelId: string,
  ): DiscordClientError {
    return new DiscordClientError(operation, {
      kind: "unmanaged_target",
      channelId,
    });
  }

  async function assertManaged(
    operation: Operation,
    guildId: string,
    channelId: string,
    remaining: Remaining,
  ): Promise<void> {
    if (!isSnowflake(guildId) || !isSnowflake(channelId)) {
      throw new DiscordClientError(operation, { kind: "invalid_target" });
    }
    if (await isManaged(operation, guildId, channelId, remaining)) {
      return;
    }
    const parentId = await lookUpThreadParent(
      operation,
      guildId,
      channelId,
      remaining,
    );
    if (
      parentId === undefined ||
      !(await isManaged(operation, guildId, parentId, remaining))
    ) {
      throw refuseUnmanaged(operation, channelId);
    }
  }

  async function assertInteractionManaged(
    operation: Operation,
    interaction: VerifiedInteraction,
    remaining: Remaining,
  ): Promise<void> {
    const { guildId, channelId, channelType, parentId } = interaction;
    const managedId = isThreadChannelType(channelType)
      ? (parentId ??
        (await lookUpThreadParent(operation, guildId, channelId, remaining)))
      : channelId;
    if (
      managedId === undefined ||
      !(await isManaged(operation, guildId, managedId, remaining))
    ) {
      throw refuseUnmanaged(operation, channelId);
    }
  }

  function tokenOf(
    operation: Operation,
    interaction: VerifiedInteraction,
  ): string {
    const token = interactionToken(interaction);
    if (token === undefined) {
      throw new DiscordClientError(operation, { kind: "invalid_target" });
    }
    return encodeURIComponent(token);
  }

  async function readResource(
    operation: Operation,
    response: Response,
  ): Promise<DiscordResource> {
    const id = field(await readJson(response), "id");
    if (typeof id !== "string") {
      throw new DiscordClientError(operation, {
        kind: "invalid_response",
        status: response.status,
      });
    }
    return { id };
  }

  function callbackRoute(
    operation: Operation,
    interaction: VerifiedInteraction,
  ): Route {
    const token = tokenOf(operation, interaction);
    return {
      method: "POST",
      path: `/interactions/${interaction.id}/${token}/callback`,
      auth: "none",
    };
  }

  function originalPath(
    operation: Operation,
    interaction: VerifiedInteraction,
  ): string {
    const token = tokenOf(operation, interaction);
    return `/webhooks/${appId}/${token}/messages/@original`;
  }

  async function readGuild<T>(
    ids: readonly string[],
    path: string,
    parse: (body: unknown) => T | undefined,
  ): Promise<T> {
    const operation = "read guild";
    if (!ids.every(isSnowflake)) {
      throw new DiscordClientError(operation, { kind: "invalid_target" });
    }
    const response = await request(
      operation,
      { method: "GET", path, auth: "bot" },
      undefined,
      startBudget(operationBudgetMs),
    );
    const parsed = parse(await readJson(response));
    if (parsed === undefined) {
      throw new DiscordClientError(operation, {
        kind: "invalid_response",
        status: response.status,
      });
    }
    return parsed;
  }

  /** Repeats a request on the original reply, for as long as the budget allows. */
  async function retryOriginal(
    send: () => Promise<Response>,
    shouldRetry: (error: unknown) => boolean,
    remaining: Remaining,
  ): Promise<Response> {
    for (const waitMs of ORIGINAL_RETRY_WAITS_MS) {
      try {
        return await send();
      } catch (error) {
        if (!shouldRetry(error) || waitMs >= remaining()) {
          throw error;
        }
        await sleep(waitMs);
      }
    }
    return send();
  }

  /** Reads the original reply, waiting briefly if Discord does not have it yet. */
  function readOriginal(
    operation: Operation,
    path: string,
    remaining: Remaining,
  ): Promise<Response> {
    const route: Route = { method: "GET", path, auth: "none" };
    return retryOriginal(
      () => request(operation, route, undefined, remaining),
      (error) => isNotFound(error) || isTransient(error),
      remaining,
    );
  }

  /** Replaces the original reply. Sending the same edit twice changes nothing more. */
  async function patchOriginal(
    operation: Operation,
    path: string,
    json: string,
    remaining: Remaining,
  ): Promise<DiscordResource> {
    const route: Route = { method: "PATCH", path, auth: "none" };
    return readResource(
      operation,
      await retryOriginal(
        () => request(operation, route, json, remaining),
        isTransient,
        remaining,
      ),
    );
  }

  return {
    async getChannel(guildId, channelId) {
      const operation = "read channel";
      if (!isSnowflake(guildId) || !isSnowflake(channelId)) {
        throw new DiscordClientError(operation, { kind: "invalid_target" });
      }
      const channel = await lookUpChannel(
        operation,
        channelId,
        startBudget(operationBudgetMs),
      );
      return {
        type: channel.type,
        guildId: isSnowflake(channel.guildId) ? channel.guildId : undefined,
      };
    },

    async sendMessage(target, body) {
      const operation = "send message";
      const json = serializeOutboundBody(body, "channel-message");
      const remaining = startBudget(operationBudgetMs);
      const channelId = targetChannelId(target);
      await assertManaged(operation, target.guildId, channelId, remaining);
      const route: Route = {
        method: "POST",
        path: `/channels/${channelId}/messages`,
        auth: "bot",
        channelId,
      };
      return readResource(
        operation,
        await request(operation, route, json, remaining),
      );
    },

    async editMessage(target, messageId, body) {
      const operation = "edit message";
      const json = serializeOutboundBody(body, "message-edit");
      if (!isSnowflake(messageId)) {
        throw new DiscordClientError(operation, { kind: "invalid_target" });
      }
      const remaining = startBudget(operationBudgetMs);
      const channelId = targetChannelId(target);
      await assertManaged(operation, target.guildId, channelId, remaining);
      const route: Route = {
        method: "PATCH",
        path: `/channels/${channelId}/messages/${messageId}`,
        auth: "bot",
        channelId,
      };
      return readResource(
        operation,
        await request(operation, route, json, remaining),
      );
    },

    async reopenThread({ guildId, threadId }) {
      const operation = "reopen thread";
      const remaining = startBudget(operationBudgetMs);
      await assertManaged(operation, guildId, threadId, remaining);
      // No channelId: a refusal here means locked, and says nothing against the thread.
      await request(
        operation,
        { method: "PATCH", path: `/channels/${threadId}`, auth: "bot" },
        JSON.stringify({ archived: false }),
        remaining,
      );
    },

    async createThread(parent, body) {
      const operation = "create thread";
      const json = serializeOutboundBody(body, "thread-create");
      const { kind, guildId, channelId } = parent;
      if (
        (kind as string) !== "channel" ||
        !isSnowflake(guildId) ||
        !isSnowflake(channelId)
      ) {
        throw new DiscordClientError(operation, { kind: "invalid_target" });
      }
      const remaining = startBudget(operationBudgetMs);
      // A forum must be managed itself: there is no parent to fall back on.
      if (!(await isManaged(operation, guildId, channelId, remaining))) {
        throw refuseUnmanaged(operation, channelId);
      }
      const channel = await lookUpChannel(operation, channelId, remaining);
      if (channel.guildId !== guildId) {
        throw refuseUnmanaged(operation, channelId);
      }
      if (!FORUM_CHANNEL_TYPES.has(channel.type)) {
        throw new DiscordClientError(operation, {
          kind: "not_forum",
          channelId,
        });
      }
      const route: Route = {
        method: "POST",
        path: `/channels/${channelId}/threads`,
        auth: "bot",
        channelId,
      };
      const response = await request(operation, route, json, remaining);
      const created = await readJson(response);
      const id = field(created, "id");
      if (!isSnowflake(id)) {
        throw new DiscordClientError(operation, {
          kind: "invalid_response",
          status: response.status,
        });
      }
      return {
        id,
        firstMessageId:
          optionalSnowflake(field(field(created, "message"), "id")) ?? id,
      };
    },

    async replyToInteraction(interaction, body) {
      const operation = "reply to interaction";
      const json = serializeOutboundBody(body, "checked-response");
      const route = callbackRoute(operation, interaction);
      const remaining = startBudget(callbackBudgetMs);
      await assertInteractionManaged(operation, interaction, remaining);
      await request(operation, route, json, remaining);
    },

    async editInteractionReply(interaction, body) {
      const operation = "edit interaction reply";
      const json = serializeOutboundBody(body, "message-edit");
      const path = originalPath(operation, interaction);
      const remaining = startBudget(operationBudgetMs);
      await assertInteractionManaged(operation, interaction, remaining);
      return patchOriginal(operation, path, json, remaining);
    },

    async sendFollowUp(interaction, body) {
      const operation = "send follow-up";
      const json = serializeOutboundBody(body, "follow-up");
      const token = tokenOf(operation, interaction);
      const remaining = startBudget(operationBudgetMs);
      await assertInteractionManaged(operation, interaction, remaining);
      const route: Route = {
        method: "POST",
        path: `/webhooks/${appId}/${token}`,
        auth: "none",
      };
      return readResource(
        operation,
        await request(operation, route, json, remaining),
      );
    },

    async respondEphemerally(interaction, body) {
      const operation = "reply to interaction";
      const json = serializeOutboundBody(body, "direct-response");
      if (!isEphemeralInitialResponse(body)) {
        throw new DiscordClientError(operation, { kind: "not_ephemeral" });
      }
      const route = callbackRoute(operation, interaction);
      await request(operation, route, json, startBudget(callbackBudgetMs));
    },

    async editEphemeralReply(interaction, body) {
      const operation = "edit interaction reply";
      const json = serializeOutboundBody(body, "message-edit");
      const path = originalPath(operation, interaction);
      const remaining = startBudget(operationBudgetMs);
      const original = await readOriginal(operation, path, remaining);
      const flags = field(await readJson(original), "flags");
      if (typeof flags !== "number" || (flags & EPHEMERAL_FLAG) === 0) {
        throw new DiscordClientError(operation, { kind: "not_ephemeral" });
      }
      return patchOriginal(operation, path, json, remaining);
    },

    getGuildRoles(guildId) {
      return readGuild([guildId], `/guilds/${guildId}/roles`, (body) =>
        parseAll(body, parseRole),
      );
    },

    getGuildChannels(guildId) {
      return readGuild([guildId], `/guilds/${guildId}/channels`, (body) =>
        parseAll(body, parseChannel),
      );
    },

    async describeChannel(channelId) {
      const operation = "read channel";
      if (!isSnowflake(channelId)) {
        throw new DiscordClientError(operation, { kind: "invalid_target" });
      }
      const channel = await lookUpChannel(
        operation,
        channelId,
        startBudget(operationBudgetMs),
      );
      return {
        id: channelId,
        type: channel.type,
        guildId: optionalSnowflake(channel.guildId),
        parentId: optionalSnowflake(channel.parentId),
        ownerId: optionalSnowflake(channel.ownerId),
        name: typeof channel.name === "string" ? channel.name : undefined,
      };
    },

    listActiveThreads(guildId) {
      return readGuild([guildId], `/guilds/${guildId}/threads/active`, (body) =>
        parseAll(field(body, "threads"), parseThreadSummary),
      );
    },

    listArchivedThreads(channelId) {
      return readGuild(
        [channelId],
        `/channels/${channelId}/threads/archived/public?limit=100`,
        (body) => parseAll(field(body, "threads"), parseThreadSummary),
      );
    },

    getGuildMemberRoleIds(guildId, userId) {
      return readGuild(
        [guildId, userId],
        `/guilds/${guildId}/members/${userId}`,
        (body) => parseAll(field(body, "roles"), parseRoleId),
      );
    },
  };
}
