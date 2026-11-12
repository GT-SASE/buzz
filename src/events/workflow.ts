/**
 * The event workflow's commands and buttons: /event assign, /event unassign and
 * /event pickup, the people picked on /event create, and the overview's Budget Sheet
 * done, Engage post done and Budget approved buttons with the ping that follows each.
 *
 * Every value from a payload only names a row, which is loaded by ID and the signed
 * guild, and the actor is checked against what was loaded. A button can sit on the
 * public overview, so anyone can click it: Budget Sheet and Engage post take an assignee
 * of that step or an officer, and Budget approved takes an officer or the Treasury role.
 *
 * The router claims each interaction first, so a replay changes nothing. A step is done
 * by one call only, but every click on a done step tries the ping that follows, which the
 * database hands out once. A double click, a replay or two people at once ping once, a
 * crash before the claim is made good by the next click or /event link, and a crash
 * between the claim and the send loses the ping rather than sending it twice.
 */

import { ApplicationCommandOptionType } from "discord-api-types/v10";
import { DiscordClientError } from "../discord/client.ts";
import { commandOptionValue, resolvedPerson } from "../discord/interactions.ts";
import { channelMessage } from "../discord/outbound.ts";
import type { MessageInput } from "../discord/outbound.ts";
import {
  escapeUserText,
  roleMention,
  safe,
  userMention,
} from "../discord/safe-text.ts";
import type { SafeText } from "../discord/safe-text.ts";
import { isThreadChannelType } from "../discord/verify.ts";
import { errorSummary } from "../db/errors.ts";
import {
  assignEventStep,
  claimStepHandoff,
  completeEventStep,
  getEventWorkflow,
  markStepHandoffSent,
  MAX_ASSIGNEES_PER_STEP,
  MAX_FOOD_PICKUP_ASSIGNEES,
  setEventPickupTime,
  unassignEventStep,
} from "../db/event-steps.ts";
import { getEvent } from "../db/events.ts";
import { getManagedChannel } from "../db/managed-channels.ts";
import { findEventByThread } from "../db/task-events.ts";
import type {
  AssignableStepKind,
  CompletableStepKind,
  EventRow,
  GuildConfig,
} from "../db/types.ts";
import { ASSIGNABLE_STEP_KINDS } from "../db/types.ts";
import {
  authorize,
  canApproveBudget,
  canCompleteStep,
  type EventScopedAction,
} from "../lib/permissions.ts";
import {
  commandRoute,
  componentRoute,
  noRow,
  tierOnly,
  valueOf,
  type CommandOption,
  type FinishContext,
  type Route,
} from "../handlers/router.ts";
import { lines } from "../handlers/render.ts";
import {
  chosenEventId,
  PICK_FROM_LIST,
  REFUSED_TEXT,
  stringOption,
} from "../tasks/shared.ts";
import { reachWarning } from "../tasks/notify.ts";
import { MAX_PICKUP_INPUT_LENGTH, parsePickupTime } from "./input.ts";
import {
  dateText,
  eventTitle,
  refreshOverview,
  threadTarget,
} from "./overview.ts";
import {
  pickupTimeText,
  STEP_BUTTON_PREFIX,
  stepName,
  stepOwnerIds,
  type ButtonStepKind,
} from "./steps.ts";

const EVENT_CLOSED = safe`That event is closed, so its steps can't change.`;
const NO_EVENT = safe`Run this in an event's post, or choose the event in the event option.`;
const OVERVIEW_BEHIND = safe`The change is saved, but I couldn't update the event's overview, so it's out of date until the next change.`;

function message(content: SafeText): MessageInput {
  return { content, mentionUserIds: [] };
}

function withNotes(
  reply: SafeText,
  ...notes: readonly (SafeText | undefined)[]
): MessageInput {
  const present = notes.filter((note) => note !== undefined);
  return message(lines([reply, ...present]) ?? reply);
}

