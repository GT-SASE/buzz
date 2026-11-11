/**
 * Who may do what. Every command, button, select and modal calls authorize, and
 * every autocomplete request calls autocompleteScope, with an Actor parsed from that
 * interaction, including a submit from a panel opened earlier. Nothing in a custom_id
 * or an autocomplete value grants anything: they only name a row, which the caller
 * then loads by that ID and the signed guild.
 */

import type { Actor } from "./actor.ts";

/**
 * Officer and admin stack: an admin also holds officer rights, because a Discord
 * Administrator can grant themselves any role anyway, and refusing them would add
 * no security. Bindings stands apart. It needs the Administrator bit, so holding
 * admin_role_id does not reach it. Public is for an action that reveals nothing and
 * changes nothing, and is the only tier that works before setup besides bindings.
 */
export type Tier = "public" | "self" | "officer" | "admin" | "bindings";

/**
 * What row an action needs. "event" is the row named, or the parent of a new task.
 * event.link is "none": it can create a row from an existing thread, so there may be no
 * row to check, and its handler must confirm the thread's guild and parent, and read any
 * row named in its event option within the signed guild.
 */
export type Scope = "none" | "event" | "task";

/** Every action names its tier and scope, so none can default to no row check. */
const COMMAND_TIERS = [
  ["ping", "public", "none"],
  ["setup", "bindings", "none"],
  ["config.view", "admin", "none"],
  ["config.change", "admin", "none"],
  ["event.create", "officer", "none"],
  ["event.link", "officer", "none"],
  ["event.status", "officer", "event"],
  ["event.list", "officer", "none"],
  ["event.close", "officer", "event"],
  ["event.delete", "officer", "event"],
  ["task.assign", "officer", "event"],
  ["task.edit", "officer", "task"],
  ["task.delete", "officer", "task"],
  ["task.done", "self", "task"],
  ["mytasks", "self", "none"],
] as const satisfies readonly (readonly [string, Tier, Scope])[];

/** A public action skips the config read, so it can have no row to check. */
export function assertPublicRowsUnscoped(
  rows: readonly (readonly [string, Tier, Scope])[],
): void {
  for (const [action, tier, scope] of rows) {
    if (tier === "public" && scope !== "none") {
      throw new Error(`Public action ${action} must have scope none`);
    }
  }
}

assertPublicRowsUnscoped(COMMAND_TIERS);

type CommandRow = (typeof COMMAND_TIERS)[number];

export type Action = CommandRow[0];
export type EventScopedAction = Extract<
  CommandRow,
  readonly [string, Tier, "event"]
>[0];
export type TaskScopedAction = Extract<
  CommandRow,
  readonly [string, Tier, "task"]
>[0];
export type UnscopedAction = Exclude<
  Action,
  TaskScopedAction | EventScopedAction
>;

function actionsInScope(scope: Scope): readonly string[] {
  return COMMAND_TIERS.filter((row) => row[2] === scope).map((row) => row[0]);
}

const EVENT_SCOPED_ACTIONS = actionsInScope("event");
const TASK_SCOPED_ACTIONS = actionsInScope("task");

const OBJECT_SCOPED_ACTIONS: ReadonlySet<string> = new Set([
  ...EVENT_SCOPED_ACTIONS,
  ...TASK_SCOPED_ACTIONS,
]);

/**
 * The only source of tiers. A Map, because a plain object would answer truthily
 * for constructor, toString and __proto__. An action that is not here is refused.
 */
export const COMMAND_POLICY: ReadonlyMap<string, Tier> = new Map<string, Tier>(
  COMMAND_TIERS.map((row) => [row[0], row[1]]),
);

/** Turns a name from a payload into an Action, or says it is not one. */
export function isAction(name: string): name is Action {
  return COMMAND_POLICY.has(name);
}

/** Listed by hand: the commands with an event or task picker option. */
const AUTOCOMPLETE_COMMANDS = [
  "task.assign",
  "event.link",
  "event.status",
  "event.close",
  "event.delete",
  "task.edit",
  "task.delete",
  "task.done",
] as const satisfies readonly Action[];

export type AutocompleteCommand = (typeof AUTOCOMPLETE_COMMANDS)[number];

const AUTOCOMPLETE_COMMAND_NAMES: ReadonlySet<string> = new Set(
  AUTOCOMPLETE_COMMANDS,
);

/** Turns a name from a payload into an AutocompleteCommand, or says it is not one. */
export function isAutocompleteCommand(
  name: string,
): name is AutocompleteCommand {
  return AUTOCOMPLETE_COMMAND_NAMES.has(name);
}

/** Which rows an autocomplete query may list, on top of leaving out deleted ones. */
export interface AutocompleteScope {
  readonly guildId: string;
  readonly assigneeId?: string;
}

/** The columns of a guild_config row that decide access. */
export interface AuthorizationConfig {
  readonly guild_id: string;
  readonly officer_role_id: string;
  readonly admin_role_id: string;
}

/** The columns of an events row that decide access. */
export interface EventResource {
  readonly guild_id: string;
  readonly deleted_at: string | null;
}

/** The columns of a tasks row that decide access. */
export interface TaskResource extends EventResource {
  readonly assignee_id: string;
}

