/**
 * Turns a verified interaction into a reply. To add a command, write one file in
 * this directory that exports `handler`, and add one line to modules.ts.
 *
 * Nothing runs unless a route was found by exact match in a Map, so `constructor`
 * and `__proto__` find nothing, and its gate ran `authorize`, `holdsTierFor` or
 * `autocompleteScope` with an actor parsed from this interaction's own signed payload. Nothing in a
 * custom_id grants anything: it names a route and carries validated IDs and a
 * version, and each one is checked again by the handler that uses it.
 *
 * Discord allows 3 seconds for the first reply, so the router makes one read of at
 * most 1.5 seconds before answering, which leaves time for the fixed reply if it
 * fails. Anything slower goes in `finish`: the reply is a private acknowledgement,
 * and the work runs after it on a client with a longer deadline, with a
 * state-changing route first claiming the interaction so that a replayed request
 * changes nothing. The content of that work goes back through Discord with the
 * interaction's token, so a replayer of the HTTP request does not receive it.
 *
 * Autocomplete is the exception: Discord takes its choices only in the HTTP response,
 * so it cannot be deferred, and nothing claims it. Replaying a captured signed request
 * inside the signature window gets the choices, read fresh, in the response.
 *
 * Do not log anything from the payload: only the action and an error's type.
 */

import {
  commandPath,
  focusedOption,
  isAutocompleteRequest,
  isChatInputCommand,
  isComponentInteraction,
  isModalInteraction,
  isOnEphemeralMessage,
} from "../discord/interactions.ts";
import type { GuildInteraction } from "../discord/interactions.ts";
import {
  autocompleteResult,
  deferredEphemeralReply,
  deferredUpdate,
  ephemeralReply,
  messageEdit,
} from "../discord/outbound.ts";
import type {
  AutocompleteChoice,
  MessageInput,
  OutboundBody,
} from "../discord/outbound.ts";
import { DISCORD_LIMITS, isWithinLimit, safe } from "../discord/safe-text.ts";
import { DiscordClientError } from "../discord/client.ts";
import type { DiscordClient } from "../discord/client.ts";
import type { VerifiedInteraction } from "../discord/verify.ts";
import type { DbClient } from "../db/client.ts";
import { errorSummary, type DbResult } from "../db/errors.ts";
import { getGuildConfig } from "../db/guild-config.ts";
import { claimInteraction } from "../db/interaction-claims.ts";
import type { GuildConfig } from "../db/types.ts";
import { isUuid, isVersion } from "../db/validate.ts";
import { parseActor } from "../lib/actor.ts";
import type { Actor } from "../lib/actor.ts";
import {
  authorize,
  autocompleteScope,
  COMMAND_POLICY,
  holdsTierFor,
  isAction,
  isAutocompleteCommand,
} from "../lib/permissions.ts";
import type {
  Action,
  AutocompleteCommand,
  AutocompleteScope,
  EventResource,
  EventScopedAction,
  TaskResource,
  TaskScopedAction,
  UnscopedAction,
} from "../lib/permissions.ts";
import { isSnowflake } from "../lib/snowflake.ts";

/** Everything a custom_id may carry after its prefix. */
export type FieldKind = "snowflake" | "uuid" | "version" | "fingerprint";

type FieldValue<K extends FieldKind> = K extends "version" ? number : string;

export type FieldValues<F extends readonly FieldKind[]> = {
  readonly [I in keyof F]: FieldValue<F[I]>;
};

const SEPARATOR = ":";
const VERSION = /^(?:0|[1-9][0-9]{0,9})$/;
const FINGERPRINT = /^[0-9a-f]{16}$/;
// A plain name, so a prefix can never be mistaken for a field or hold a separator.
const PREFIX = /^[a-z][a-z0-9._-]{0,30}$/;

function parseField(kind: FieldKind, raw: string): string | number | undefined {
  switch (kind) {
    case "snowflake":
      return isSnowflake(raw) ? raw : undefined;
    case "uuid":
      return isUuid(raw) ? raw : undefined;
    case "fingerprint":
      return FINGERPRINT.test(raw) ? raw : undefined;
    case "version": {
      const version = VERSION.test(raw) ? Number(raw) : undefined;
      return isVersion(version) ? version : undefined;
    }
  }
}