function logFailure(what: string, detail: string): void {
  console.error(`Event workflow ${what} failed: ${detail}`);
}

/** The step a person can be put on, from the option's fixed choices. */
function isAssignableKind(value: unknown): value is AssignableStepKind {
  return ASSIGNABLE_STEP_KINDS.some((kind) => kind === value);
}

function capOf(kind: AssignableStepKind): number {
  return kind === "food_pickup"
    ? MAX_FOOD_PICKUP_ASSIGNEES
    : MAX_ASSIGNEES_PER_STEP;
}

type Person = { readonly id: string } | { readonly problem: SafeText };

/** A person comes from `resolved`, so never from anything the actor typed. */
function personOption(payload: unknown, name: string): Person | undefined {
  const raw = commandOptionValue(
    payload,
    name,
    ApplicationCommandOptionType.User,
  );
  if (raw === undefined) {
    return undefined;
  }
  const person =
    typeof raw === "string" ? resolvedPerson(payload, raw) : undefined;
  if (person?.isMember !== true) {
    return { problem: safe`That person isn't a member of this server.` };
  }
  if (person.isBot) {
    return { problem: safe`Steps can't be given to bots.` };
  }
  return { id: person.id };
}

/** Says whether the event's overview is current after a change, as a reply line. */
async function redraw(
  ctx: FinishContext,
  event: EventRow,
): Promise<SafeText | undefined> {
  const current = await refreshOverview(ctx, event);
  return current || event.thread_status !== "active"
    ? undefined
    : OVERVIEW_BEHIND;
}

type Chosen =
  | { readonly kind: "event"; readonly event: EventRow }
  | { readonly kind: "problem"; readonly problem: SafeText };

/**
 * The event a command names, or else the post it runs in, if this officer may change
 * it. A typed value that is no ID, and a row that is absent, deleted, another guild's
 * or forbidden all get a fixed reply that says nothing about which.
 */
async function chooseEvent(
  ctx: FinishContext,
  action: EventScopedAction,
): Promise<Chosen> {
  const guildId = ctx.actor.guildId;
  const option = stringOption(ctx.payload, "event");
  if (option === undefined && !isThreadChannelType(ctx.verified.channelType)) {
    return { kind: "problem", problem: NO_EVENT };
  }
  const named =
    option === undefined ? undefined : await chosenEventId(ctx, option);
  if (option !== undefined && named === undefined) {
    return { kind: "problem", problem: PICK_FROM_LIST };
  }
  const read =
    named !== undefined
      ? await getEvent(ctx.db, { guildId, eventId: named })
      : await findEventByThread(ctx.db, {
          guildId,
          threadId: ctx.verified.channelId,
        });
  if (!read.ok && read.error.category === "invalid_input") {
    return { kind: "problem", problem: REFUSED_TEXT };
  }
  const event = valueOf(read);
  if (event === null) {
    return {
      kind: "problem",
      problem: named === undefined ? NO_EVENT : REFUSED_TEXT,
    };
  }
  if (
    !authorize<EventScopedAction>(action, ctx.actor, ctx.config, event).allowed
  ) {
    return { kind: "problem", problem: REFUSED_TEXT };
  }
  return event.status === "active"
    ? { kind: "event", event }
    : { kind: "problem", problem: EVENT_CLOSED };
}

function onEvent(
  action: EventScopedAction,
  step: (ctx: FinishContext, event: EventRow) => Promise<MessageInput>,
): (ctx: FinishContext) => Promise<MessageInput> {
  return async (ctx) => {
    const chosen = await chooseEvent(ctx, action);
    return chosen.kind === "event"
      ? step(ctx, chosen.event)
      : message(chosen.problem);
  };
}

function stepOption(ctx: FinishContext): AssignableStepKind | undefined {
  const value = stringOption(ctx.payload, "step");
  return isAssignableKind(value) ? value : undefined;
}

