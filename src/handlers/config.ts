/**
 * /config is a private panel for the admin tier: managed forums, the reminders
 * switch, and the last changes. The router's gate checks each click from its own
 * signed payload, so a copied panel or a role removed since it opened gets nowhere.
 *
 * The panel's version is carried in each custom_id, and every write sends it to
 * apply_config_change, which refuses a stale one. The panel then redraws from the
 * database and says that nothing was saved. Guild and actor come only from the signed
 * payload, and a channel ID from a click only ever names a channel to look up.
 *
 * Channels appear as mentions, which Discord renders itself, so a deleted one shows as
 * unknown and breaks nothing. The select sends no default values, because a default
 * naming a deleted channel is the one thing that could stop the panel being drawn.
 */

import {
  ChannelType,
  ComponentType,
  PermissionFlagsBits,
} from "discord-api-types/v10";
import {
  channelPermissions,
  everyoneCanView,
  hasPermission,
} from "../discord/channel-permissions.ts";
import type { GuildChannel, GuildRole } from "../discord/client.ts";
import {
  isComponentType,
  resolvedChannel,
  selectedValues,
} from "../discord/interactions.ts";
import {
  actionRow,
  button,
  channelSelect,
  stringSelect,
} from "../discord/outbound.ts";
import type { MessageInput, Part, SelectOption } from "../discord/outbound.ts";
import {
  channelMention,
  escapeUserText,
  plain,
  plainLabel,
  safe,
  SafeTextError,
  userMention,
} from "../discord/safe-text.ts";
import type { PlainText, SafeText } from "../discord/safe-text.ts";
import {
  applyConfigChange,
  getGuildConfig,
  listRecentConfigChanges,
} from "../db/guild-config.ts";
import { errorSummary } from "../db/errors.ts";
import {
  listManagedChannels,
  listRecentEventsInChannel,
} from "../db/managed-channels.ts";
import { countOpenTasksInChannel } from "../db/tasks.ts";
import type { ConfigChange, GuildConfig, ManagedChannel } from "../db/types.ts";
import { refreshOverview } from "../events/overview.ts";
import { isSnowflake } from "../lib/snowflake.ts";
import { commaList, lines } from "./render.ts";
import {
  commandRoute,
  componentRoute,
  HandlerFailure,
  noRow,
  valueOf,
  type FinishContext,
  type Handler,
} from "./router.ts";

// Mentions and warnings of this many forums fit a message with room for the changes.
const MAX_FORUMS_SHOWN = 15;
const MAX_SELECT_OPTIONS = 25;
// The panel only ever changes one forum at a time, but an audit row can name up to 25.
const MAX_CHANNELS_PER_CHANGE = 3;
// Re-adding a forum redraws its posts before the panel answers. Each post can take a few
// Discord calls, so this stops in good time for the panel inside the function's 60 seconds.
const MAX_POSTS_REFRESHED = 10;
const POST_REFRESH_BUDGET_MS = 20_000;
const FORUM_TYPE: number = ChannelType.GuildForum;

/** What the bot needs in a forum, each with the name Discord's settings show. */
const REQUIRED_PERMISSIONS: readonly (readonly [bigint, SafeText])[] = [
  [PermissionFlagsBits.ViewChannel, safe`View Channel`],
  [PermissionFlagsBits.SendMessages, safe`Send Messages`],
  [PermissionFlagsBits.SendMessagesInThreads, safe`Send Messages in Threads`],
];

const SAVED_BY_SOMEONE_ELSE = safe`Someone else changed the settings first, so nothing was saved. This panel now shows the latest values. Please try again if you still want the change.`;
const NOT_A_FORUM = safe`That is not a forum in this server, so nothing was changed.`;
const CANNOT_CHECK = safe`Discord would not confirm that forum or what the bot can do in it, so nothing was changed. Please try again in a moment.`;

/** What Discord says now. Each part is undefined if it could not be read. */
interface GuildView {
  readonly channels: readonly GuildChannel[] | undefined;
  readonly roles: readonly GuildRole[] | undefined;
}

async function orUndefined<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read;
  } catch {
    return undefined;
  }
}

async function readGuildView(ctx: FinishContext): Promise<GuildView> {
  const { guildId } = ctx.actor;
  const [channels, roles] = await Promise.all([
    orUndefined(ctx.discord.getGuildChannels(guildId)),
    orUndefined(ctx.discord.getGuildRoles(guildId)),
  ]);
  return { channels, roles };
}