function parseFields(
  kinds: readonly FieldKind[],
  raw: readonly string[],
): (string | number)[] | undefined {
  if (raw.length !== kinds.length) {
    return undefined;
  }
  const values: (string | number)[] = [];
  for (const [index, kind] of kinds.entries()) {
    const value = parseField(kind, raw[index] ?? "");
    if (value === undefined) {
      return undefined;
    }
    values.push(value);
  }
  return values;
}

/** What Discord allows a command option to say, as sent when registering. */
export interface CommandOption {
  readonly type: number;
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
  readonly autocomplete?: boolean;
  readonly max_length?: number;
  readonly channel_types?: readonly number[];
  /** The options of a subcommand. */
  readonly options?: readonly CommandOption[];
}

/** What Discord allows a command definition to say, as sent when registering. */
export interface CommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly default_member_permissions?: string;
  readonly options?: readonly CommandOption[];
}

/** What every route can read. All of it comes from this interaction's payload. */
export interface RouteContext {
  /** Read fields through the guards in src/discord/interactions.ts. */
  readonly payload: GuildInteraction;
  readonly verified: VerifiedInteraction;
  readonly actor: Actor;
  /** Read for this interaction. Null means setup has not been done. */
  readonly config: GuildConfig | null;
  readonly db: DbClient;
}

/** A `finish` step runs after the reply, so it has time to call Discord. */
export interface FinishContext extends RouteContext {
  readonly discord: DiscordClient;
}

type GateOutcome<R> =
  | { readonly kind: "allowed"; readonly resource: R }
  | { readonly kind: "refused" }
  | { readonly kind: "unavailable" };

const MINTED = Symbol("Gate");

/**
 * Decides a route. Only `noRow`, `eventRow`, `taskRow` and `tierOnly` make one. The first
 * three pass through `authorize` with the row their action needs, so absent and forbidden
 * get the same refusal. `tierOnly` checks the tier and leaves the row to its `finish`. A gate refers to itself under a private symbol, which a copy or a
 * hand-written object cannot do, and `createRouter` refuses anything else.
 */
export interface Gate<R, V> {
  readonly action: Action;
  readonly check: (ctx: RouteContext, values: V) => Promise<GateOutcome<R>>;
  /** Settled nothing about a row, so the route must do that after acknowledging. */
  readonly tierOnly: boolean;
  readonly [MINTED]: unknown;
}

function mintGate<R, V>(
  action: Action,
  check: Gate<R, V>["check"],
  tierOnly = false,
): Gate<R, V> {
  const gate = { action, check, tierOnly, [MINTED]: undefined as unknown };
  gate[MINTED] = gate;
  return Object.freeze(gate);
}

const REFUSE = { kind: "refused" } as const;

export function noRow(action: UnscopedAction): Gate<undefined, unknown> {
  return mintGate(action, ({ actor, config }) =>
    Promise.resolve(
      authorize<UnscopedAction>(action, actor, config).allowed
        ? { kind: "allowed", resource: undefined }
        : REFUSE,
    ),
  );
}

/**
 * For an action on a row, when the router's config read has used the one read there is
 * time for before answering. It refuses the wrong tier at once and hands over no row, so
 * `finish` must load the row and call `authorize` itself, and `createRouter` refuses to
 * pair this gate with a `reply`, which would act with no row checked.
 */
export function tierOnly(
  action: EventScopedAction | TaskScopedAction,
): Gate<undefined, unknown> {
  return mintGate(
    action,
    ({ actor, config }) =>
      Promise.resolve(
        holdsTierFor(action, actor, config)
          ? { kind: "allowed", resource: undefined }
          : REFUSE,
      ),
    true,
  );
}

function rowGate<R, V>(
  action: Action,
  load: (ctx: RouteContext, values: V) => Promise<DbResult<R | null>>,
  decide: (ctx: RouteContext, row: R | null) => boolean,
): Gate<R, V> {
  return mintGate(action, async (ctx, values) => {
    const row = await load(ctx, values);
    if (!row.ok) {
      return row.error.category === "unavailable"
        ? { kind: "unavailable" }
        : REFUSE;
    }
    return row.value !== null && decide(ctx, row.value)
      ? { kind: "allowed", resource: row.value }
      : REFUSE;
  });
}

/** `load` reads by ID and signed guild. Null and another guild's row both refuse. */
export function eventRow<R extends EventResource, V>(
  action: EventScopedAction,
  load: (ctx: RouteContext, values: V) => Promise<DbResult<R | null>>,
): Gate<R, V> {
  return rowGate(
    action,
    load,
    ({ actor, config }, row) =>
      authorize<EventScopedAction>(action, actor, config, row).allowed,
  );
}