/**
 * Not distributive, so a caller holding a bare Action or a union across scopes has
 * no valid call and must narrow first. A distributive form would accept either
 * shape of arguments for such a union, and so let a row be left out.
 */
type ResourceArgs<A extends Action> = [A] extends [TaskScopedAction]
  ? [resource: TaskResource | null | undefined]
  : [A] extends [EventScopedAction]
    ? [resource: EventResource | null | undefined]
    : [A] extends [UnscopedAction]
      ? []
      : [resource: never];

export type Decision = { readonly allowed: true } | typeof REFUSED;

const ALLOWED = Object.freeze({ allowed: true } as const);

/**
 * The one refusal, shared by unknown action, wrong tier, before setup, absent row,
 * another guild's row and deleted row. Callers show this message and nothing else,
 * so a member cannot use replies to find out which rows exist.
 */
export const REFUSED = Object.freeze({
  allowed: false,
  message: "You can't do that, or it doesn't exist.",
} as const);

/**
 * The @everyone role's ID equals the guild ID. The database refuses that binding,
 * and a role bound that way never counts here either, since it would cover everyone.
 */
function holdsBoundRole(actor: Actor, roleId: string): boolean {
  return roleId !== actor.guildId && actor.roleIds.has(roleId);
}

function isAdmin(actor: Actor, config: AuthorizationConfig): boolean {
  return actor.isAdministrator || holdsBoundRole(actor, config.admin_role_id);
}

/** True for officer_role_id and for anyone who is an admin, in the actor's guild. */
export function isOfficer(
  actor: Actor,
  config: AuthorizationConfig | null | undefined,
): boolean {
  return (
    config?.guild_id === actor.guildId &&
    (holdsBoundRole(actor, config.officer_role_id) || isAdmin(actor, config))
  );
}

function holdsTier(
  tier: Tier,
  actor: Actor,
  config: AuthorizationConfig,
): boolean {
  switch (tier) {
    case "public":
    case "self":
      return true;
    case "officer":
      return isOfficer(actor, config);
    case "admin":
      return isAdmin(actor, config);
    case "bindings":
      return actor.isAdministrator;
  }
}

/**
 * Decides one request. An object-scoped action needs its row by type: pass what
 * the lookup returned, so an absent row gets the same refusal as a forbidden one.
 *
 * This is a check at one moment. A write that depends on it must repeat the
 * conditions in its own predicate (ID, guild, assignee, not deleted) and check how
 * many rows changed, because the row can change after this returns.
 */
export function authorize<A extends Action>(
  action: A,
  actor: Actor,
  config: AuthorizationConfig | null | undefined,
  ...resource: ResourceArgs<A>
): Decision;
export function authorize(
  action: string,
  actor: Actor,
  config: AuthorizationConfig | null | undefined,
  resource?: (EventResource & { assignee_id?: string }) | null,
): Decision {
  const tier = COMMAND_POLICY.get(action);
  if (tier === undefined) {
    return REFUSED;
  }
  if (tier === "public") {
    return ALLOWED;
  }

  if (config === null || config === undefined) {
    return tier === "bindings" && actor.isAdministrator ? ALLOWED : REFUSED;
  }
  if (config.guild_id !== actor.guildId) {
    return REFUSED;
  }
  if (!OBJECT_SCOPED_ACTIONS.has(action)) {
    return holdsTier(tier, actor, config) ? ALLOWED : REFUSED;
  }
  // deleted_at must be exactly null: a query that left the column out gives undefined.
  if (resource?.guild_id !== actor.guildId || resource.deleted_at !== null) {
    return REFUSED;
  }
  const permitted =
    tier === "self"
      ? resource.assignee_id === actor.userId || isOfficer(actor, config)
      : holdsTier(tier, actor, config);
  return permitted ? ALLOWED : REFUSED;
}

/**
 * The tier alone, for a route with no time to read its row before answering Discord. It
 * settles nothing about any row, so the route's later work must still call `authorize`
 * on the row it loads.
 */
export function holdsTierFor(
  action: Action,
  actor: Actor,
  config: AuthorizationConfig | null | undefined,
): boolean {
  const tier = COMMAND_POLICY.get(action);
  return (
    tier !== undefined &&
    config?.guild_id === actor.guildId &&
    holdsTier(tier, actor, config)
  );
}

/**
 * Decides one autocomplete request, which has no row to check, and says what its
 * query may list. Returns undefined when refused, and the caller answers with no
 * choices. A self-tier command lists only the actor's own rows unless they are an
 * officer. The query must also apply these values and leave out deleted rows.
 */
export function autocompleteScope(
  command: AutocompleteCommand,
  actor: Actor,
  config: AuthorizationConfig | null | undefined,
): AutocompleteScope | undefined {
  const tier = COMMAND_POLICY.get(command);
  if (
    !isAutocompleteCommand(command) ||
    tier === undefined ||
    config?.guild_id !== actor.guildId ||
    !holdsTier(tier, actor, config)
  ) {
    return undefined;
  }
  return tier === "self" && !isOfficer(actor, config)
    ? { guildId: actor.guildId, assigneeId: actor.userId }
    : { guildId: actor.guildId };
}
