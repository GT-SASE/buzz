/**
 * A stand-in for Discord's REST API, behind the real client. Handler tests go through
 * the client's own checks and see the JSON that would really be sent. A failure is
 * armed per route, so a test can break any one step of a flow. Every body sent must
 * be inert, so each test also checks the real output of the templates it reaches.
 */

import { expect } from "bun:test";
import { jsonObject } from "./json.ts";
import { fakeId } from "./ids.ts";
import type { FetchLike } from "./stubs.ts";

const THREAD_TYPE = 11;
const DISCORD_EPOCH_MS = 1420070400000;
const EPHEMERAL_FLAG = 64;

interface FakeChannel {
  id: string;
  type: number;
  guild_id: string;
  parent_id?: string;
  name?: string;
  owner_id?: string;
  archived?: boolean;
}

export interface SentRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

/**
 * `respond` answers as Discord would and does nothing. `network` gets no answer and
 * does nothing. `lost` does the work and then loses the answer.
 */
export type Failure =
  | { kind: "respond"; status: number; code?: number; body?: unknown }
  | { kind: "network" }
  | { kind: "lost" };

const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;
export const MISSING_ACCESS = 50001;
const CANNOT_EDIT = 50005;

interface Armed {
  method: string;
  path: RegExp;
  failure: Failure;
  times: number;
}

export interface DiscordServer {
  fetch: FetchLike;
  channels: Map<string, FakeChannel>;
  /** Everything sent, in order. */
  requests: SentRequest[];
  /** The bodies of the posts and messages made, in order. */
  posts: () => SentRequest[];
  /** The text the invoking user would see last. */
  lastReply: () => string | undefined;
  /** Requests that wrote anything, leaving out edits of the private reply. */
  publicWrites: () => SentRequest[];
  messageIds: Set<string>;
  addForum: (guildId: string, name?: string) => string;
  addThread: (fields: Omit<FakeChannel, "id" | "type">) => string;
  /** Runs when a post is made, before Discord answers: another retry could get in. */
  onThreadCreated?: (threadId: string) => Promise<unknown>;
  /** Runs as a request arrives, before it is answered, as another change could. */
  onRequest?: (method: string, path: string) => Promise<unknown>;
  fail: (
    method: string,
    path: RegExp,
    failure: Failure,
    times?: number,
  ) => void;
  clearFailures: () => void;
}

// An @everyone or @here with no backslash before it, or with an even number of them,
// which escape each other and leave the @ live.
const LIVE_EVERYONE = /(?<!\\)(?:\\\\)*@(?:everyone|here)/u;
// The `](` that joins a masked link's text to its URL, unless the bracket is escaped.
const MASKED_LINK = /(?<!\\)(?:\\\\)*\]\s*\(/u;

/** Every `content` string in a body, at any depth: messages, posts and text displays. */
function contents(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(contents);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, field]) =>
    key === "content" && typeof field === "string" ? [field] : contents(field),
  );
}

/** What in this JSON body Discord would render live: a ping to all, or a masked link. */
function liveText(json: string): string[] {
  return contents(JSON.parse(json)).flatMap((text) => [
    ...(LIVE_EVERYONE.test(text)
      ? [`a live @everyone or @here in ${text}`]
      : []),
    ...(MASKED_LINK.test(text) ? [`a masked link in ${text}`] : []),
  ]);
}

/** Fails the test if Discord would render anything in this body live. */
export function expectInert(json: string): void {
  expect(liveText(json)).toEqual([]);
}

// What the fake server found live in the bodies sent during the current test.
const liveFound: string[] = [];

/**
 * Fails the test if any body sent to a fake server had live text. The preload calls
 * it after each test, since the client would catch a failure thrown while it sends.
 */
export function expectSentBodiesInert(): void {
  expect(liveFound.splice(0)).toEqual([]);
}

