/**
 * /setup chooses the officer and admin roles.
 *
 * Discord hides the command from non-administrators by default, but a server admin
 * can change that, so the router's gate checks the Administrator bit from the signed
 * payload at each step: the command and the Confirm click alike. Guild and actor only
 * ever come from that payload. Role IDs come from the options or the custom_id and
 * are checked again against Discord before they are saved.
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
import { applyRoleBindings } from "../db/guild-config.ts";
import { commaList, escapedName } from "./render.ts";
import {
  commandRoute,
  componentRoute,
  noRow,
  valueOf,
  type FinishContext,
  type Handler,
} from "./router.ts";

const MAX_GRANTERS_SHOWN = 8;
// Two chosen names and up to eight granters must fit one message.
const CHOSEN_NAME_LENGTH = 100;
const GRANTER_NAME_LENGTH = 50;

const STALE = safe`Someone else changed the roles after this was shown, so nothing was changed. Run /setup again to see the current state.`;

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

type Checked<R> =
  { readonly officer: R; readonly admin: R } | { readonly problem: SafeText };

function checkBindings<R extends BindableRole>(
  guildId: string,
  officer: R | undefined,
  admin: R | undefined,
): Checked<R> {
  if (officer === undefined) {
    return { problem: notFound(safe`officer`) };
  }
  if (admin === undefined) {
    return { problem: notFound(safe`admin`) };
  }
  const problem =
    bindingProblem(guildId, safe`officer`, officer) ??
    bindingProblem(guildId, safe`admin`, admin);
  return problem === undefined ? { officer, admin } : { problem };
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
    return safe`Roles that may be able to grant this: could not check, so review this in Server Settings. The server owner may also be able to.`;
  }
  const granters = rolesThatMayGrant(roles);
  const shown = commaList(
    granters
      .slice(0, MAX_GRANTERS_SHOWN)
      .map((role) => escapedName(role.name, GRANTER_NAME_LENGTH)),
  );
  if (shown === undefined) {
    return safe`Roles that may be able to grant this: none found. The server owner may also be able to.`;
  }
  return granters.length > MAX_GRANTERS_SHOWN
    ? safe`Roles that may be able to grant this: ${shown} and more. The server owner may also be able to.`
    : safe`Roles that may be able to grant this: ${shown}. The server owner may also be able to.`;
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
  fields: ["version", "snowflake", "snowflake"],
  gate: noRow("setup"),
  changesState: true,
  finish: async (ctx, _resource, [version, officerRoleId, adminRoleId]) => {
    const { guildId, userId } = ctx.actor;
    if ((ctx.config?.version ?? 0) !== version) {
      return message(STALE);
    }

    const roles = await rolesOrUndefined(ctx);
    if (roles === undefined) {
      return message(
        safe`Could not check those roles with Discord, so nothing was changed. Click Confirm again in a moment.`,
      );
    }
    const checked = checkBindings(
      guildId,
      roles.find((role) => role.id === officerRoleId),
      roles.find((role) => role.id === adminRoleId),
    );
    if ("problem" in checked) {
      return message(checked.problem);
    }

    // Literal arguments, from the signed payload and the checks above.
    const saved = await applyRoleBindings(ctx.db, {
      guildId,
      actorId: userId,
      expectedVersion: version,
      officerRoleId,
      adminRoleId,
    });
    if (!saved.ok && saved.error.category === "stale_version") {
      return message(STALE);
    }
    valueOf(saved);
    return message(
      safe`Saved. Officer role: ${escapedName(checked.officer.name, CHOSEN_NAME_LENGTH)}. Admin role: ${escapedName(checked.admin.name, CHOSEN_NAME_LENGTH)}.`,
    );
  },
});

export const handler: Handler = {
  commands: [
    {
      name: "setup",
      description: "Choose the officer and admin roles for this bot",
      // Hidden unless a server admin changes it. Never relied on: see the gate.
      default_member_permissions: "0",
      options: [
        {
          type: ApplicationCommandOptionType.Role,
          name: "officer_role",
          description: "Who can create events and assign tasks",
          required: true,
        },
        {
          type: ApplicationCommandOptionType.Role,
          name: "admin_role",
          description: "Who can change this bot's settings",
          required: true,
        },
      ],
    },
  ],
  routes: [
    commandRoute({
      path: "setup",
      gate: noRow("setup"),
      changesState: false,
      finish: async (ctx) => {
        const checked = checkBindings(
          ctx.actor.guildId,
          optionRole(ctx, "officer_role"),
          optionRole(ctx, "admin_role"),
        );
        if ("problem" in checked) {
          return message(checked.problem);
        }
        const { officer, admin } = checked;

        const roles = await rolesOrUndefined(ctx);
        const officerName = escapedName(officer.name, CHOSEN_NAME_LENGTH);
        const adminName = escapedName(admin.name, CHOSEN_NAME_LENGTH);
        return {
          content: safe`**Check these roles, then click Confirm.**
Officer role: ${officerName}
Admin role: ${adminName}
${grantersLine(roles)}`,
          mentionUserIds: [],
          components: [
            actionRow(
              button({
                customId: confirm.id(
                  ctx.config?.version ?? 0,
                  officer.id,
                  admin.id,
                ),
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