/** `load` reads by ID and signed guild. Null and another guild's row both refuse. */
export function taskRow<R extends TaskResource, V>(
  action: TaskScopedAction,
  load: (ctx: RouteContext, values: V) => Promise<DbResult<R | null>>,
): Gate<R, V> {
  return rowGate(
    action,
    load,
    ({ actor, config }, row) =>
      authorize<TaskScopedAction>(action, actor, config, row).allowed,
  );
}

type Plan =
  | { readonly kind: "refuse" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "reply";
      readonly reply: (ctx: RouteContext) => OutboundBody<"direct-response">;
    }
  | {
      readonly kind: "finish";
      readonly finish: (ctx: FinishContext) => Promise<MessageInput>;
    };

/** One entry in the router's tables. The router runs its gate, then its step. */
export interface Route {
  readonly surface: "command" | "component" | "modal";
  /** The command path, or the custom_id prefix. */
  readonly key: string;
  readonly action: Action;
  readonly changesState: boolean;
  /** A component whose message others can see, so it answers in a new private one. */
  readonly onPublicMessage?: boolean;
  readonly fields: readonly FieldKind[];
  readonly gate: Gate<unknown, never>;
  readonly step: ImmediateStep<never> | DeferredStep<never, never>;
}

export interface ComponentRoute<F extends readonly FieldKind[]> extends Route {
  /** The custom_id for this route. Throws if the parser here would refuse it. */
  readonly id: (...values: FieldValues<F>) => string;
}

export interface AutocompleteRoute {
  readonly surface: "autocomplete";
  readonly key: string;
  readonly action: AutocompleteCommand;
  readonly choices: (
    ctx: RouteContext,
    scope: AutocompleteScope,
    typed: string,
  ) => Promise<readonly AutocompleteChoice[]>;
}

/** What a handler file exports. Its commands must each have a route. */
export interface Handler {
  readonly commands: readonly CommandDefinition[];
  readonly routes: readonly (Route | AutocompleteRoute)[];
}

/** The route answers now, from what the router already read. */
export interface ImmediateStep<R> {
  readonly reply: (
    ctx: RouteContext,
    resource: R,
  ) => OutboundBody<"direct-response">;
}

/** The route acknowledges now and finishes afterwards. */
export interface DeferredStep<R, V> {
  /** Claims the interaction before `finish`, so a replay changes nothing. */
  readonly changesState: boolean;
  readonly finish: (
    ctx: FinishContext,
    resource: R,
    values: V,
  ) => Promise<MessageInput>;
}

async function planFor(
  route: Route,
  ctx: RouteContext,
  values: unknown,
): Promise<Plan> {
  const gate = route.gate as Gate<unknown, unknown>;
  const step = route.step as
    ImmediateStep<unknown> | DeferredStep<unknown, unknown>;
  const outcome = await gate.check(ctx, values);
  if (outcome.kind === "refused") {
    return { kind: "refuse" };
  }
  if (outcome.kind === "unavailable") {
    return { kind: "unavailable" };
  }
  const { resource } = outcome;
  return "reply" in step
    ? { kind: "reply", reply: (context) => step.reply(context, resource) }
    : {
        kind: "finish",
        finish: (context) => step.finish(context, resource, values),
      };
}

export function commandRoute<R>(
  input: { readonly path: string; readonly gate: Gate<R, undefined> } & (
    ImmediateStep<R> | DeferredStep<R, undefined>
  ),
): Route {
  return {
    surface: "command",
    key: input.path,
    action: input.gate.action,
    changesState: "changesState" in input && input.changesState,
    fields: [],
    gate: input.gate,
    step: input,
  };
}

function customIdRoute<const F extends readonly FieldKind[], R>(
  surface: "component" | "modal",
  input: {
    readonly prefix: string;
    readonly fields: F;
    readonly gate: Gate<R, FieldValues<F>>;
    readonly onPublicMessage?: boolean;
  } & DeferredStep<R, FieldValues<F>>,
): ComponentRoute<F> {
  const { prefix, fields, gate } = input;
  return {
    surface,
    key: prefix,
    action: gate.action,
    changesState: input.changesState,
    onPublicMessage: input.onPublicMessage === true,
    fields,
    gate,
    step: input,
    id: (...values) => {
      const id = [prefix, ...values.map(String)].join(SEPARATOR);
      const parsed = parseFields(fields, id.split(SEPARATOR).slice(1));
      if (
        parsed === undefined ||
        !isWithinLimit(id, DISCORD_LIMITS.customId) ||
        parsed.some((value, index) => value !== values[index])
      ) {
        throw new RangeError("This custom_id would be refused when clicked");
      }
      return id;
    },
  };
}

