/**
 * How an event's workflow steps are shown: their names, the checklist in the overview,
 * the pickup time, and the buttons that mark a step done. Nothing here pings anyone:
 * owners are shown by mention, and who is notified is decided by the message that
 * carries the text.
 *
 * The buttons' custom_ids are built here rather than from their routes, so the overview
 * does not depend on the handlers. Their routes, in src/events/workflow.ts, parse the
 * same prefixes, and the router tests check that the two agree.
 */

import { actionRow, button } from "../discord/outbound.ts";
import type { Part } from "../discord/outbound.ts";
import {
  discordTimestamp,
  escapeUserText,
  plain,
  safe,
  userMention,
} from "../discord/safe-text.ts";
import type { PlainText, SafeText } from "../discord/safe-text.ts";
import type {
  AssignableStepKind,
  EventStep,
  EventStepKind,
  EventWorkflow,
} from "../db/types.ts";
import { isPickupTime, isUuid } from "../db/validate.ts";
import {
  instantInZone,
  isUsableTimeZone,
  type DateOnly,
} from "../lib/dates.ts";
import { commaList } from "../handlers/render.ts";

/** The custom_id prefixes of the overview's buttons. Each is followed by the event ID. */
export const STEP_BUTTON_PREFIX = {
  budget_sheet: "event.sheet-done",
  engage_post: "event.engage-done",
  engage_picture: "event.picture-done",
  budget_approved: "event.budget-ok",
  slides: "event.slides-done",
} as const;

export type ButtonStepKind = keyof typeof STEP_BUTTON_PREFIX;

/** The No slides needed button's custom_id prefix, also followed by the event ID. */
export const SLIDES_OFF_PREFIX = "event.slides-off";

const STEP_NAMES: Readonly<Record<EventStepKind, SafeText>> = {
  budget_sheet: safe`Budget Sheet`,
  engage_post: safe`Engage post`,
  engage_picture: safe`Engage picture added`,
  budget_approved: safe`Budget approved`,
  slides: safe`Slides`,
  food_pickup: safe`Food pickup`,
};

const BUTTON_LABELS: Readonly<Record<ButtonStepKind, PlainText>> = {
  budget_sheet: plain`Budget Sheet done`,
  engage_post: plain`Engage post done`,
  engage_picture: plain`Engage picture added`,
  budget_approved: plain`Budget approved`,
  slides: plain`Slides done`,
};

const BUTTON_KINDS: readonly ButtonStepKind[] = [
  "budget_sheet",
  "engage_post",
  "engage_picture",
  "budget_approved",
  "slides",
];

/** The step's name as people know it, such as "Budget Sheet". */
export function stepName(kind: EventStepKind): SafeText {
  return STEP_NAMES[kind];
}

/** ✅ for a done step, ➖ for one not needed, ⬜ for an open one. */
function stepMark(step: Pick<EventStep, "status" | "not_needed_at">): SafeText {
  return step.status === "done"
    ? safe`✅`
    : step.not_needed_at !== null
      ? safe`➖`
      : safe`⬜`;
}

/**
 * A stored pickup time, which is the guild's local time on the event's date, as a
 * Discord timestamp that each reader sees in their own zone. The instant uses the offset
 * in force on that date, so it is right across a daylight saving change. Without a zone
 * this runtime knows it is a 12-hour time such as "5:30 PM", and a value that is not a
 * time is shown escaped, so a bad value is visible rather than hidden.
 */
export function pickupTimeText(
  eventDate: DateOnly,
  time: string,
  timeZone: string | null,
): SafeText {
  if (!isPickupTime(time)) {
    return escapeUserText(time);
  }
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  if (timeZone !== null && isUsableTimeZone(timeZone)) {
    return discordTimestamp(
      instantInZone(eventDate, hours, minutes, timeZone),
      "t",
    );
  }
  const half = hours < 12 ? "AM" : "PM";
  const shown = hours % 12 === 0 ? 12 : hours % 12;
  return escapeUserText(
    `${String(shown)}:${String(minutes).padStart(2, "0")} ${half}`,
  );
}

/** The live people on one step, oldest assignment first. */
export function stepOwnerIds(
  workflow: Pick<EventWorkflow, "assignees">,
  kind: AssignableStepKind,
): string[] {
  return workflow.assignees
    .filter((assignee) => assignee.kind === kind)
    .map((assignee) => assignee.user_id);
}