const PICK_STEP = safe`Choose Budget Sheet, Engage post or Food pickup from the step option's list.`;

function capText(kind: AssignableStepKind): SafeText {
  return safe`${stepName(kind)} already has ${escapeUserText(String(capOf(kind)))} people, the most it can have. Unassign someone first. Nothing was changed.`;
}

async function assign(
  ctx: FinishContext,
  event: EventRow,
): Promise<MessageInput> {
  const kind = stepOption(ctx);
  if (kind === undefined) {
    return message(PICK_STEP);
  }
  const person = personOption(ctx.payload, "user");
  if (person === undefined || "problem" in person) {
    return message(person?.problem ?? safe`Choose who to assign.`);
  }
  const written = await assignEventStep(ctx.db, {
    guildId: ctx.actor.guildId,
    eventId: event.id,
    kind,
    userId: person.id,
    actorId: ctx.actor.userId,
  });
  if (!written.ok) {
    switch (written.error.category) {
      case "step_assignee_limit":
        return message(capText(kind));
      case "parent_unavailable":
        return message(EVENT_CLOSED);
      case "not_found":
        return message(REFUSED_TEXT);
    }
  }
  const title = eventTitle(event);
  if (!valueOf(written)) {
    return message(
      safe`${userMention(person.id)} is already on ${stepName(kind)} for **${title}**, so nothing was changed.`,
    );
  }
  const reply = safe`Put ${userMention(person.id)} on ${stepName(kind)} for **${title}**.`;
  const hint =
    kind === "food_pickup" ? await pickupHint(ctx, event) : undefined;
  const reach = await reachWarning(ctx, event, person.id, "step");
  return withNotes(reply, hint, reach, await redraw(ctx, event));
}

/** After a person is put on Food pickup, says if the time is still missing. */
async function pickupHint(
  ctx: FinishContext,
  event: EventRow,
): Promise<SafeText | undefined> {
  const workflow = await getEventWorkflow(ctx.db, {
    guildId: event.guild_id,
    eventId: event.id,
  });
  return workflow.ok && workflow.value?.pickup_time === null
    ? safe`Set the pickup time with /event pickup.`
    : undefined;
}

async function unassign(
  ctx: FinishContext,
  event: EventRow,
): Promise<MessageInput> {
  const kind = stepOption(ctx);
  if (kind === undefined) {
    return message(PICK_STEP);
  }
  const person = personOption(ctx.payload, "user");
  if (person === undefined || "problem" in person) {
    return message(person?.problem ?? safe`Choose who to unassign.`);
  }
  const written = await unassignEventStep(ctx.db, {
    guildId: ctx.actor.guildId,
    eventId: event.id,
    kind,
    userId: person.id,
    actorId: ctx.actor.userId,
  });
  if (!written.ok && written.error.category === "parent_unavailable") {
    return message(EVENT_CLOSED);
  }
  if (!written.ok && written.error.category === "not_found") {
    return message(REFUSED_TEXT);
  }
  const title = eventTitle(event);
  if (!valueOf(written)) {
    return message(
      safe`${userMention(person.id)} isn't on ${stepName(kind)} for **${title}**, so nothing was changed.`,
    );
  }
  return withNotes(
    safe`Took ${userMention(person.id)} off ${stepName(kind)} for **${title}**.`,
    await redraw(ctx, event),
  );
}

async function pickup(
  ctx: FinishContext,
  event: EventRow,
): Promise<MessageInput> {
  const parsed = parsePickupTime(stringOption(ctx.payload, "time"));
  if (!parsed.ok) {
    return message(parsed.problem);
  }
  const written = await setEventPickupTime(ctx.db, {
    guildId: ctx.actor.guildId,
    eventId: event.id,
    pickupTime: parsed.time,
    actorId: ctx.actor.userId,
  });
  if (!written.ok) {
    switch (written.error.category) {
      case "parent_unavailable":
        return message(EVENT_CLOSED);
      case "not_found":
        return message(REFUSED_TEXT);
    }
  }
  const done = valueOf(written);
  return withNotes(
    safe`Food pickup for **${eventTitle(event)}** is at ${pickupTimeText(parsed.time)} on ${dateText(event.event_date)}.`,
    done
      ? undefined
      : safe`Add the people picking up with /event assign step:Food pickup.`,
    await redraw(ctx, event),
  );
}