function forumLine(
  forum: ManagedChannel,
  guildId: string,
  { channels, roles }: GuildView,
): SafeText {
  const mention = channelMention(forum.channel_id);
  const deleted = safe`- ${mention}: deleted from Discord, so you can remove it here`;
  const channel = channels?.find((item) => item.id === forum.channel_id);
  // The status is only ever set when Discord answers Unknown Channel, and a permission
  // failure never sets it. So it means deleted, unless the channel list now says otherwise.
  if (forum.status === "unavailable") {
    return channel === undefined
      ? deleted
      : safe`- ${mention}: marked deleted, but Discord lists it. Add it again to resume`;
  }
  if (channels === undefined) {
    return safe`- ${mention}`;
  }
  if (channel === undefined) {
    return deleted;
  }
  return roles !== undefined &&
    everyoneCanView(guildId, roles, channel) === true
    ? safe`- ${mention}: \\@everyone can view this forum`
    : safe`- ${mention}`;
}

function forumOptionLabel(
  forum: ManagedChannel,
  { channels }: GuildView,
): PlainText {
  const channel = channels?.find((item) => item.id === forum.channel_id);
  try {
    return plainLabel(channel?.name ?? `Forum ${forum.channel_id}`);
  } catch (error) {
    if (error instanceof SafeTextError) {
      return plainLabel(`Forum ${forum.channel_id}`);
    }
    throw error;
  }
}

/** The channel IDs under a key of an audit row's values. Undefined if it has no such list. */
function channelIds(
  values: unknown,
  key: string,
): readonly string[] | undefined {
  if (typeof values !== "object" || values === null) {
    return undefined;
  }
  const ids = (values as Record<string, unknown>)[key];
  return Array.isArray(ids) ? ids.filter(isSnowflake) : undefined;
}

function changedForums(ids: readonly string[]): SafeText | undefined {
  const shown = commaList(
    ids.slice(0, MAX_CHANNELS_PER_CHANGE).map((id) => channelMention(id)),
  );
  const more = ids.length - MAX_CHANNELS_PER_CHANGE;
  return more > 0 && shown !== undefined
    ? safe`${shown} and ${escapeUserText(String(more))} more`
    : shown;
}

function remindersValue(values: unknown): unknown {
  return typeof values === "object" && values !== null
    ? (values as { reminders_enabled?: unknown }).reminders_enabled
    : undefined;
}

/** Describes one audit row. Only IDs and fixed words reach the message. */
function changeSummary(change: ConfigChange): SafeText {
  if (change.action === "role_bindings") {
    return safe`changed the roles`;
  }
  // A row saved before the explicit lists existed only has the active forums to compare.
  // Those miss a forum that was already unavailable, which is why the lists were added.
  const before = channelIds(change.old_values, "active_channel_ids") ?? [];
  const after = channelIds(change.new_values, "active_channel_ids") ?? [];
  const added =
    channelIds(change.new_values, "added_channel_ids") ??
    after.filter((id) => !before.includes(id));
  const removed =
    channelIds(change.new_values, "removed_channel_ids") ??
    before.filter((id) => !after.includes(id));
  const parts: SafeText[] = [];
  const addedForums = changedForums(added);
  if (addedForums !== undefined) {
    parts.push(safe`added ${addedForums}`);
  }
  const removedForums = changedForums(removed);
  if (removedForums !== undefined) {
    parts.push(safe`removed ${removedForums}`);
  }
  const reminders = remindersValue(change.new_values);
  if (reminders !== remindersValue(change.old_values)) {
    parts.push(
      reminders === true
        ? safe`turned reminders on`
        : safe`turned reminders off`,
    );
  }
  return commaList(parts) ?? safe`changed settings`;
}

function changeLine(change: ConfigChange): SafeText {
  const day = escapeUserText(change.created_at.slice(0, 10));
  return safe`- ${day}, ${userMention(change.actor_id)}: ${changeSummary(change)}`;
}