/**
 * A button or select. `fields` lists what follows the prefix. The values are read
 * only as row references: `finish` must load and check anything it acts on.
 *
 * It normally sits on a private panel and redraws that panel. With `onPublicMessage`
 * it may sit on a message anyone can see, which it leaves alone: the clicker gets a
 * new private reply, and everyone else who clicks gets their own.
 */
export function componentRoute<const F extends readonly FieldKind[], R>(
  input: {
    readonly prefix: string;
    readonly fields: F;
    readonly gate: Gate<R, FieldValues<F>>;
    readonly onPublicMessage?: boolean;
  } & DeferredStep<R, FieldValues<F>>,
): ComponentRoute<F> {
  return customIdRoute("component", input);
}

export function modalRoute<const F extends readonly FieldKind[], R>(
  input: {
    readonly prefix: string;
    readonly fields: F;
    readonly gate: Gate<R, FieldValues<F>>;
  } & DeferredStep<R, FieldValues<F>>,
): ComponentRoute<F> {
  return customIdRoute("modal", input);
}

export function autocompleteRoute(input: {
  readonly path: string;
  readonly action: AutocompleteCommand;
  readonly choices: AutocompleteRoute["choices"];
}): AutocompleteRoute {
  return {
    surface: "autocomplete",
    key: input.path,
    action: input.action,
    choices: input.choices,
  };
}

/** What the router needs from outside. Lazy, so a refusal reads no setting. */
export interface RouterDependencies {
  /** For the read before the acknowledgement, with a short deadline. */
  readonly db: () => DbClient;
  /** For the work after the acknowledgement, which has longer to run. */
  readonly finishDb: () => DbClient;
  readonly discord: () => DiscordClient;
}

export interface RouteOutcome {
  readonly reply: OutboundBody<"direct-response">;
  /** Pass to `waitUntil`. It runs after the reply and never rejects. */
  readonly after?: () => Promise<void>;
}

/**
 * The one refusal, for an unknown route, a malformed custom_id and a failed gate.
 * It says the same as `REFUSED`, so nothing tells a caller which of these it was.
 */
export function refusal(): OutboundBody<"direct-response"> {
  return ephemeralReply({
    content: safe`You can't do that, or it doesn't exist.`,
    mentionUserIds: [],
  });
}

const UNAVAILABLE_TEXT = safe`Something went wrong. Nothing else was changed. Please try again in a moment.`;

/**
 * A request that timed out may still have finished in the database, so a route that
 * writes cannot say that nothing changed.
 */
const MAYBE_SAVED_TEXT = safe`Something went wrong and this may or may not have been saved. Check before trying again.`;

function failureInput(route: Route): MessageInput {
  return {
    content: route.changesState ? MAYBE_SAVED_TEXT : UNAVAILABLE_TEXT,
    mentionUserIds: [],
    components: [],
  };
}

function unavailable(): OutboundBody<"direct-response"> {
  return ephemeralReply({ content: UNAVAILABLE_TEXT, mentionUserIds: [] });
}

/** A database failure in a `finish` step. The summary holds a category and a code. */
export class HandlerFailure extends Error {
  constructor(summary: string) {
    super(summary);
    this.name = "HandlerFailure";
  }
}

/** The value, or a throw that the router turns into the fixed "try again" reply. */
export function valueOf<T>(result: DbResult<T>): T {
  if (!result.ok) {
    throw new HandlerFailure(errorSummary(result.error));
  }
  return result.value;
}

/** Fixed words and numbers only, with no ID, URL or text from Discord. */
function discordFailureDetail({ failure }: DiscordClientError): string {
  const status = "status" in failure ? ` status=${String(failure.status)}` : "";
  const code = "code" in failure ? ` code=${String(failure.code)}` : "";
  return `DiscordClientError kind=${failure.kind}${status}${code}`;
}

