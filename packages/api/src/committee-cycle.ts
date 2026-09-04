import { z } from "zod";

/**
 * Fall 2026 committee recruiting. The Google Form closes Wednesday 9/9 at
 * midnight Atlanta time — this is that same instant, so a late submit here
 * cannot sneak in after the chapter already told people the window was over.
 *
 * 9 Sep 2026 is a Wednesday. "Midnight" is the start of Thursday in
 * America/New_York, which is 04:00 UTC during EDT.
 */
export const COMMITTEE_CYCLE_ID = "fall-2026";

export const COMMITTEE_CYCLE_CLOSES_AT = new Date("2026-09-10T04:00:00.000Z");

export const COMMITTEE_IDS = ["events", "marketing", "treasury"] as const;
export type CommitteeId = (typeof COMMITTEE_IDS)[number];

export const COMMITTEE_STATUSES = [
  "submitted",
  "interviewing",
  "accepted",
  "declined",
  "withdrawn",
] as const;
export type CommitteeApplicationStatus = (typeof COMMITTEE_STATUSES)[number];

/** Answers are locked once an officer has moved the row out of the inbox. */
export const LOCKED_COMMITTEE_STATUSES = [
  "interviewing",
  "accepted",
  "declined",
] as const;

export function isCommitteeCycleOpen(now: Date) {
  return now.getTime() < COMMITTEE_CYCLE_CLOSES_AT.getTime();
}

export function isCommitteeApplicationLocked(
  status: CommitteeApplicationStatus,
) {
  return (LOCKED_COMMITTEE_STATUSES as readonly string[]).includes(status);
}

function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined));
}

export const committeeApplySchema = z
  .object({
    discordHandle: z.string().trim().min(1).max(80),
    wantsEvents: z.boolean(),
    wantsMarketing: z.boolean(),
    wantsTreasury: z.boolean(),
    eventsWhy: optionalText(2000),
    eventsCollabs: optionalText(1000),
    marketingWhy: optionalText(2000),
    marketingConnections: optionalText(1000),
    treasuryWhy: optionalText(2000),
    otherOrgs: optionalText(1000),
    comments: optionalText(1000),
  })
  .superRefine((value, ctx) => {
    if (!value.wantsEvents && !value.wantsMarketing && !value.wantsTreasury) {
      ctx.addIssue({
        code: "custom",
        message: "Pick at least one committee.",
        path: ["wantsEvents"],
      });
    }
    if (value.wantsEvents && !value.eventsWhy) {
      ctx.addIssue({
        code: "custom",
        message: "Tell us why you want Events, and what you would run.",
        path: ["eventsWhy"],
      });
    }
    if (value.wantsMarketing && !value.marketingWhy) {
      ctx.addIssue({
        code: "custom",
        message: "Tell us why you want Marketing.",
        path: ["marketingWhy"],
      });
    }
    if (value.wantsTreasury && !value.treasuryWhy) {
      ctx.addIssue({
        code: "custom",
        message: "Tell us why you want Treasury.",
        path: ["treasuryWhy"],
      });
    }
  });

export type CommitteeApplyInput = z.infer<typeof committeeApplySchema>;

/** Persist only the answers that belong to the committees they picked. */
export function committeeAnswerFields(input: CommitteeApplyInput) {
  return {
    wantsEvents: input.wantsEvents,
    wantsMarketing: input.wantsMarketing,
    wantsTreasury: input.wantsTreasury,
    discordHandle: input.discordHandle,
    eventsWhy: input.wantsEvents ? (input.eventsWhy ?? null) : null,
    eventsCollabs: input.wantsEvents ? (input.eventsCollabs ?? null) : null,
    marketingWhy: input.wantsMarketing ? (input.marketingWhy ?? null) : null,
    marketingConnections: input.wantsMarketing
      ? (input.marketingConnections ?? null)
      : null,
    treasuryWhy: input.wantsTreasury ? (input.treasuryWhy ?? null) : null,
    otherOrgs: input.otherOrgs ?? null,
    comments: input.comments ?? null,
  };
}
