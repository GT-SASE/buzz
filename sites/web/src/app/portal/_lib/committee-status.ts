import type { CommitteeApplicationStatus } from "@buzz/db";

export const statusLabel: Record<CommitteeApplicationStatus, string> = {
  submitted: "Submitted",
  interviewing: "Interviewing",
  accepted: "Accepted",
  declined: "Declined",
  withdrawn: "Withdrawn",
};