function logFailure(action: Action, error: unknown): void {
  const detail =
    error instanceof HandlerFailure
      ? error.message
      : error instanceof DiscordClientError
        ? discordFailureDetail(error)
        : error instanceof Error
          ? error.name
          : "unknown error";
  console.error(`Interaction failed: ${action}: ${detail}`);
}

function commandsOf(definition: CommandDefinition): string[] {
  const SUBCOMMAND = 1;
  const subcommands = (definition.options ?? []).filter(
    (option) => option.type === SUBCOMMAND,
  );
  return subcommands.length > 0
    ? subcommands.map((option) => `${definition.name} ${option.name}`)
    : [definition.name];
}

export interface Router {
  readonly routes: readonly (Route | AutocompleteRoute)[];
  handle(
    payload: GuildInteraction,
    verified: VerifiedInteraction,
    dependencies: RouterDependencies,
  ): Promise<RouteOutcome>;
}

/** A gate from the builders above, for this route's own action. */
function checkGate(route: Route): void {
  const { gate } = route;
  if (gate[MINTED] !== gate || gate.action !== route.action) {
    throw new Error(`Route ${route.key} has a gate not made by this module`);
  }
}

/** A tier-only gate checked no row, so only a step that loads one can follow it. */
function checkTierOnly(route: Route): void {
  if (route.gate.tierOnly && "reply" in route.step) {
    throw new Error(
      `Route ${route.key} checks no row, so it cannot just reply`,
    );
  }
}

/** A public action runs before setup with no database, so it may only answer. */
function checkPublic(route: Route): void {
  if (
    COMMAND_POLICY.get(route.action) === "public" &&
    (route.changesState || "finish" in route.step)
  ) {
    throw new Error(`Route ${route.key} is public, so it can only reply`);
  }
}

/**
 * Builds the tables. Throws at load time on a route with an unmapped action, an
 * action from another command's family, a gate not made here, a public route that
 * does more than reply, a duplicate key, a badly formed prefix, a command with no
 * route or a route with no command, so none of these can reach a deployment.
 */