/** Mentions that ping nobody unless the message names them, or "nobody assigned". */
function ownersText(userIds: readonly string[]): SafeText {
  return commaList(userIds.map(userMention)) ?? safe`nobody assigned`;
}

function stepOf(workflow: EventWorkflow, kind: EventStepKind): EventStep {
  const step = workflow.steps.find((candidate) => candidate.kind === kind);
  if (step === undefined) {
    // parseEventWorkflow refuses a workflow without every step.
    throw new RangeError("A workflow is missing a step");
  }
  return step;
}

/** Whether a step is done in this workflow. */
function isStepDone(workflow: EventWorkflow, kind: EventStepKind): boolean {
  return stepOf(workflow, kind).status === "done";
}

/**
 * Whether the step is shown at all. Engage picture added waits for Engage post, so it is
 * shown once that is done.
 */
function isStepShown(workflow: EventWorkflow, kind: EventStepKind): boolean {
  return kind !== "engage_picture" || isStepDone(workflow, "engage_post");
}

/**
 * Whether the step is still to do: shown, not done, and for Slides not marked not
 * needed. These are the steps that can be marked done.
 */
function isStepOpen(workflow: EventWorkflow, kind: EventStepKind): boolean {
  return (
    isStepShown(workflow, kind) &&
    !isStepDone(workflow, kind) &&
    stepOf(workflow, kind).not_needed_at === null
  );
}

/** The pickup time and people, or what is still missing. */
function pickupText(workflow: EventWorkflow): SafeText {
  const time =
    workflow.pickup_time === null
      ? safe`time not set`
      : safe`at ${pickupTimeText(workflow.event_date, workflow.pickup_time, workflow.timezone)}`;
  return safe`${time}, ${ownersText(stepOwnerIds(workflow, "food_pickup"))}`;
}

/** One checklist line for a step, with its mark and its owners. */
export function stepLine(
  workflow: EventWorkflow,
  kind: EventStepKind,
): SafeText {
  const step = stepOf(workflow, kind);
  const head = safe`${stepMark(step)} ${stepName(kind)}`;
  switch (kind) {
    case "budget_sheet":
    case "engage_post":
      return safe`${head}: ${ownersText(stepOwnerIds(workflow, kind))}`;
    case "slides":
      return step.not_needed_at !== null
        ? safe`${head}: not needed`
        : safe`${head}: ${ownersText(stepOwnerIds(workflow, kind))}`;
    case "engage_picture":
    case "budget_approved":
      return step.status === "done" && step.completed_by !== null
        ? safe`${head} by ${userMention(step.completed_by)}`
        : head;
    case "food_pickup":
      return safe`${head}: ${pickupText(workflow)}`;
  }
}

/** The checklist section of an overview: a heading, then one line per step shown. */
export function checklistLines(workflow: EventWorkflow): SafeText[] {
  return [
    safe`**Checklist**`,
    ...workflow.steps
      .filter((step) => isStepShown(workflow, step.kind))
      .map((step) => stepLine(workflow, step.kind)),
  ];
}

/** The custom_id of one of the overview's buttons. Throws if the ID is not an event ID. */
function stepButtonId(prefix: string, eventId: string): string {
  if (!isUuid(eventId)) {
    throw new RangeError("A step button needs an event ID");
  }
  return `${prefix}:${eventId}`;
}

/**
 * The buttons for the steps still open, with No slides needed while Slides is open, as
 * one row, or no row when all are done. At most five are open at once, since Engage
 * picture added waits for Engage post. Anyone can click them: each click is checked
 * against the rows when it arrives.
 */
export function stepButtonRows(workflow: EventWorkflow): Part<"row">[] {
  const open = BUTTON_KINDS.filter((kind) => isStepOpen(workflow, kind));
  if (open.length === 0) {
    return [];
  }
  const buttons = open.map((kind) =>
    button({
      customId: stepButtonId(STEP_BUTTON_PREFIX[kind], workflow.event_id),
      label: BUTTON_LABELS[kind],
      style: kind === "budget_approved" ? "primary" : "success",
    }),
  );
  if (open.includes("slides")) {
    buttons.push(
      button({
        customId: stepButtonId(SLIDES_OFF_PREFIX, workflow.event_id),
        label: plain`No slides needed`,
      }),
    );
  }
  return [actionRow(...buttons)];
}
