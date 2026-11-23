import type { AuditAction, PointsSource, UserRole } from "@buzz/db";

import { roleLabel } from "~/app/portal/_lib/roles";
import { fromLocalInputValue } from "~/app/portal/_lib/format";

/** Rows per page, on the server prefetch and the client list alike. */
export const PAGE_SIZE = 25;

export const actionLabels: Record<AuditAction, string> = {
  "member.set_role": "Changed a role",
  "committee.set_status": "Moved an application",
  "event.manual_check_in": "Checked someone in",
  "event.remove_check_in": "Removed a check-in",
  "mentorship.award_points": "Awarded KIN points",
  "mentorship.award_group_points": "Awarded group KIN points",
  "kin_group.carry_forward": "Copied kin groups forward",
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

const rows = (value: unknown) => {
  const count = typeof value === "number" ? value : 0;
  return `${count} ${count === 1 ? "row" : "rows"}`;
};

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
