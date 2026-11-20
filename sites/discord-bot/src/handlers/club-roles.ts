/**
 * The five roles /setup chooses, with the names the club uses for them. The officer
 * role is stored as `officer_role_id` and is called Events Directors everywhere it is
 * shown. The club has no separate admin role: E-board is the admin, so /setup saves
 * the E-board role as `admin_role_id` too.
 */

import type { SetupRoles } from "../db/guild-config.ts";
import type { GuildConfig } from "../db/types.ts";
import { safe } from "../discord/safe-text.ts";
import type { SafeText } from "../discord/safe-text.ts";

export interface ClubRole {
  /** The /setup option that chooses it. */
  readonly option: string;
  readonly description: string;
  readonly label: SafeText;
  /** Where `guild_config` and the audit rows keep it. */
  readonly column:
    | "eboard_role_id"
    | "officer_role_id"
    | "events_committee_role_id"
    | "treasury_role_id"
    | "marketing_role_id";
  /** Admin is not chosen: it is saved from E-board. */
  readonly field: Exclude<keyof SetupRoles, "adminRoleId">;
}

/** E-board, which /setup also saves as the admin role. */
export const EBOARD_ROLE: ClubRole = {
  option: "eboard_role",
  description:
    "E-board: the bot's admins, can create events, assign steps and approve budgets",
  label: safe`E-board`,
  column: "eboard_role_id",
  field: "eboardRoleId",
};

export const EVENTS_DIRECTORS_ROLE: ClubRole = {
  option: "events_directors_role",
  description:
    "Events Directors: can create events, assign steps and approve budgets",
  label: safe`Events Directors`,
  column: "officer_role_id",
  field: "officerRoleId",
};

export const EVENTS_COMMITTEE_ROLE: ClubRole = {
  option: "events_committee_role",
  description: "Events Committee members, who work on the event steps",
  label: safe`Events Committee`,
  column: "events_committee_role_id",
  field: "eventsCommitteeRoleId",
};

export const TREASURY_ROLE: ClubRole = {
  option: "treasury_role",
  description: "Treasury Committee: pinged for budget sheets, can approve them",
  label: safe`Treasury Committee`,
  column: "treasury_role_id",
  field: "treasuryRoleId",
};

export const MARKETING_ROLE: ClubRole = {
  option: "marketing_role",
  description: "Marketing Committee: pinged when an Engage post is up",
  label: safe`Marketing Committee`,
  column: "marketing_role_id",
  field: "marketingRoleId",
};

/** In the order /setup asks for them and /config shows them. */
export const CLUB_ROLES: readonly ClubRole[] = [
  EBOARD_ROLE,
  EVENTS_DIRECTORS_ROLE,
  EVENTS_COMMITTEE_ROLE,
  TREASURY_ROLE,
  MARKETING_ROLE,
];

/** The admin role, which /setup sets to E-board but an older row can hold apart. */
export const ADMIN_LABEL: SafeText = safe`Admin`;

/** E-board's label where it is shown as the admin role too. */
export const EBOARD_ADMIN_LABEL: SafeText = safe`${EBOARD_ROLE.label} (also admin)`;

/** The label to show a chosen role under, naming E-board as the admin too. */
export function chosenLabel(role: ClubRole): SafeText {
  return role === EBOARD_ROLE ? EBOARD_ADMIN_LABEL : role.label;
}

/** What to say where a role is needed but has not been chosen. */
export function chooseRoleText(role: ClubRole): SafeText {
  return safe`Run /setup to choose the ${role.label} role.`;
}

/** Said in a message in place of pinging a role that has not been chosen. */
export function chooseRoleToPingText(role: ClubRole): SafeText {
  return safe`Run /setup to choose the ${role.label} role, so the next one pings it.`;
}

/** The bound role's ID, or null if it has not been chosen. */
export function boundRole(config: GuildConfig, role: ClubRole): string | null {
  return config[role.column];
}