export function createRouter(handlers: readonly Handler[]): Router {
  const tables = {
    command: new Map<string, Route>(),
    component: new Map<string, Route>(),
    modal: new Map<string, Route>(),
    autocomplete: new Map<string, AutocompleteRoute>(),
  };
  const routes = handlers.flatMap((handler) => handler.routes);
  for (const route of routes) {
    if (!isAction(route.action)) {
      throw new Error(`Route ${route.key} has an unmapped action`);
    }
    if (
      (route.surface === "component" || route.surface === "modal") &&
      !PREFIX.test(route.key)
    ) {
      throw new Error(`Route ${route.key} has a badly formed prefix`);
    }
    if (route.key.split(/[ .]/)[0] !== route.action.split(".")[0]) {
      throw new Error(
        `Route ${route.key} does not match action ${route.action}`,
      );
    }
    if (route.surface === "autocomplete") {
      if (!isAutocompleteCommand(route.action)) {
        throw new Error(`Route ${route.key} cannot use autocomplete`);
      }
      if (tables.autocomplete.has(route.key)) {
        throw new Error(`Duplicate route ${route.key}`);
      }
      tables.autocomplete.set(route.key, route);
      continue;
    }
    checkGate(route);
    checkTierOnly(route);
    checkPublic(route);
    const table = tables[route.surface];
    if (table.has(route.key)) {
      throw new Error(`Duplicate route ${route.key}`);
    }
    table.set(route.key, route);
  }

  const defined = new Set(
    handlers.flatMap((handler) => handler.commands.flatMap(commandsOf)),
  );
  for (const path of defined) {
    if (!tables.command.has(path)) {
      throw new Error(`Command ${path} has no route`);
    }
  }
  for (const path of [
    ...tables.command.keys(),
    ...tables.autocomplete.keys(),
  ]) {
    if (!defined.has(path)) {
      throw new Error(`Route ${path} has no registered command`);
    }
  }

  function customIdTarget(
    table: ReadonlyMap<string, Route>,
    customId: string,
  ): { route: Route; values: readonly unknown[] } | undefined {
    if (!isWithinLimit(customId, DISCORD_LIMITS.customId)) {
      return undefined;
    }
    const [prefix = "", ...raw] = customId.split(SEPARATOR);
    const route = table.get(prefix);
    const values = route && parseFields(route.fields, raw);
    return route && values && { route, values };
  }

  function findTarget(
    payload: GuildInteraction,
  ): { route: Route; values: readonly unknown[] } | undefined {
    if (isChatInputCommand(payload)) {
      const path = commandPath(payload);
      const route = path === undefined ? undefined : tables.command.get(path);
      return route && { route, values: [] };
    }
    if (isComponentInteraction(payload)) {
      return customIdTarget(tables.component, payload.data.custom_id);
    }
    if (isModalInteraction(payload)) {
      return customIdTarget(tables.modal, payload.data.custom_id);
    }
    return undefined;
  }

  async function answerAutocomplete(
    payload: GuildInteraction,
    verified: VerifiedInteraction,
    dependencies: RouterDependencies,
    route: AutocompleteRoute,
  ): Promise<RouteOutcome> {
    const none = { reply: autocompleteResult([]) };
    const actor = parseActor(payload);
    const typed = focusedOption(payload);
    if (
      actor === undefined ||
      typed === undefined ||
      !isWithinLimit(typed.value, DISCORD_LIMITS.autocompleteChoiceValue)
    ) {
      return none;
    }
    const db = dependencies.db();
    const config = await getGuildConfig(db, { guildId: actor.guildId });
    if (!config.ok) {
      return none;
    }
    const scope = autocompleteScope(route.action, actor, config.value);
    if (scope === undefined) {
      return none;
    }
    const ctx = { payload, verified, actor, config: config.value, db };
    try {
      return {
        reply: autocompleteResult(await route.choices(ctx, scope, typed.value)),
      };
    } catch (error) {
      logFailure(route.action, error);
      return none;
    }
  }

  async function runFinish(
    route: Route,
    finish: (ctx: FinishContext) => Promise<MessageInput>,
    ctx: FinishContext,
  ): Promise<void> {
    const { discord, db, verified } = ctx;
    const edit = (input: MessageInput) =>
      discord.editEphemeralReply(
        verified,
        messageEdit({ ...input, components: input.components ?? [] }),
      );
    try {
      if (route.changesState) {
        const claim = await claimInteraction(db, {
          interactionId: verified.id,
        });
        // A replay stops here: the first delivery has the reply to give.
        if (!valueOf(claim)) {
          return;
        }
      }
      await edit(await finish(ctx));
    } catch (error) {
      logFailure(route.action, error);
      try {
        await edit(failureInput(route));
      } catch (editError) {
        logFailure(route.action, editError);
      }
    }
  }

  return {
    routes,
    async handle(payload, verified, dependencies) {
      if (isAutocompleteRequest(payload)) {
        const path = commandPath(payload);
        const route =
          path === undefined ? undefined : tables.autocomplete.get(path);
        return route === undefined
          ? { reply: autocompleteResult([]) }
          : answerAutocomplete(payload, verified, dependencies, route);
      }

      const target = findTarget(payload);
      const actor = parseActor(payload);
      if (target === undefined || actor === undefined) {
        return { reply: refusal() };
      }
      const { route, values } = target;
      // A deferred update edits the message the click came from, so it must be private.
      const updatesItsMessage =
        route.surface === "component" && route.onPublicMessage !== true;
      if (updatesItsMessage && !isOnEphemeralMessage(payload)) {
        return { reply: refusal() };
      }

      let config: GuildConfig | null = null;
      // A public action must work before setup and with no database settings.
      if (COMMAND_POLICY.get(route.action) !== "public") {
        const read = await getGuildConfig(dependencies.db(), {
          guildId: actor.guildId,
        });
        if (!read.ok) {
          return { reply: unavailable() };
        }
        config = read.value;
      }

      const ctx: RouteContext = {
        payload,
        verified,
        actor,
        config,
        get db() {
          return dependencies.db();
        },
      };
      const plan = await planFor(route, ctx, values);
      switch (plan.kind) {
        case "refuse":
          return { reply: refusal() };
        case "unavailable":
          return { reply: unavailable() };
        case "reply":
          return { reply: plan.reply(ctx) };
        case "finish": {
          // Built now, so a missing setting fails while Discord can still be told.
          const discord = dependencies.discord();
          const db = dependencies.finishDb();
          return {
            reply: updatesItsMessage
              ? deferredUpdate()
              : deferredEphemeralReply(),
            after: () =>
              runFinish(route, plan.finish, {
                payload,
                verified,
                actor,
                config,
                db,
                discord,
              }),
          };
        }
      }
    },
  };
}