const NOT_FOUND_CHANNEL = {
  kind: "respond",
  status: 404,
  code: UNKNOWN_CHANNEL,
} as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function discordServer(appId: string): DiscordServer {
  const channels = new Map<string, FakeChannel>();
  const requests: SentRequest[] = [];
  const messageIds = new Set<string>();
  let armed: Armed[] = [];
  let threadsMade = 0n;
  let lastThread: string | undefined;

  function takeLastThread(): string | undefined {
    const made = lastThread;
    lastThread = undefined;
    return made;
  }

  /** IDs hold the time they were made, as Discord's do. */
  function threadId(): string {
    threadsMade += 1n;
    const madeAt = Date.now() - DISCORD_EPOCH_MS;
    return ((BigInt(madeAt) << 22n) + threadsMade).toString();
  }

  function failureFor(method: string, path: string): Failure | undefined {
    const match = armed.find(
      (entry) =>
        entry.times > 0 && entry.method === method && entry.path.test(path),
    );
    if (match !== undefined) {
      match.times -= 1;
    }
    return match?.failure;
  }

  function answer(failure: Failure): Response {
    if (failure.kind !== "respond") {
      throw new TypeError("fetch failed");
    }
    return json(failure.body ?? { code: failure.code }, failure.status);
  }

  function route(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
  ): Response {
    const channel = /^\/channels\/([0-9]+)$/.exec(path);
    if (method === "GET" && channel !== null) {
      const found = channels.get(channel[1] ?? "");
      return found === undefined ? answer(NOT_FOUND_CHANNEL) : json(found);
    }
    const active = /^\/guilds\/([0-9]+)\/threads\/active$/.exec(path);
    if (method === "GET" && active !== null) {
      return json({
        threads: [...channels.values()].filter(
          (entry) =>
            entry.guild_id === active[1] &&
            entry.type === THREAD_TYPE &&
            entry.archived !== true,
        ),
      });
    }
    const archived = /^\/channels\/([0-9]+)\/threads\/archived\/public$/.exec(
      path,
    );
    if (method === "GET" && archived !== null) {
      return json({
        threads: [...channels.values()].filter(
          (entry) => entry.parent_id === archived[1] && entry.archived === true,
        ),
      });
    }
    const threads = /^\/channels\/([0-9]+)\/threads$/.exec(path);
    if (method === "POST" && threads !== null) {
      const parent = channels.get(threads[1] ?? "");
      if (parent === undefined) {
        return answer(NOT_FOUND_CHANNEL);
      }
      const id = threadId();
      lastThread = id;
      channels.set(id, {
        id,
        type: THREAD_TYPE,
        guild_id: parent.guild_id,
        parent_id: parent.id,
        name: body?.name as string,
        owner_id: appId,
      });
      messageIds.add(id);
      return json({ id, message: { id } }, 201);
    }
    const messages = /^\/channels\/([0-9]+)\/messages$/.exec(path);
    if (method === "POST" && messages !== null) {
      if (!channels.has(messages[1] ?? "")) {
        return answer(NOT_FOUND_CHANNEL);
      }
      const id = fakeId();
      messageIds.add(id);
      return json({ id });
    }
    const edit = /^\/channels\/([0-9]+)\/messages\/([0-9]+)$/.exec(path);
    if (method === "PATCH" && edit !== null) {
      // A post's first message shares its ID, and only its author can edit it.
      const post = channels.get(edit[2] ?? "");
      if (post !== undefined && post.owner_id !== appId) {
        return answer({ kind: "respond", status: 403, code: CANNOT_EDIT });
      }
      return messageIds.has(edit[2] ?? "")
        ? json({ id: edit[2] })
        : answer({ kind: "respond", status: 404, code: UNKNOWN_MESSAGE });
    }
    if (path.endsWith("/messages/@original")) {
      return json({ id: fakeId(), flags: EPHEMERAL_FLAG });
    }
    throw new Error(`The test server has no route for ${method} ${path}`);
  }

  const server: DiscordServer = {
    channels,
    requests,
    messageIds,
    posts: () =>
      requests.filter(
        (request) =>
          request.method === "POST" &&
          /\/(?:threads|messages)$/.test(request.path),
      ),
    publicWrites: () =>
      requests.filter(
        (request) =>
          request.method !== "GET" &&
          !request.path.endsWith("/messages/@original"),
      ),
    lastReply: () =>
      requests.findLast(
        (request) =>
          request.method === "PATCH" &&
          request.path.endsWith("/messages/@original"),
      )?.body?.content as string | undefined,
    addForum(guildId, name = "events") {
      const id = fakeId();
      channels.set(id, { id, type: 15, guild_id: guildId, name });
      return id;
    },
    addThread(fields) {
      const id = threadId();
      channels.set(id, { id, type: THREAD_TYPE, ...fields });
      return id;
    },
    fail(method, path, failure, times = Number.POSITIVE_INFINITY) {
      armed.push({ method, path, failure, times });
    },
    clearFailures() {
      armed = [];
    },
    fetch: (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      const method = init?.method ?? "GET";
      const path = url.pathname.replace(/^\/api\/v[0-9]+/, "");
      let body: Record<string, unknown> | undefined;
      if (typeof init?.body === "string") {
        liveFound.push(
          ...liveText(init.body).map((live) => `${method} ${path}: ${live}`),
        );
        body = jsonObject(init.body, `the body of ${method} ${path}`);
      }
      requests.push({ method, path, body });
      const before = server.onRequest?.(method, path);
      return before === undefined
        ? answerRequest(method, path, body)
        : before.then(() => answerRequest(method, path, body));
    },
  };

  function answerRequest(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
  ): Promise<Response> {
    const failure = failureFor(method, path);
    if (failure === undefined) {
      const response = route(method, path, body);
      const made = takeLastThread();
      return made !== undefined && server.onThreadCreated !== undefined
        ? server.onThreadCreated(made).then(() => response)
        : Promise.resolve(response);
    }
    if (failure.kind === "network") {
      return Promise.reject(new TypeError("fetch failed"));
    }
    if (failure.kind === "lost") {
      route(method, path, body);
      return Promise.reject(new TypeError("fetch failed"));
    }
    return Promise.resolve(answer(failure));
  }
  return server;
}