function panelRows(
  config: GuildConfig,
  forums: readonly ManagedChannel[],
  view: GuildView,
): Part<"row">[] {
  const { version } = config;
  const rows: Part<"row">[] = [
    actionRow(
      channelSelect({
        customId: addForum.id(version),
        channelTypes: [FORUM_TYPE],
        placeholder: plain`Add a managed forum`,
      }),
    ),
    actionRow(
      config.reminders_enabled
        ? button({
            customId: remindersOff.id(version),
            label: plain`Turn reminders off`,
            style: "danger",
          })
        : button({
            customId: remindersOn.id(version),
            label: plain`Turn reminders on`,
            style: "success",
          }),
      button({ customId: refresh.id(), label: plain`Refresh` }),
    ),
  ];
  if (forums.length > 0) {
    const options: SelectOption[] = forums
      .slice(0, MAX_SELECT_OPTIONS)
      .map((forum) => ({
        label: forumOptionLabel(forum, view),
        value: forum.channel_id,
      }));
    rows.push(
      actionRow(
        stringSelect({
          customId: removeForum.id(version),
          placeholder: plain`Remove a managed forum`,
          options,
        }),
      ),
    );
  }
  return rows;
}

async function renderPanel(
  ctx: FinishContext,
  note?: SafeText,
): Promise<MessageInput> {
  const { guildId } = ctx.actor;
  const [config, forums, changes, view] = await Promise.all([
    getGuildConfig(ctx.db, { guildId }),
    listManagedChannels(ctx.db, { guildId }),
    listRecentConfigChanges(ctx.db, { guildId }),
    readGuildView(ctx),
  ]);
  const current = valueOf(config);
  if (current === null) {
    throw new HandlerFailure("config row gone");
  }
  const shown = valueOf(forums).rows.filter(
    (forum) => forum.status !== "removed",
  );

  const forumLines =
    lines(
      shown
        .slice(0, MAX_FORUMS_SHOWN)
        .map((forum) => forumLine(forum, guildId, view)),
    ) ?? safe`None yet. The bot posts only in managed forums.`;
  const more = shown.length - MAX_FORUMS_SHOWN;
  const changeLines =
    lines(valueOf(changes).rows.map(changeLine)) ?? safe`None yet.`;
  const reminders = current.reminders_enabled ? safe`on` : safe`off`;
  // The run closes the day's slot even with nothing to send, and the slot stays closed.
  const whenOff = current.reminders_enabled
    ? safe``
    : safe`\nTurning them on after the day's run (around 14:00 UTC) does not reopen it: they resume with the next day's run.`;
  const body = safe`**Bot settings**
Reminders: **${reminders}**${whenOff}

**Managed forums**
${forumLines}${more > 0 ? safe`\nAnd ${escapeUserText(String(more))} more.` : safe``}${view.channels === undefined ? safe`\nCould not read this server's channels, so deleted and visible forums are not flagged.` : safe``}

**Last changes**
${changeLines}`;
  return {
    content: note === undefined ? body : safe`${note}\n\n${body}`,
    // The panel names members only as text. Nobody is pinged.
    mentionUserIds: [],
    components: panelRows(current, shown, view),
  };
}

interface Change {
  readonly remindersEnabled?: boolean;
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
}

/** Literal arguments: guild and actor from the signed payload, the rest named here. */
async function applyChange(
  ctx: FinishContext,
  version: number,
  change: Change,
  saved: SafeText | (() => Promise<SafeText>),
): Promise<MessageInput> {
  const result = await applyConfigChange(ctx.db, {
    guildId: ctx.actor.guildId,
    actorId: ctx.actor.userId,
    expectedVersion: version,
    remindersEnabled: change.remindersEnabled ?? null,
    addChannelIds: change.add ?? [],
    removeChannelIds: change.remove ?? [],
    timezone: null,
  });
  if (!result.ok && result.error.category === "stale_version") {
    return renderPanel(ctx, SAVED_BY_SOMEONE_ELSE);
  }
  if (!result.ok && result.error.category === "constraint") {
    return renderPanel(
      ctx,
      safe`That change is no longer possible, so nothing was saved.`,
    );
  }
  valueOf(result);
  return renderPanel(ctx, typeof saved === "function" ? await saved() : saved);
}

/**
 * What changed while a forum was removed never reached its posts, and a closed event has
 * no later change to bring its post up to date. So re-adding redraws the most recently
 * changed posts, and says how far it got. The forum is already added and stays added.
 */
async function refreshForumPosts(
  ctx: FinishContext,
  channelId: string,
): Promise<SafeText> {
  const { guildId } = ctx.actor;
  const events = await listRecentEventsInChannel(ctx.db, {
    guildId,
    channelId,
    limit: MAX_POSTS_REFRESHED,
  }).catch(() => undefined);
  if (!events?.ok) {
    console.error(
      `Forum post refresh could not list events: ${events === undefined ? "request failed" : errorSummary(events.error)}`,
    );
    return safe` Its event posts could not be checked, so some may be out of date.`;
  }
  const { rows, truncated, excluded } = events.value;
  if (excluded.length > 0) {
    console.error(
      `Forum post refresh: ${String(excluded.length)} row(s) failed their checks`,
    );
  }
  const deadline = Date.now() + POST_REFRESH_BUDGET_MS;
  let updated = 0;
  for (const event of rows) {
    if (Date.now() >= deadline) {
      break;
    }
    if (await refreshOverview(ctx, event)) {
      updated += 1;
    }
  }
  const missed = rows.length + excluded.length - updated;
  if (missed === 0 && !truncated) {
    return updated === 0
      ? safe``
      : safe` Its ${escapeUserText(String(updated))} event post(s) are up to date.`;
  }
  const updatedCount = escapeUserText(String(updated));
  const missedCount = escapeUserText(String(missed));
  return safe` Updated ${updatedCount} of its event posts.${missed > 0 ? safe` ${missedCount} could not be updated.` : safe``}${truncated ? safe` Older posts were not checked.` : safe``}`;
}

function missingPermissions(permissions: bigint): SafeText | undefined {
  return commaList(
    REQUIRED_PERMISSIONS.filter(
      ([bit]) => !hasPermission(permissions, bit),
    ).map(([, name]) => name),
  );
}

/**
 * What the bot can do in a chosen forum: what Discord reports for that channel, or
 * else what its roles and the forum's overwrites add up to. Undefined if neither is
 * available. The top-level `app_permissions` is not used, because it describes the
 * channel the panel was opened in.
 */
async function botPermissionsIn(
  ctx: FinishContext,
  fromResolved: bigint | undefined,
  forum: GuildChannel | undefined,
  roles: readonly GuildRole[] | undefined,
): Promise<bigint | undefined> {
  if (fromResolved !== undefined) {
    return fromResolved;
  }
  if (forum === undefined || roles === undefined) {
    return undefined;
  }
  const appId = ctx.payload.application_id;
  const memberRoleIds = await orUndefined(
    ctx.discord.getGuildMemberRoleIds(ctx.actor.guildId, appId),
  );
  return memberRoleIds === undefined
    ? undefined
    : channelPermissions({
        guildId: ctx.actor.guildId,
        roles,
        channel: forum,
        memberRoleIds,
        memberId: appId,
      });
}

/** The one value of a select of this type. Each select here takes exactly one. */
function onlySelected(
  ctx: FinishContext,
  type: ComponentType,
): string | undefined {
  const values = selectedValues(ctx.payload);
  return isComponentType(ctx.payload, type) && values?.length === 1
    ? values[0]
    : undefined;
}

const refresh = componentRoute({
  prefix: "config.view",
  fields: [],
  gate: noRow("config.view"),
  changesState: false,
  finish: (ctx) => renderPanel(ctx),
});

const remindersOn = componentRoute({
  prefix: "config.reminders-on",
  fields: ["version"],
  gate: noRow("config.change"),
  changesState: true,
  finish: (ctx, _resource, [version]) =>
    applyChange(
      ctx,
      version,
      { remindersEnabled: true },
      safe`Reminders are on. If the day's run (around 14:00 UTC) has already happened, they resume with the next day's run.`,
    ),
});

const remindersOff = componentRoute({
  prefix: "config.reminders-off",
  fields: ["version"],
  gate: noRow("config.change"),
  changesState: true,
  finish: (ctx, _resource, [version]) =>
    applyChange(
      ctx,
      version,
      { remindersEnabled: false },
      safe`Reminders are off, so none will be sent.`,
    ),
});

const addForum = componentRoute({
  prefix: "config.add",
  fields: ["version"],
  gate: noRow("config.change"),
  changesState: true,
  finish: async (ctx, _resource, [version]) => {
    const { guildId } = ctx.actor;
    const channelId = onlySelected(ctx, ComponentType.ChannelSelect);
    if (channelId === undefined) {
      return renderPanel(ctx, NOT_A_FORUM);
    }
    const resolved = resolvedChannel(ctx.payload, channelId);
    if (
      resolved?.type !== FORUM_TYPE ||
      (resolved.guildId !== undefined && resolved.guildId !== guildId)
    ) {
      return renderPanel(ctx, NOT_A_FORUM);
    }

    const managed = valueOf(await listManagedChannels(ctx.db, { guildId }));
    const known = managed.rows.find((row) => row.channel_id === channelId);
    if (known?.status === "active") {
      return renderPanel(
        ctx,
        safe`${channelMention(channelId)} is already managed, so nothing was changed.`,
      );
    }

    const view = await readGuildView(ctx);
    const forum = view.channels?.find((item) => item.id === channelId);
    if (view.channels !== undefined && forum?.type !== FORUM_TYPE) {
      return renderPanel(ctx, NOT_A_FORUM);
    }
    // Discord may leave the guild out of `resolved`, so this needs one or the other.
    if (view.channels === undefined && resolved.guildId === undefined) {
      return renderPanel(ctx, CANNOT_CHECK);
    }

    const permissions = await botPermissionsIn(
      ctx,
      resolved.appPermissions,
      forum,
      view.roles,
    );
    if (permissions === undefined) {
      return renderPanel(ctx, CANNOT_CHECK);
    }
    const missing = missingPermissions(permissions);
    if (missing !== undefined) {
      return renderPanel(
        ctx,
        safe`The bot is missing these permissions in that forum: ${missing}. Grant them, then add it again. Nothing was changed.`,
      );
    }
    return applyChange(
      ctx,
      version,
      { add: [channelId] },
      // A forum with no row yet can have no events.
      known === undefined
        ? safe`Added ${channelMention(channelId)}.`
        : async () =>
            safe`Added ${channelMention(channelId)}.${await refreshForumPosts(ctx, channelId)}`,
    );
  },
});

const confirmRemoval = componentRoute({
  prefix: "config.remove-yes",
  fields: ["version", "snowflake"],
  gate: noRow("config.change"),
  changesState: true,
  finish: (ctx, _resource, [version, channelId]) =>
    applyChange(
      ctx,
      version,
      { remove: [channelId] },
      safe`Removed ${channelMention(channelId)}. Its events and tasks are kept, and adding it again resumes posting.`,
    ),
});

/** Shows the warning. Nothing changes until the second click. */
const removeForum = componentRoute({
  prefix: "config.remove",
  fields: ["version"],
  gate: noRow("config.change"),
  changesState: false,
  finish: async (ctx, _resource, [version]) => {
    const { guildId } = ctx.actor;
    if (ctx.config?.version !== version) {
      return renderPanel(ctx, SAVED_BY_SOMEONE_ELSE);
    }
    const channelId = onlySelected(ctx, ComponentType.StringSelect);
    if (!isSnowflake(channelId)) {
      return renderPanel(ctx, NOT_A_FORUM);
    }
    const forums = valueOf(await listManagedChannels(ctx.db, { guildId }));
    const isManaged = forums.rows.some(
      (forum) => forum.channel_id === channelId && forum.status !== "removed",
    );
    if (!isManaged) {
      return renderPanel(
        ctx,
        safe`That forum is not managed, so nothing was changed.`,
      );
    }

    const { count, truncated } = valueOf(
      await countOpenTasksInChannel(ctx.db, { guildId, channelId }),
    );
    const tasks = escapeUserText(String(count));
    return {
      content: safe`**Remove ${channelMention(channelId)}?**
It has ${truncated ? safe`over ` : safe``}${tasks} open task(s). The bot will stop posting there, including reminders. The tasks are kept, /mytasks still lists them, and adding the forum again resumes posting.`,
      mentionUserIds: [],
      components: [
        actionRow(
          button({
            customId: confirmRemoval.id(version, channelId),
            label: plain`Remove it`,
            style: "danger",
          }),
          button({ customId: refresh.id(), label: plain`Keep it` }),
        ),
      ],
    };
  },
});

export const handler: Handler = {
  commands: [
    {
      name: "config",
      description: "Show and change this bot's settings",
    },
  ],
  routes: [
    commandRoute({
      path: "config",
      gate: noRow("config.view"),
      changesState: false,
      finish: (ctx) => renderPanel(ctx),
    }),
    refresh,
    remindersOn,
    remindersOff,
    addForum,
    removeForum,
    confirmRemoval,
  ],
};
