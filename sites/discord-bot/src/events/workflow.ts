/**
 * The event workflow's commands and buttons: /event assign, /event unassign,
 * /event pickup and /event undo, the people picked on /event create, and the overview's
 * buttons that mark a step done or Slides not needed, with the message that follows
 * Budget Sheet, Engage post and Budget approved. Putting someone on a step pings them in
 * the event's post. Nothing else here pings a person.
 *
 * Every value from a payload only names a row, which is loaded by ID and the signed
 * guild, and the actor is checked against what was loaded. A button can sit on the
 * public overview, so anyone can click it: Budget Sheet, Engage post and Slides take an
 * assignee of that step or an officer, Budget approved takes an officer or the Treasury
 * role, Engage picture added an officer or the Marketing role, and No slides needed an
 * officer.
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
import { errorSummary, type DbResult } from "../db/errors.ts";
import {
  assignEventStep,
  claimStepHandoff,
  completeEventStep,
  getEventWorkflow,
  markStepHandoffSent,
  MAX_ASSIGNEES_PER_STEP,
  MAX_FOOD_PICKUP_ASSIGNEES,
  reopenEventStep,
  setEventPickupTime,
  setSlidesNotNeeded,
  unassignEventStep,
} from "../db/event-steps.ts";
import { getEvent } from "../db/events.ts";
import { getManagedChannel } from "../db/managed-channels.ts";
import type {
  AssignableStepKind,
  CompletableStepKind,
  EventRow,
  GuildConfig,
  HandoffStepKind,
} from "../db/types.ts";
import {
  ASSIGNABLE_STEP_KINDS,
  COMPLETABLE_STEP_KINDS,
  HANDOFF_STEP_KINDS,
} from "../db/types.ts";
import {
  authorize,
  canCompleteStep,
  usableRoleId,
  type EventScopedAction,
} from "../lib/permissions.ts";
import {
  chooseRoleToPingText,
  MARKETING_ROLE,
  TREASURY_ROLE,
} from "../handlers/club-roles.ts";
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
import {
  chooseEvent,
  message,
  messageWithNotes,
  NO_EVENT,
  PICK_FROM_LIST,
  REFUSED_TEXT,
  stringOption,
} from "../tasks/shared.ts";
import { postInEvent, reachWarning } from "../tasks/notify.ts";
import { MAX_PICKUP_INPUT_LENGTH, parsePickupTime } from "./input.ts";
import {
  dateText,
  eventTitle,
  refreshOverview,
  threadTarget,
} from "./overview.ts";
import {
  pickupTimeText,
  SLIDES_OFF_PREFIX,
  STEP_BUTTON_PREFIX,
  stepName,
  stepOwnerIds,
  type ButtonStepKind,
} from "./steps.ts";

const EVENT_CLOSED = safe`That event is closed, so its steps can't change.`;
const OVERVIEW_BEHIND = safe`The change is saved, but I couldn't update the event's overview, so it's out of date until the next change.`;

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

/**
 * A typed value that is no ID, and a row that is absent, deleted, another guild's or
 * forbidden all get a fixed reply that says nothing about which.
 */
function onEvent(
  action: EventScopedAction,
  step: (ctx: FinishContext, event: EventRow) => Promise<MessageInput>,
): (ctx: FinishContext) => Promise<MessageInput> {
  return async (ctx) => {
    const chosen = await chooseEvent(ctx, action);
    switch (chosen.kind) {
      case "none":
        return message(NO_EVENT);
      case "typed":
        return message(PICK_FROM_LIST);
      case "refused":
        return message(REFUSED_TEXT);
      case "event":
        return chosen.event.status === "active"
          ? step(ctx, chosen.event)
          : message(EVENT_CLOSED);
    }
  };
}

function stepOption(ctx: FinishContext): AssignableStepKind | undefined {
  const value = stringOption(ctx.payload, "step");
  return isAssignableKind(value) ? value : undefined;
}

