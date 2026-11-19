/**
 * Checks on what an officer typed for a task. A failure is a message for them, and it
 * stops before any query, so bad text reaches neither the database nor Discord.
 */

import { resolvedPerson } from "../discord/interactions.ts";
import {
  containsInviteOrMaskedLink,
  escapeUserText,
  safe,
  SafeTextError,
} from "../discord/safe-text.ts";
import type { SafeText } from "../discord/safe-text.ts";
import { MAX_TASK_DESCRIPTION_LENGTH, isStoredText } from "../db/validate.ts";
import { parseDateInput, todayInZone } from "../lib/dates.ts";
import type { DateOnly } from "../lib/dates.ts";
import type { FinishContext } from "../handlers/router.ts";

const LONGEST_DATE_INPUT = 32;

export type Checked<T> = { readonly value: T } | { readonly problem: SafeText };

/** Stored as typed, without surrounding space: it is escaped whenever it is shown. */
export function checkDescription(raw: unknown): Checked<string> {
  if (typeof raw !== "string") {
    return { problem: safe`A task needs a description.` };
  }
  const text = raw.trim();
  if (text.length > MAX_TASK_DESCRIPTION_LENGTH) {
    return {
      problem: safe`That description is too long. The limit is ${escapeUserText(String(MAX_TASK_DESCRIPTION_LENGTH))} characters.`,
    };
  }
  if (!isStoredText(text, MAX_TASK_DESCRIPTION_LENGTH)) {
    return {
      problem: safe`That description can't be saved. Please retype it.`,
    };
  }
  try {
    escapeUserText(text, MAX_TASK_DESCRIPTION_LENGTH);
  } catch (error) {
    if (error instanceof SafeTextError) {
      return {
        problem: safe`That description has nothing visible in it. Please retype it.`,
      };
    }
    throw error;
  }
  if (containsInviteOrMaskedLink(text)) {
    return {
      problem: safe`A task description can't hold server invites or masked links, because the bot pings people with it. A plain URL is fine, and shows as text.`,
    };
  }
  return { value: text };
}

/** Today is the guild's, so a date entered late in the evening reads as it should. */
export function checkDueDate(
  ctx: FinishContext,
  raw: unknown,
): Checked<DateOnly> {
  const timezone = ctx.config?.timezone;
  if (
    typeof raw !== "string" ||
    raw.length > LONGEST_DATE_INPUT ||
    timezone === undefined
  ) {
    return { problem: safe`Enter the due date as YYYY-MM-DD or MM/DD.` };
  }
  const parsed = parseDateInput(raw, {
    today: todayInZone(new Date(), timezone),
    rejectPast: true,
  });
  if (parsed.ok) {
    return { value: parsed.date };
  }
  switch (parsed.error) {
    case "invalid_format":
      return { problem: safe`Enter the due date as YYYY-MM-DD or MM/DD.` };
    case "invalid_date":
      return { problem: safe`That due date is not a real date.` };
    case "past_date":
      return { problem: safe`The due date can't be in the past.` };
  }
}

/** The person comes from `resolved`, so never from anything the actor typed. */
export function checkPerson(payload: unknown, id: unknown): Checked<string> {
  const person =
    typeof id === "string" ? resolvedPerson(payload, id) : undefined;
  if (person?.isMember !== true) {
    return { problem: safe`That person isn't a member of this server.` };
  }
  if (person.isBot) {
    return { problem: safe`Tasks can't be assigned to bots.` };
  }
  return { value: person.id };
}
