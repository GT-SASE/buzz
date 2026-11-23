import type { AuditAction, PointsSource, UserRole } from "@buzz/db";

import { roleLabel } from "~/app/portal/_lib/roles";
import { fromLocalInputValue } from "~/app/portal/_lib/format";

/** Rows per page, on the server prefetch and the client list alike. */
export const PAGE_SIZE = 25;

export const actionLabels: Record<AuditAction, string> = {
  "member.set_role": "Changed a role",
  "member.set_graduation_year": "Changed a graduation year",
  "committee.set_status": "Moved an application",
  "event.manual_check_in": "Checked someone in",
  "event.remove_check_in": "Removed a check-in",
  "mentorship.award_points": "Awarded KIN points",
  "mentorship.award_group_points": "Awarded group KIN points",
  "kin_group.carry_forward": "Copied kin groups forward",
  "election.create": "Created an election",
  "election.configure": "Changed an election's schedule",
  "election.set_phase": "Moved an election to a new phase",
  "election.edit_positions": "Edited election positions",
  "election.review_candidate": "Reviewed a candidate",
  "election.delete": "Deleted an election",
  "export.election_tally": "Exported an election tally",
  "board.remove_photo": "Removed a board headshot",
  "page.create": "Created a page",
  "page.publish": "Published a page",
  "page.unpublish": "Took a page down",
  "page.restore": "Restored a page version",
  "page.delete": "Deleted a page",
  "page.upload_image": "Uploaded a page image",
  "export.roster": "Exported the roster",
  "export.attendance": "Exported attendance",
  "export.committee": "Exported applications",
  "resume.download": "Downloaded a resume",
};

export const sourceLabels: Record<PointsSource, string> = {
  check_in: "Check-in",
  manual_check_in: "Officer check-in",
  check_in_removed: "Check-in removed",
  kin_award: "KIN award",
  kin_group_award: "KIN group award",
  opening_balance: "Opening balance",
};

/**
 * The filter menus, in the order above. The label maps are typed over every
 * action and source, so a new one fails the build until it has a label, and
 * this client file never imports the schema (and drizzle with it) for a list.
 */
export const actionNames = Object.keys(actionLabels) as AuditAction[];
export const sourceNames = Object.keys(sourceLabels) as PointsSource[];

type Json = Record<string, unknown> | null;

const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "?";

const role = (value: unknown) =>
  typeof value === "string" ? roleLabel(value as UserRole) : "?";

const year = (value: unknown) =>
  typeof value === "number" ? String(value) : "unset";

const rows = (value: unknown) => {
  const count = typeof value === "number" ? value : 0;
  return `${count} ${count === 1 ? "row" : "rows"}`;
};

const when = (value: unknown) =>
  typeof value === "string"
    ? value.slice(0, 16).replace("T", " ") + " UTC"
    : "unset";

const scheduleText = (value: Json) =>
  `opens ${when(value?.opensAt)}, closes ${when(value?.closesAt)}, ${text(value?.minCheckIns)}+ check-ins`;

/** One line saying what changed, from the row's `before` and `after`. */
export function describeChange(row: {
  action: AuditAction;
  before: Json;
  after: Json;
}): string {
  const { before, after } = row;

  switch (row.action) {
    case "member.set_role":
      return `${role(before?.role)} to ${role(after?.role)}`;
    case "member.set_graduation_year":
      return `${year(before?.graduationYear)} to ${year(after?.graduationYear)}`;
    case "committee.set_status":
      return `${text(before?.status)} to ${text(after?.status)}, ${text(after?.cycle)}`;
    case "event.manual_check_in":
      return `${text(after?.event)}, +${text(after?.points)} points`;
    case "event.remove_check_in":
      return `${text(before?.event)}, -${text(before?.points)} points`;
    case "mentorship.award_points":
      return `${text(before?.points)} to ${text(after?.points)} points`;
    case "mentorship.award_group_points":
      return `+${text(after?.points)} points each to ${text(after?.members)} members`;
    case "kin_group.carry_forward":
      return `${text(after?.from)} to ${text(after?.to)}, ${text(after?.created)} new, ${text(after?.skipped)} already there`;
    case "election.create":
      return `${text(after?.positions)} positions, ${scheduleText(after)}`;
    case "election.configure":
      return `${scheduleText(before)} to ${scheduleText(after)}`;
    case "election.set_phase":
      return `${text(before?.phase)} to ${text(after?.phase)}${after?.scheduled ? " by schedule" : ""}${typeof after?.voters === "number" ? `, ${rows(after.voters).replace("row", "voter")} frozen` : ""}`;
    case "election.edit_positions":
      if (after?.added) return `Added ${text(after.added)}`;
      if (before?.removed) return `Removed ${text(before.removed)}`;
      return `${text(before?.renamed)} to ${text(after?.renamed)}`;
    case "election.review_candidate":
      return `${text(after?.candidate)}: ${text(before?.status)} to ${text(after?.status)}`;
    case "election.delete":
      return "Deleted";
    case "export.election_tally":
      return rows(after?.rows);
    case "board.remove_photo":
      return "Headshot taken down";
    case "page.create":
      return `/${text(after?.slug)}`;
    case "page.publish":
      return before?.slug && before.slug !== after?.slug
        ? `v${text(after?.version)}, /${text(before.slug)} to /${text(after?.slug)}`
        : `v${text(after?.version)}, /${text(after?.slug)}`;
    case "page.unpublish":
      return `/${text(before?.slug)} is a draft again`;
    case "page.restore":
      return `v${text(after?.restoredFrom)} as draft v${text(after?.version)}`;
    case "page.delete":
      return `/${text(before?.slug)} deleted`;
    case "page.upload_image":
      return `${text(after?.width)} x ${text(after?.height)}, ${text(after?.bytes)} bytes`;
    case "export.roster": {
      const search = typeof after?.search === "string" ? after.search : "";
      return `${rows(after?.rows)}${after?.truncated ? ", cut off at the limit" : ""}${search ? `, search "${search}"` : ""}`;
    }
    case "export.attendance":
    case "export.committee":
      return `${rows(after?.rows)}${after?.truncated ? ", cut off at the limit" : ""}`;
    case "resume.download":
      return text(after?.fileName);
  }
}

/** Who or what an audit row is about, as a person would name it. */
export function describeTarget(row: {
  targetType: string;
  targetName: string | null;
  targetEmail: string | null;
  targetLabel: string | null;
  targetId: string | null;
}): string {
  if (row.targetType === "roster") return "Whole roster";
  return (
    row.targetName ??
    row.targetEmail ??
    row.targetLabel ??
    row.targetId ??
    "Unknown"
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Two `YYYY-MM-DD` inputs to the instants the API wants, in Atlanta time like
 * every other date in the portal: `from` is the start of its day and `to` is
 * the start of the day after, so picking the same day twice means that day.
 */
export function dateRange(from: string, to: string) {
  const dayAfter = (value: string) =>
    new Date(Date.parse(`${value}T00:00:00Z`) + DAY_MS)
      .toISOString()
      .slice(0, 10);

  return {
    from: from ? fromLocalInputValue(`${from}T00:00`) : undefined,
    to: to ? fromLocalInputValue(`${dayAfter(to)}T00:00`) : undefined,
  };
}
