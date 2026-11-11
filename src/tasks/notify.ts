/**
 * Tells an assignee about a task, in the event's post. The send goes through the
 * client's checked path, and only this user can be pinged, whatever the text says.
 *
 * The task is saved before this runs, so a failed send loses nothing. It only changes
 * what the officer is told, because the assignee has not heard and someone must tell them.
 */

import { PermissionFlagsBits } from "discord-api-types/v10";
import {
  channelPermissions,
  hasPermission,
} from "../discord/channel-permissions.ts";
import { DiscordClientError } from "../discord/client.ts";
import type { DiscordFailure } from "../discord/client.ts";
import { channelMessage } from "../discord/outbound.ts";
import type { MessageInput } from "../discord/outbound.ts";
import { safe, userMention } from "../discord/safe-text.ts";
import type { SafeText } from "../discord/safe-text.ts";
import { getManagedChannel } from "../db/managed-channels.ts";
import type { EventRow, TaskRow } from "../db/types.ts";
import type { FinishContext } from "../handlers/router.ts";
import { markDoneRow } from "./done.ts";
import { shownDate, shownId, taskText } from "./shared.ts";

export type NoticeOutcome = "posted" | "no_post" | "failed" | "unknown";

/** A send that got no clear answer may have taken effect all the same. */
function mayHaveLanded(failure: DiscordFailure): boolean {
  return (
    failure.kind === "network" ||
    failure.kind === "invalid_response" ||
    (failure.kind === "api" && failure.status >= 500)
  );
}

function noticeFor(content: SafeText, task: TaskRow): MessageInput {
  return {
    content,
    mentionUserIds: [task.assignee_id],
    components: [markDoneRow(task.id)],
  };
}

export async function postNotice(
  ctx: FinishContext,
  event: EventRow,
  task: TaskRow,
  opening: SafeText,
): Promise<NoticeOutcome> {
  if (event.thread_id === null || event.thread_status !== "active") {
    return "no_post";
  }
  const content = safe`${opening}
${taskText(task.description)}
Due ${shownDate(task.due_date)}. Task ${shownId(task.id)}, given by ${userMention(ctx.actor.userId)}.`;
  try {
    await ctx.discord.sendMessage(
      { kind: "thread", guildId: event.guild_id, threadId: event.thread_id },
      channelMessage(noticeFor(content, task)),
    );
    return "posted";
  } catch (error) {
    console.error(
      `Task notice failed: ${error instanceof Error ? error.name : "unknown error"}`,
    );
    return error instanceof DiscordClientError && mayHaveLanded(error.failure)
      ? "unknown"
      : "failed";
  }
}

/**
 * What the officer is told, naming the person without pinging them. It says mentioned,
 * because the bot only knows that the post went out, not that anyone was notified.
 */
export function noticeSummary(
  outcome: NoticeOutcome,
  assigneeId: string,
): SafeText {
  const person = userMention(assigneeId);
  switch (outcome) {
    case "posted":
      return safe`${person} was mentioned in the event's post.`;
    case "no_post":
      return safe`This event has no post right now, so ${person} was not mentioned. Please tell them yourself.`;
    case "unknown":
      return safe`The task is saved, but Discord gave no clear answer, so ${person} may not have been mentioned. Please check the event's post.`;
    case "failed":
      return safe`The task is saved, but posting in the event's post failed, so ${person} was not mentioned. Please tell them yourself.`;
  }
}

/**
 * Whether the person can view the event's forum, from its roles and overwrites. Undefined
 * when Discord's data does not settle it. The server owner passes every check in Discord
 * and that is not visible here, so an owner shut out on paper gets a needless warning.
 */
async function canViewForum(
  ctx: FinishContext,
  event: EventRow,
  assigneeId: string,
): Promise<boolean | undefined> {
  const guildId = event.guild_id;
  const [roles, channels, memberRoleIds] = await Promise.all([
    ctx.discord.getGuildRoles(guildId),
    ctx.discord.getGuildChannels(guildId),
    ctx.discord.getGuildMemberRoleIds(guildId, assigneeId),
  ]);
  const channel = channels.find((row) => row.id === event.channel_id);
  if (channel === undefined) {
    return undefined;
  }
  const permissions = channelPermissions({
    guildId,
    roles,
    channel,
    memberRoleIds,
    memberId: assigneeId,
  });
  return permissions === undefined
    ? undefined
    : hasPermission(permissions, PermissionFlagsBits.ViewChannel);
}

/**
 * A warning for the officer when this task's reminders won't reach the person. The task
 * stays either way, and a check that can't finish stays silent: it is advice, and must
 * not turn a saved task into a failed reply.
 */
export async function reachWarning(
  ctx: FinishContext,
  event: EventRow,
  assigneeId: string,
): Promise<SafeText | undefined> {
  const person = userMention(assigneeId);
  try {
    const forum = await getManagedChannel(ctx.db, {
      guildId: event.guild_id,
      channelId: event.channel_id,
    });
    if (forum.ok && forum.value?.status !== "active") {
      return safe`This event's forum is no longer managed, so reminders for this task are off until an admin adds the forum back with /config.`;
    }
    if ((await canViewForum(ctx, event, assigneeId)) === false) {
      return safe`${person} can't view this event's forum, going by its permissions, so they can't open the post, its reminders or its Mark done button. They can still see the task in /mytasks. Give them access, or assign someone who has it.`;
    }
  } catch (error) {
    console.error(
      `Assignee access check failed: ${error instanceof Error ? error.name : "unknown error"}`,
    );
  }
  return undefined;
}
