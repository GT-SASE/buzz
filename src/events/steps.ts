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
import { commaList } from "../handlers/render.ts";

/** The custom_id prefixes of the overview's buttons. Each is followed by the event ID. */
export const STEP_BUTTON_PREFIX = {
  budget_sheet: "event.sheet-done",
  engage_post: "event.engage-done",
  budget_approved: "event.budget-ok",
} as const;

export type ButtonStepKind = keyof typeof STEP_BUTTON_PREFIX;

const STEP_NAMES: Readonly<Record<EventStepKind, SafeText>> = {
  budget_sheet: safe`Budget Sheet`,
  engage_post: safe`Engage post`,
  budget_approved: safe`Budget approved`,
  food_pickup: safe`Food pickup`,
};

const BUTTON_LABELS: Readonly<Record<ButtonStepKind, PlainText>> = {
  budget_sheet: plain`Budget Sheet done`,
  engage_post: plain`Engage post done`,
  budget_approved: plain`Budget approved`,
};

const BUTTON_KINDS: readonly ButtonStepKind[] = [
  "budget_sheet",
  "engage_post",
  "budget_approved",
];

/** The step's name as people know it, such as "Budget Sheet". */
export function stepName(kind: EventStepKind): SafeText {
  return STEP_NAMES[kind];
}

/** ✅ for a done step, ⬜ for an open one. */
export function stepMark(step: Pick<EventStep, "status">): SafeText {
  return step.status === "done" ? safe`✅` : safe`⬜`;
}

/**
 * A stored `HH:MM` on a 24-hour clock, as a 12-hour time such as "5:30 PM". Anything
 * else is shown as it is, escaped, so a bad value is visible rather than hidden.
 */
export function pickupTimeText(time: string): SafeText {
  if (!isPickupTime(time)) {
    return escapeUserText(time);
  }
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
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
export function ownersText(userIds: readonly string[]): SafeText {
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
export function isStepDone(
  workflow: EventWorkflow,
  kind: EventStepKind,
): boolean {
  return stepOf(workflow, kind).status === "done";
}

/** The pickup time and people, or what is still missing. */
export function pickupText(workflow: EventWorkflow): SafeText {
  const time =
    workflow.pickup_time === null
      ? safe`time not set`
      : safe`at ${pickupTimeText(workflow.pickup_time)}`;
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
    case "budget_approved":
      return step.status === "done" && step.completed_by !== null
        ? safe`${head} by ${userMention(step.completed_by)}`
        : head;
    case "food_pickup":
      return safe`${head}: ${pickupText(workflow)}`;
  }
}

/** The checklist section of an overview: a heading, then one line per step. */
export function checklistLines(workflow: EventWorkflow): SafeText[] {
  return [
    safe`**Checklist**`,
    ...workflow.steps.map((step) => stepLine(workflow, step.kind)),
  ];
}

/** The custom_id of one step's button. Throws if the ID is not an event ID. */
export function stepButtonId(kind: ButtonStepKind, eventId: string): string {
  if (!isUuid(eventId)) {
    throw new RangeError("A step button needs an event ID");
  }
  return `${STEP_BUTTON_PREFIX[kind]}:${eventId}`;
}

/**
 * The buttons for the steps still open, as one row, or no row when all are done. Anyone
 * can click them: each click is checked against the rows when it arrives.
 */
export function stepButtonRows(workflow: EventWorkflow): Part<"row">[] {
  const open = BUTTON_KINDS.filter((kind) => !isStepDone(workflow, kind));
  if (open.length === 0) {
    return [];
  }
  return [
    actionRow(
      ...open.map((kind) =>
        button({
          customId: stepButtonId(kind, workflow.event_id),
          label: BUTTON_LABELS[kind],
          style: kind === "budget_approved" ? "primary" : "success",
        }),
      ),
    ),
  ];
}