/** The people picked on /event create, read before anything is created. */
export interface StartingOwners {
  readonly budget?: string;
  readonly engage?: string;
}

export function startingOwners(
  payload: unknown,
): { readonly owners: StartingOwners } | { readonly problem: SafeText } {
  const budget = personOption(payload, "budget");
  const engage = personOption(payload, "engage");
  for (const person of [budget, engage]) {
    if (person !== undefined && "problem" in person) {
      return { problem: person.problem };
    }
  }
  return {
    owners: {
      ...(budget !== undefined && "id" in budget ? { budget: budget.id } : {}),
      ...(engage !== undefined && "id" in engage ? { engage: engage.id } : {}),
    },
  };
}

/**
 * Puts the people picked on /event create on their steps, before the post is drawn.
 * Says what happened as reply lines. A failure here leaves the event made, so it is a
 * line telling the officer to use /event assign rather than a failed command.
 */
export async function assignStartingOwners(
  ctx: FinishContext,
  event: EventRow,
  owners: StartingOwners,
): Promise<SafeText[]> {
  const picks: [AssignableStepKind, string | undefined][] = [
    ["budget_sheet", owners.budget],
    ["engage_post", owners.engage],
  ];
  const notes: SafeText[] = [];
  for (const [kind, userId] of picks) {
    if (userId === undefined) {
      continue;
    }
    const written = await assignEventStep(ctx.db, {
      guildId: event.guild_id,
      eventId: event.id,
      kind,
      userId,
      actorId: ctx.actor.userId,
    });
    if (written.ok) {
      notes.push(safe`${stepName(kind)}: ${userMention(userId)}.`);
    } else {
      logFailure("starting owner", errorSummary(written.error));
      notes.push(
        safe`I couldn't put ${userMention(userId)} on ${stepName(kind)}. Use /event assign to try again.`,
      );
    }
  }
  return notes;
}

const ROLE_NAMES: Readonly<
  Record<Exclude<CompletableStepKind, "budget_approved">, SafeText>
> = {
  budget_sheet: safe`Treasury Committee`,
  engage_post: safe`Marketing Committee`,
};

/**
 * The role a finished step's hand-off pings, or null when none may be pinged: unset, or
 * the guild's own ID, which is @everyone.
 */
function handoffRole(
  config: Pick<
    GuildConfig,
    "guild_id" | "treasury_role_id" | "marketing_role_id"
  >,
  kind: "budget_sheet" | "engage_post",
): string | null {
  const roleId =
    kind === "budget_sheet"
      ? config.treasury_role_id
      : config.marketing_role_id;
  return roleId === null || roleId === config.guild_id ? null : roleId;
}

/**
 * The message that follows a finished step, for the event's post. A role pinged here
 * comes only from the signed guild's config row, and an unset one is named instead.
 * Budget approved is only a note, and pings nobody.
 */
export function handoffMessage(
  config: Pick<
    GuildConfig,
    "guild_id" | "treasury_role_id" | "marketing_role_id"
  >,
  event: Pick<EventRow, "name">,
  kind: CompletableStepKind,
): MessageInput {
  const title = eventTitle(event);
  if (kind === "budget_approved") {
    return message(safe`The budget for **${title}** is approved.`);
  }
  const roleId = handoffRole(config, kind);
  const done =
    kind === "budget_sheet"
      ? safe`Budget Sheet for **${title}** is done.`
      : safe`Engage post for **${title}** is up.`;
  if (roleId === null) {
    return message(
      safe`${done} Run /setup to choose the ${ROLE_NAMES[kind]} role, so the next one pings it.`,
    );
  }
  return {
    content: safe`${roleMention(roleId)} ${done}`,
    mentionUserIds: [],
    mentionRoleIds: [roleId],
    roleGuildId: config.guild_id,
  };
}

