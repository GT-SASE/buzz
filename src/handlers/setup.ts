/**
 * /setup chooses the five roles: E-board, Events Directors (stored as the officer
 * role), Events Committee, Treasury Committee and Marketing Committee. The club has no
 * separate admin role, so E-board is saved as the admin role too. Discord's
 * Administrator permission still counts as admin.
 *
 * Discord hides the command from non-administrators by default, but a server admin
 * can change that, so the router's gate checks the Administrator bit from the signed
 * payload at each step: the command and the Confirm click alike. Guild and actor only
 * ever come from that payload.
 *
 * Five role IDs do not fit a custom_id, so /setup saves them as a draft for this member
 * and Confirm carries only the config version and the draft's fingerprint. Confirm
 * reads the draft back for the member who clicked and that fingerprint, so it applies
 * exactly the roles that member was shown, or nothing. The roles are checked again
 * against Discord before they are saved.
 *
 * Two admins can race. The version shown is carried in Confirm's custom_id and
 * compared with the database's: whoever was shown an old one gets a refresh message,
 * and the database function settles the case where both clicks arrive at once.
 */

import {
  ApplicationCommandOptionType,
  PermissionFlagsBits,
} from "discord-api-types/v10";
import { hasPermission } from "../discord/channel-permissions.ts";
import type { GuildRole } from "../discord/client.ts";
import { commandOptionValue, resolvedRole } from "../discord/interactions.ts";
import type { ResolvedRole } from "../discord/interactions.ts";
import { actionRow, button } from "../discord/outbound.ts";
import type { MessageInput } from "../discord/outbound.ts";
import { plain, safe } from "../discord/safe-text.ts";
import type { SafeText } from "../discord/safe-text.ts";
import {
  applyRoleBindings,
  draftRoles,
  getSetupDraft,
  saveSetupDraft,
  type SetupRoles,
} from "../db/guild-config.ts";
import { chosenLabel, CLUB_ROLES, type ClubRole } from "./club-roles.ts";
import { commaList, escapedName, lines } from "./render.ts";
import {
  commandRoute,
  componentRoute,
  noRow,
  valueOf,
  type FinishContext,
  type Handler,
} from "./router.ts";

const MAX_GRANTERS_SHOWN = 8;
// Five chosen names and up to eight granters must fit one message.
const CHOSEN_NAME_LENGTH = 100;
const GRANTER_NAME_LENGTH = 50;

const STALE = safe`Someone else changed the roles after this was shown, so nothing was changed. Run /setup again to see the current state.`;
const NO_DRAFT = safe`This Confirm no longer matches your latest /setup: it is over an hour old, someone ran /setup again since, or it was shown to another member. Nothing was changed. Run /setup again.`;

interface BindableRole {
  readonly id: string;
  readonly name: string;
  readonly managed: boolean;
}

function message(content: SafeText): MessageInput {
  return { content, mentionUserIds: [] };
}

function notFound(label: SafeText): SafeText {
  return safe`The ${label} role could not be found, so nothing was changed. Run /setup again.`;
}

/** Why a role cannot be bound, or undefined if it can. */
function bindingProblem(
  guildId: string,
  label: SafeText,
  role: BindableRole,
): SafeText | undefined {
  if (role.id === guildId) {
    return safe`The ${label} role can't be \\@everyone, because that would cover every member.`;
  }
  if (role.managed) {
    return safe`The ${label} role can't be ${escapedName(role.name, CHOSEN_NAME_LENGTH)}, because an integration controls who holds it.`;
  }
  return undefined;
}

type Chosen<R> = readonly (readonly [ClubRole, R])[];

type Checked<R> =
  { readonly chosen: Chosen<R> } | { readonly problem: SafeText };

/** Runs the same checks on every role, in the order they are asked for. */
function checkBindings<R extends BindableRole>(
  guildId: string,
  find: (role: ClubRole) => R | undefined,
): Checked<R> {
  const chosen: (readonly [ClubRole, R])[] = [];
  for (const clubRole of CLUB_ROLES) {
    const role = find(clubRole);
    if (role === undefined) {
      return { problem: notFound(clubRole.label) };
    }
    chosen.push([clubRole, role]);
  }
  for (const [clubRole, role] of chosen) {
    const problem = bindingProblem(guildId, clubRole.label, role);
    if (problem !== undefined) {
      return { problem };
    }
  }
  return { chosen };
}

function setupRoles(chosen: Chosen<BindableRole>): SetupRoles {
  const ids = new Map(
    chosen.map(([clubRole, role]) => [clubRole.field, role.id]),
  );
  const id = (field: ClubRole["field"]) => ids.get(field) ?? "";
  return {
    officerRoleId: id("officerRoleId"),
    // E-board is the admin role.
    adminRoleId: id("eboardRoleId"),
    eboardRoleId: id("eboardRoleId"),
    eventsCommitteeRoleId: id("eventsCommitteeRoleId"),
    treasuryRoleId: id("treasuryRoleId"),
    marketingRoleId: id("marketingRoleId"),
  };
}

function chosenLines(chosen: Chosen<BindableRole>): SafeText {
  return (
    lines(
      chosen.map(
        ([clubRole, role]) =>
          safe`${chosenLabel(clubRole)}: ${escapedName(role.name, CHOSEN_NAME_LENGTH)}`,
      ),
    ) ?? safe``
  );
}