const PICK_STEP = safe`Choose Budget Sheet, Engage post, Slides or Food pickup from the step option's list.`;

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
  const outcome = valueOf(written);
  if (outcome === "already_on") {
    return message(
      safe`${userMention(person.id)} is already on ${stepName(kind)} for **${title}**, so nothing was changed.`,
    );
  }
  const reply = safe`Put ${userMention(person.id)} on ${stepName(kind)} for **${title}**.`;
  const told = await tellAssignee(ctx, event, kind, person.id);
  if (outcome === "needed_again") {
    await postInEvent(ctx, event, message(slidesNeededLine(ctx)));
  }
  const hint =
    kind === "food_pickup" ? await pickupHint(ctx, event) : undefined;
  const reach = await reachWarning(ctx, event, person.id, "step");
  return messageWithNotes(reply, told, hint, reach, await redraw(ctx, event));
}

/** The line in the event's post when No slides needed is undone, which pings nobody. */
function slidesNeededLine(ctx: FinishContext): SafeText {
  return safe`No slides needed undone by ${userMention(ctx.actor.userId)}.`;
}

/** Pings the person in the event's post, and no one else. Says if that failed. */
async function tellAssignee(
  ctx: FinishContext,
  event: EventRow,
  kind: AssignableStepKind,
  userId: string,
): Promise<SafeText | undefined> {
  const told = await postInEvent(ctx, event, {
    content: safe`${userMention(userId)} you're on ${stepName(kind)} for **${eventTitle(event)}**.`,
    mentionUserIds: [userId],
  });
  return told === "posted"
    ? undefined
    : safe`I couldn't tell ${userMention(userId)} in the event's post, so let them know yourself.`;
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
  return messageWithNotes(
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
  return messageWithNotes(
    safe`Food pickup for **${eventTitle(event)}** is at ${pickupTimeText(event.event_date, parsed.time, ctx.config?.timezone ?? null)} on ${dateText(event.event_date)}.`,
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

/** The people /event create has just put on a step, to be told once the post exists. */
type StartedOwners = readonly (readonly [AssignableStepKind, string])[];

/**
 * Puts the people picked on /event create on their steps, before the post is drawn.
 * Says what happened as reply lines, and who is newly on a step. A failure here leaves
 * the event made, so it is a line telling the officer to use /event assign rather than a
 * failed command.
 */
export async function assignStartingOwners(
  ctx: FinishContext,
  event: EventRow,
  owners: StartingOwners,
): Promise<{ notes: SafeText[]; started: StartedOwners }> {
  const picks: [AssignableStepKind, string | undefined][] = [
    ["budget_sheet", owners.budget],
    ["engage_post", owners.engage],
  ];
  const notes: SafeText[] = [];
  const started: [AssignableStepKind, string][] = [];
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
      if (written.value !== "already_on") {
        started.push([kind, userId]);
      }
    } else {
      logFailure("starting owner", errorSummary(written.error));
      notes.push(
        safe`I couldn't put ${userMention(userId)} on ${stepName(kind)}. Use /event assign to try again.`,
      );
    }
  }
  return { notes, started };
}

/**
 * Pings the people /event create put on a step, in the post it has drawn since. The event
 * is read again for its post. Says as reply lines whom it couldn't tell.
 */
export async function tellStartingOwners(
  ctx: FinishContext,
  event: EventRow,
  started: StartedOwners,
): Promise<SafeText[]> {
  if (started.length === 0) {
    return [];
  }
  const read = await getEvent(ctx.db, {
    guildId: event.guild_id,
    eventId: event.id,
  });
  const current = read.ok && read.value !== null ? read.value : event;
  const notes: SafeText[] = [];
  for (const [kind, userId] of started) {
    const note = await tellAssignee(ctx, current, kind, userId);
    if (note !== undefined) {
      notes.push(note);
    }
  }
  return notes;
}

const HANDOFF_ROLES = {
  budget_sheet: TREASURY_ROLE,
  engage_post: MARKETING_ROLE,
} as const;

/** The role a finished step's hand-off pings, or null when none may be pinged. */
function handoffRole(
  config: Pick<
    GuildConfig,
    "guild_id" | "treasury_role_id" | "marketing_role_id"
  >,
  kind: "budget_sheet" | "engage_post",
): string | null {
  return usableRoleId(
    config.guild_id,
    kind === "budget_sheet"
      ? config.treasury_role_id
      : config.marketing_role_id,
  );
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
  kind: HandoffStepKind,
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
    return message(safe`${done} ${chooseRoleToPingText(HANDOFF_ROLES[kind])}`);
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
  kind: HandoffStepKind,
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
  kind: HandoffStepKind,
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
    const kind = HANDOFF_STEP_KINDS.find((handoff) => handoff === step.kind);
    if (
      kind !== undefined &&
      step.status === "done" &&
      step.handoff_claimed_at === null
    ) {
      await handOff(ctx, event, kind, false);
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
  const { actor } = ctx;
  const guildId = actor.guildId;
  const event = await clickedEvent(ctx, eventId);
  if (event === null || !(await mayMark(ctx, event, kind))) {
    return message(REFUSED_TEXT);
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
  if (!written.ok && written.error.category === "step_not_ready") {
    return message(
      safe`Engage post for **${title}** isn't done yet, so the picture can't be marked added.`,
    );
  }
  // Done by this click or an earlier one, the step is owed its hand-off and a current
  // overview: the earlier click may have crashed, or drawn before this step was done.
  const fresh = valueOf(written);
  const handoff = HANDOFF_STEP_KINDS.find((candidate) => candidate === kind);
  const told =
    handoff === undefined
      ? undefined
      : await handOff(ctx, event, handoff, fresh);
  const reply = !fresh
    ? safe`${stepName(kind)} for **${title}** is already done, so nothing was changed.`
    : kind === "budget_approved"
      ? safe`Marked the budget for **${title}** approved.`
      : kind === "engage_picture"
        ? safe`Marked the Engage picture added for **${title}**.`
        : safe`Marked ${stepName(kind)} done for **${title}**.`;
  return messageWithNotes(reply, told, await redraw(ctx, event));
}

/** The event a button's custom_id names, in the signed guild, or null. */
async function clickedEvent(
  ctx: FinishContext,
  eventId: string,
): Promise<EventRow | null> {
  const read = await getEvent(ctx.db, { guildId: ctx.actor.guildId, eventId });
  if (!read.ok && read.error.category === "invalid_input") {
    return null;
  }
  return valueOf(read);
}

/** Whether the clicker may mark this step done on this event. */
async function mayMark(
  ctx: FinishContext,
  event: EventRow,
  kind: ButtonStepKind,
): Promise<boolean> {
  const { actor, config } = ctx;
  switch (kind) {
    case "budget_approved":
      return authorize("event.approve_budget", actor, config, event).allowed;
    case "engage_picture":
      return authorize("event.picture_done", actor, config, event).allowed;
    case "budget_sheet":
    case "engage_post":
    case "slides": {
      const workflow = valueOf(
        await getEventWorkflow(ctx.db, {
          guildId: actor.guildId,
          eventId: event.id,
        }),
      );
      return (
        workflow !== null &&
        canCompleteStep(actor, config, stepOwnerIds(workflow, kind))
      );
    }
  }
}

/** A click on No slides needed, which takes an officer. */
async function markSlidesNotNeeded(
  ctx: FinishContext,
  eventId: string,
): Promise<MessageInput> {
  const { actor, config } = ctx;
  const event = await clickedEvent(ctx, eventId);
  if (
    event === null ||
    !authorize("event.slides_off", actor, config, event).allowed
  ) {
    return message(REFUSED_TEXT);
  }
  if (event.status !== "active") {
    return message(EVENT_CLOSED);
  }
  const written = await setSlidesNotNeeded(ctx.db, {
    guildId: actor.guildId,
    eventId: event.id,
    notNeeded: true,
    actorId: actor.userId,
  });
  if (!written.ok && written.error.category === "parent_unavailable") {
    return message(EVENT_CLOSED);
  }
  if (!written.ok && written.error.category === "not_found") {
    return message(REFUSED_TEXT);
  }
  const title = eventTitle(event);
  const reply = valueOf(written)
    ? safe`Marked Slides not needed for **${title}**.`
    : safe`Slides for **${title}** is already done or not needed, so nothing was changed.`;
  return messageWithNotes(reply, await redraw(ctx, event));
}

/** Whether Engage picture added is done, which undoing Engage post reopens too. */
async function pictureAdded(
  ctx: FinishContext,
  event: EventRow,
): Promise<boolean> {
  const workflow = valueOf(
    await getEventWorkflow(ctx.db, {
      guildId: ctx.actor.guildId,
      eventId: event.id,
    }),
  );
  return (
    workflow?.steps.some(
      (step) => step.kind === "engage_picture" && step.status === "done",
    ) ?? false
  );
}

/** The /event undo choice that turns No slides needed off. */
const SLIDES_NEEDED = "slides_needed";

function isCompletableKind(value: unknown): value is CompletableStepKind {
  return COMPLETABLE_STEP_KINDS.some((kind) => kind === value);
}

/**
 * /event undo: reopens a done step, or turns No slides needed off. Everything then
 * follows the usual rules again, so marking the step done again sends its ping again.
 * The post gets a line saying who did it, which pings nobody.
 */
async function undo(
  ctx: FinishContext,
  event: EventRow,
): Promise<MessageInput> {
  const choice = stringOption(ctx.payload, "step");
  const key = { guildId: ctx.actor.guildId, eventId: event.id };
  const by = userMention(ctx.actor.userId);
  const title = eventTitle(event);
  let written: DbResult<boolean>;
  let done: { readonly line: SafeText; readonly reply: SafeText };
  let notDone: SafeText;
  if (choice === SLIDES_NEEDED) {
    written = await setSlidesNotNeeded(ctx.db, {
      ...key,
      notNeeded: false,
      actorId: ctx.actor.userId,
    });
    done = {
      line: slidesNeededLine(ctx),
      reply: safe`Slides for **${title}** is needed again.`,
    };
    notDone = safe`Slides for **${title}** isn't marked not needed, so there's nothing to undo.`;
  } else if (isCompletableKind(choice)) {
    const pictureToo =
      choice === "engage_post" && (await pictureAdded(ctx, event));
    written = await reopenEventStep(ctx.db, { ...key, kind: choice });
    done = {
      line: pictureToo
        ? safe`Engage post reopened by ${by}. This also reopened Engage picture added.`
        : safe`${stepName(choice)} reopened by ${by}.`,
      reply: safe`Reopened ${stepName(choice)} for **${title}**.`,
    };
    notDone = safe`${stepName(choice)} for **${title}** isn't done, so there's nothing to undo.`;
  } else {
    return message(safe`Choose a step from the step option's list.`);
  }
  if (!written.ok && written.error.category === "parent_unavailable") {
    return message(EVENT_CLOSED);
  }
  if (!written.ok && written.error.category === "not_found") {
    return message(REFUSED_TEXT);
  }
  if (!valueOf(written)) {
    return message(notDone);
  }
  const posted = await postInEvent(ctx, event, message(done.line));
  return messageWithNotes(
    done.reply,
    posted === "posted"
      ? undefined
      : safe`I couldn't note it in the event's post.`,
    await redraw(ctx, event),
  );
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
    { name: "Slides", value: "slides" },
    { name: "Food pickup", value: "food_pickup" },
  ],
};

export const assignSubcommand: CommandOption = {
  type: SUBCOMMAND,
  name: "assign",
  description:
    "Put someone on an event's Budget Sheet, Engage post, Slides or Food pickup",
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

export const undoSubcommand: CommandOption = {
  type: SUBCOMMAND,
  name: "undo",
  description: "Reopen a done step, or undo No slides needed",
  options: [
    {
      type: STRING,
      name: "step",
      description: "Which step",
      required: true,
      choices: [
        { name: "Budget Sheet", value: "budget_sheet" },
        { name: "Engage post", value: "engage_post" },
        { name: "Engage picture added", value: "engage_picture" },
        { name: "Budget approved", value: "budget_approved" },
        { name: "Slides", value: "slides" },
        { name: "No slides needed", value: SLIDES_NEEDED },
      ],
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
        : kind === "engage_picture"
          ? tierOnly("event.picture_done")
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
  commandRoute({
    path: "event undo",
    gate: tierOnly("event.undo"),
    changesState: true,
    finish: onEvent("event.undo", undo),
  }),
  stepButtonRoute("budget_sheet"),
  stepButtonRoute("engage_post"),
  stepButtonRoute("engage_picture"),
  stepButtonRoute("budget_approved"),
  stepButtonRoute("slides"),
  componentRoute({
    prefix: SLIDES_OFF_PREFIX,
    fields: ["uuid"],
    onPublicMessage: true,
    gate: tierOnly("event.slides_off"),
    changesState: true,
    finish: (ctx, _resource, [eventId]: readonly [string]) =>
      markSlidesNotNeeded(ctx, eventId),
  }),
];
