import { committees, type PublicCommitteeId } from "./committees";

/**
 * Prompts for the callback after someone applies. Taken from the chapter's
 * interview sheet. Marketing is the only committee with written questions so
 * far; Events and Treasury still use the shared openers plus the role brief.
 */

export const sharedInterviewQuestions = [
  "Introduction — tell me about yourself.",
  "Weekly time commitment to this role.",
] as const;

export const committeeInterviewQuestions: Record<
  PublicCommitteeId,
  readonly string[]
> = {
  events: [],
  marketing: [
    "What creative ideas do you have to increase our reach on campus?",
    "Do you have any prior experience in marketing?",
  ],
  treasury: [],
};

export function interviewScript(ids: PublicCommitteeId[]) {
  const unique = [...new Set(ids)];
  return unique.map((id) => {
    const committee = committees.find((row) => row.id === id);
    return {
      id,
      title: committee?.title ?? id,
      responsibilities: committee?.responsibilities ?? [],
      questions: [
        ...sharedInterviewQuestions,
        ...committeeInterviewQuestions[id],
      ],
    };
  });
}
