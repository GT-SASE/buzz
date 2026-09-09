import { committees, type PublicCommitteeId } from "./committees";

export type InterviewQuestion = {
  id: string;
  prompt: string;
};

/**
 * Prompts from the chapter interview sheet. Shared openers run once;
 * committee-specific questions follow the role they applied for.
 */
export const sharedInterviewQuestions: readonly InterviewQuestion[] = [
  {
    id: "intro",
    prompt: "Introduction — tell me about yourself.",
  },
  {
    id: "time",
    prompt: "Weekly time commitment to this role.",
  },
];

export const committeeInterviewQuestions: Record<
  PublicCommitteeId,
  readonly InterviewQuestion[]
> = {
  events: [],
  marketing: [
    {
      id: "marketing-ideas",
      prompt: "What creative ideas do you have to increase our reach on campus?",
    },
    {
      id: "marketing-experience",
      prompt: "Do you have any prior experience in marketing?",
    },
  ],
  treasury: [
    {
      id: "other-committees",
      prompt: "Would you be interested in joining any of the other committees?",
    },
  ],
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