/**
 * Who was told, for the clicker's reply. It agrees with `handoffMessage` about whether a
 * role was pinged.
 */
export function toldText(
  kind: CompletableStepKind,
  config: Pick<
    GuildConfig,
    "guild_id" | "treasury_role_id" | "marketing_role_id"
  >,
): SafeText {
  switch (kind) {
    case "budget_sheet":
      return handoffRole(config, kind) === null
        ? safe`I said so in the event's post. No usable Treasury Committee role is set, so nobody was pinged.`
        : safe`I let the Treasury Committee know in the event's post.`;
    case "engage_post":
      return handoffRole(config, kind) === null
        ? safe`I said so in the event's post. No usable Marketing Committee role is set, so nobody was pinged.`
        : safe`I let the Marketing Committee know in the event's post.`;
    case "budget_approved":
      return safe`I said so in the event's post.`;
  }
}

/**
 * Whether the event's forum is still managed and its post is active, read now rather than
 * taken from the row a caller holds. Only then is the hand-off claimed, so one that could
 * not be sent stays unclaimed for a later click, /event link, or /config adding the forum
 * back. Otherwise says which of those it waits for.
 */
async function postReachable(
  ctx: FinishContext,
  given: EventRow,
): Promise<
  | { readonly event: EventRow; readonly threadId: string }
  | { readonly waitsFor: "post" | "forum" }
> {
  const key = { guildId: given.guild_id, eventId: given.id };
  const read = await getEvent(ctx.db, key);
  const event = read.ok ? read.value : null;
  const threadId = event?.thread_id ?? null;
  if (
    event?.status !== "active" ||
    event.thread_status !== "active" ||
    threadId === null
  ) {
    return { waitsFor: "post" };
  }
  const forum = await getManagedChannel(ctx.db, {
    guildId: event.guild_id,
    channelId: event.channel_id,
  });
  if (!forum.ok) {
    return { waitsFor: "post" };
  }
  return forum.value?.status === "active"
    ? { event, threadId }
    : { waitsFor: "forum" };
}

/**
 * Whether Budget approved is done, read now. A Budget Sheet hand-off sent late, after the
 * budget was approved, would ask Treasury to look at a sheet already dealt with, so it is
 * not sent. It stays unclaimed, and nothing is lost: Treasury has no more to do.
 */
async function budgetApproved(
  ctx: FinishContext,
  event: EventRow,
): Promise<boolean> {
  const workflow = await getEventWorkflow(ctx.db, {
    guildId: event.guild_id,
    eventId: event.id,
  });
  return (
    workflow.ok &&
    workflow.value?.steps.some(
      (step) => step.kind === "budget_approved" && step.status === "done",
    ) === true
  );
}

/**
 * Sends the one message that follows a done step, if nobody has yet. The claim goes to
 * one caller ever, so a failed send is not tried again and nobody is pinged twice. It is
 * tried on every click of a done step, so a crash before the claim is made good later.
 * Undefined when there was nothing to send. `fresh` is for the call that finished the
 * step, which alone says when there is no post to tell.
 */
