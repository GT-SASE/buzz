/**
 * Fall 2026 committee recruiting copy.
 *
 * Public pages import this. Interview prompts live in `committee-interviews.ts`
 * and must stay off the marketing bundle — those are for officers running
 * callbacks, not for applicants.
 */

export const committeeCycle = {
  id: "fall-2026",
  label: "Fall 2026",
  /** Display string. The portal enforces the actual instant. */
  closesLabel: "Wednesday, September 9 at midnight",
  discordHref: "https://discord.gg/CsZAfd37zS",
} as const;

export const committeeExpectations = [
  "Bi-monthly meetings",
  "Plan one full event with the rest of the committee",
  "Use Discord as the main channel and reply within 48 hours",
  "Attend at least two events or hangouts each month — flexible with notice",
  "About 2–4 hours a week",
] as const;

export const committees = [
  {
    id: "events" as const,
    title: "Events Committee",
    blurb:
      "Work with the Events Directors to plan and run chapter events. Members should expect to meet bimonthly, depending on what is coming up.",
    responsibilities: [
      "Room booking",
      "Activity planning and ideation",
      "Filling out budget sheets",
      "Managing Engage",
    ],
  },
  {
    id: "marketing" as const,
    title: "Marketing Committee",
    blurb:
      "Help grow the chapter — connecting with other classes, clubs, and organizations on campus, and spreading the word about SASE at GT.",
    responsibilities: [
      "Graphic design",
      "Posting on Discord and Instagram",
      "Outreach with other student organizations",
    ],
  },
  {
    id: "treasury" as const,
    title: "Treasury Committee",
    blurb:
      "Work with the Treasurer on how the chapter handles money: SGA bills, the yearly budget, fundraisers, and the payment ledger.",
    responsibilities: [
      "Managing SGA bill requests",
      "Meeting with the accountant to purchase materials and food",
      "Planning the SASE budget",
    ],
  },
] as const;

export type PublicCommitteeId = (typeof committees)[number]["id"];

export function selectedCommitteeIds(row: {
  wantsEvents: boolean;
  wantsMarketing: boolean;
  wantsTreasury: boolean;
}): PublicCommitteeId[] {
  const ids: PublicCommitteeId[] = [];
  if (row.wantsEvents) ids.push("events");
  if (row.wantsMarketing) ids.push("marketing");
  if (row.wantsTreasury) ids.push("treasury");
  return ids;
}