/**
 * Every role holding Manage Roles or Administrator, including the chosen role itself.
 * Position is left out: whether one of them really can grant the role depends on who
 * holds what, which the bot cannot see, so this only says who may be able to.
 */
export function rolesThatMayGrant(
  roles: readonly GuildRole[],
): readonly GuildRole[] {
  return roles
    .filter(
      (role) =>
        hasPermission(role.permissions, PermissionFlagsBits.Administrator) ||
        hasPermission(role.permissions, PermissionFlagsBits.ManageRoles),
    )
    .sort((a, b) => b.position - a.position);
}

function grantersLine(roles: readonly GuildRole[] | undefined): SafeText {
  if (roles === undefined) {
    return safe`Roles that may be able to grant these: could not check, so review this in Server Settings. The server owner may also be able to.`;
  }
  const granters = rolesThatMayGrant(roles);
  const shown = commaList(
    granters
      .slice(0, MAX_GRANTERS_SHOWN)
      .map((role) => escapedName(role.name, GRANTER_NAME_LENGTH)),
  );
  if (shown === undefined) {
    return safe`Roles that may be able to grant these: none found. The server owner may also be able to.`;
  }
  return granters.length > MAX_GRANTERS_SHOWN
    ? safe`Roles that may be able to grant these: ${shown} and more. The server owner may also be able to.`
    : safe`Roles that may be able to grant these: ${shown}. The server owner may also be able to.`;
}

async function rolesOrUndefined(
  ctx: FinishContext,
): Promise<readonly GuildRole[] | undefined> {
  try {
    return await ctx.discord.getGuildRoles(ctx.actor.guildId);
  } catch {
    return undefined;
  }
}

function optionRole(
  ctx: FinishContext,
  name: string,
): ResolvedRole | undefined {
  const id = commandOptionValue(
    ctx.payload,
    name,
    ApplicationCommandOptionType.Role,
  );
  return typeof id === "string" ? resolvedRole(ctx.payload, id) : undefined;
}

const confirm = componentRoute({
  prefix: "setup.confirm",
  fields: ["version", "fingerprint"],
  gate: noRow("setup"),
  changesState: true,
  finish: async (ctx, _resource, [version, fingerprint]) => {
    const { guildId, userId } = ctx.actor;
    if ((ctx.config?.version ?? 0) !== version) {
      return message(STALE);
    }

    // Only the draft this member saved, with the fingerprint this button carries.
    const draft = valueOf(
      await getSetupDraft(ctx.db, {
        guildId,
        actorId: userId,
        fingerprint,
        now: new Date(),
      }),
    );
    if (draft === null) {
      return message(NO_DRAFT);
    }
    const ids = draftRoles(draft);

    const roles = await rolesOrUndefined(ctx);
    if (roles === undefined) {
      return message(
        safe`Could not check those roles with Discord, so nothing was changed. Click Confirm again in a moment.`,
      );
    }
    const checked = checkBindings(guildId, (clubRole) =>
      roles.find((role) => role.id === ids[clubRole.field]),
    );
    if ("problem" in checked) {
      return message(checked.problem);
    }

    // Literal arguments, from the signed payload, the draft and the checks above.
    const saved = await applyRoleBindings(ctx.db, {
      guildId,
      actorId: userId,
      expectedVersion: version,
      ...setupRoles(checked.chosen),
    });
    if (!saved.ok && saved.error.category === "stale_version") {
      return message(STALE);
    }
    valueOf(saved);
    return message(safe`Saved.\n${chosenLines(checked.chosen)}`);
  },
});

export const handler: Handler = {
  commands: [
    {
      name: "setup",
      description: "Choose the club's roles for this bot",
      // Hidden unless a server admin changes it. Never relied on: see the gate.
      default_member_permissions: "0",
      options: CLUB_ROLES.map((clubRole) => ({
        type: ApplicationCommandOptionType.Role,
        name: clubRole.option,
        description: clubRole.description,
        required: true,
      })),
    },
  ],
  routes: [
    commandRoute({
      path: "setup",
      gate: noRow("setup"),
      changesState: false,
      finish: async (ctx) => {
        const checked = checkBindings(ctx.actor.guildId, (clubRole) =>
          optionRole(ctx, clubRole.option),
        );
        if ("problem" in checked) {
          return message(checked.problem);
        }

        // A pending choice for Confirm to read back. The settings are not changed yet.
        const fingerprint = valueOf(
          await saveSetupDraft(ctx.db, {
            guildId: ctx.actor.guildId,
            actorId: ctx.actor.userId,
            roles: setupRoles(checked.chosen),
          }),
        );
        const roles = await rolesOrUndefined(ctx);
        return {
          content: safe`**Check these roles, then click Confirm.**
${chosenLines(checked.chosen)}
${grantersLine(roles)}`,
          mentionUserIds: [],
          components: [
            actionRow(
              button({
                customId: confirm.id(ctx.config?.version ?? 0, fingerprint),
                label: plain`Confirm`,
                style: "success",
              }),
            ),
          ],
        };
      },
    }),
    confirm,
  ],
};