async function handOff(
  ctx: FinishContext,
  given: EventRow,
  kind: CompletableStepKind,
  fresh: boolean,
): Promise<SafeText | undefined> {
  const config = ctx.config;
  if (config === null) {
    return undefined;
  }
  const reachable = await postReachable(ctx, given);
  if ("waitsFor" in reachable) {
    if (!fresh) {
      return undefined;
    }
    return reachable.waitsFor === "forum"
      ? safe`This event's forum is not one I manage right now, so nobody was told yet. Once it is added back with /config, they are told in the event's post.`
      : safe`This event has no post I can use right now, so nobody was told yet. Once it has one again through /event link, they are told there.`;
  }
  const { event, threadId } = reachable;
  if (!fresh && kind === "budget_sheet" && (await budgetApproved(ctx, event))) {
    return undefined;
  }
  const key = { guildId: event.guild_id, eventId: event.id, kind };
  const claimed = await claimStepHandoff(ctx.db, key);
  if (!claimed.ok) {
    logFailure("hand-off claim", errorSummary(claimed.error));
    return safe`I couldn't tell anyone in the event's post.`;
  }
  if (!claimed.value) {
    return undefined;
  }
  try {
    await ctx.discord.sendMessage(
      threadTarget(event.guild_id, threadId),
      channelMessage(handoffMessage(config, event, kind)),
    );
  } catch (error) {
    if (!(error instanceof DiscordClientError)) {
      throw error;
    }
    logFailure("hand-off", error.failure.kind);
    return safe`I couldn't post in the event's post, so nobody was told. Let them know yourself.`;
  }
  const marked = await markStepHandoffSent(ctx.db, key);
  if (!marked.ok) {
    logFailure("hand-off record", errorSummary(marked.error));
  }
  return toldText(kind, config);
}

/**
 * Sends any hand-off that a done step is still owed, such as after /event link gives the
 * event a post again or /config adds its forum back. Each is claimed once, so this never pings twice.
 */
export async function retryHandoffs(
  ctx: FinishContext,
  event: EventRow,
): Promise<void> {
  const workflow = await getEventWorkflow(ctx.db, {
    guildId: event.guild_id,
    eventId: event.id,
  });
  if (!workflow.ok || workflow.value === null) {
    return;
  }
  for (const step of workflow.value.steps) {
    if (
      step.kind !== "food_pickup" &&
      step.status === "done" &&
      step.handoff_claimed_at === null
    ) {
      await handOff(ctx, event, step.kind, false);
    }
  }
}

/**
 * A click on one of the overview's buttons. The event and its step owners are loaded
 * here, by the ID in the custom_id and the signed guild, and the clicker is checked
 * against them. Absent, deleted, another guild's and forbidden all get one refusal.
 */
async function markStep(
  ctx: FinishContext,
  kind: ButtonStepKind,
  eventId: string,
): Promise<MessageInput> {
  const { actor, config } = ctx;
  const guildId = actor.guildId;
  const read = await getEvent(ctx.db, { guildId, eventId });
  if (!read.ok && read.error.category === "invalid_input") {
    return message(REFUSED_TEXT);
  }
  const event = valueOf(read);
  if (event === null) {
    return message(REFUSED_TEXT);
  }
  if (kind === "budget_approved") {
    if (
      !authorize("event.approve_budget", actor, config, event).allowed ||
      !canApproveBudget(actor, config)
    ) {
      return message(REFUSED_TEXT);
    }
  } else {
    const workflow = valueOf(
      await getEventWorkflow(ctx.db, { guildId, eventId: event.id }),
    );
    if (
      workflow === null ||
      !canCompleteStep(actor, config, stepOwnerIds(workflow, kind))
    ) {
      return message(REFUSED_TEXT);
    }
  }
  if (event.status !== "active") {
    return message(EVENT_CLOSED);
  }
  const title = eventTitle(event);
  const written = await completeEventStep(ctx.db, {
    guildId,
    eventId: event.id,
    kind,
    actorId: actor.userId,
  });
  if (!written.ok && written.error.category === "parent_unavailable") {
    return message(EVENT_CLOSED);
  }
  if (!written.ok && written.error.category === "not_found") {
    return message(REFUSED_TEXT);
  }
  // Done by this click or an earlier one, the step is owed its hand-off and a current
  // overview: the earlier click may have crashed, or drawn before this step was done.
  const fresh = valueOf(written);
  const told = await handOff(ctx, event, kind, fresh);
  const reply = !fresh
    ? safe`${stepName(kind)} for **${title}** is already done, so nothing was changed.`
    : kind === "budget_approved"
      ? safe`Marked the budget for **${title}** approved.`
      : safe`Marked ${stepName(kind)} done for **${title}**.`;
  return withNotes(reply, told, await redraw(ctx, event));
}

const SUBCOMMAND = ApplicationCommandOptionType.Subcommand;
const STRING = ApplicationCommandOptionType.String;
const USER = ApplicationCommandOptionType.User;

const EVENT_OPTION: CommandOption = {
  type: STRING,
  name: "event",
  description: "The event. Defaults to the post you're in",
  autocomplete: true,
};

const STEP_OPTION: CommandOption = {
  type: STRING,
  name: "step",
  description: "Which step",
  required: true,
  choices: [
    { name: "Budget Sheet", value: "budget_sheet" },
    { name: "Engage post", value: "engage_post" },
    { name: "Food pickup", value: "food_pickup" },
  ],
};

export const assignSubcommand: CommandOption = {
  type: SUBCOMMAND,
  name: "assign",
  description:
    "Put someone on an event's Budget Sheet, Engage post or Food pickup",
  options: [
    STEP_OPTION,
    { type: USER, name: "user", description: "Who", required: true },
    EVENT_OPTION,
  ],
};

export const unassignSubcommand: CommandOption = {
  type: SUBCOMMAND,
  name: "unassign",
  description: "Take someone off one of an event's steps",
  options: [
    STEP_OPTION,
    { type: USER, name: "user", description: "Who", required: true },
    EVENT_OPTION,
  ],
};

export const pickupSubcommand: CommandOption = {
  type: SUBCOMMAND,
  name: "pickup",
  description: "Set the food pickup time on the event's day",
  options: [
    {
      type: STRING,
      name: "time",
      description: "Like 5:30 PM or 17:30, in the server's time zone",
      required: true,
      max_length: MAX_PICKUP_INPUT_LENGTH,
    },
    EVENT_OPTION,
  ],
};

/** The options /event create takes to put people on steps up front. */
export const STARTING_OWNER_OPTIONS: readonly CommandOption[] = [
  {
    type: USER,
    name: "budget",
    description: "Who does the Budget Sheet, if you know already",
  },
  {
    type: USER,
    name: "engage",
    description: "Who does the Engage post, if you know already",
  },
];

function stepButtonRoute(kind: ButtonStepKind): Route {
  return componentRoute({
    prefix: STEP_BUTTON_PREFIX[kind],
    fields: ["uuid"],
    onPublicMessage: true,
    // The gate checks the tier alone. The rows are loaded and checked in finish.
    gate:
      kind === "budget_approved"
        ? tierOnly("event.approve_budget")
        : noRow("event.step_done"),
    changesState: true,
    finish: (ctx, _resource, [eventId]: readonly [string]) =>
      markStep(ctx, kind, eventId),
  });
}

/** The commands and buttons. Their event pickers are with the other /event pickers. */
export const workflowRoutes: readonly Route[] = [
  commandRoute({
    path: "event assign",
    gate: tierOnly("event.assign"),
    changesState: true,
    finish: onEvent("event.assign", assign),
  }),
  commandRoute({
    path: "event unassign",
    gate: tierOnly("event.unassign"),
    changesState: true,
    finish: onEvent("event.unassign", unassign),
  }),
  commandRoute({
    path: "event pickup",
    gate: tierOnly("event.pickup"),
    changesState: true,
    finish: onEvent("event.pickup", pickup),
  }),
  stepButtonRoute("budget_sheet"),
  stepButtonRoute("engage_post"),
  stepButtonRoute("budget_approved"),
];
