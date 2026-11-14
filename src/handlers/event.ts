/**
 * /event: the commands that create, attach and look after an event's forum post.
 * What officers can read, and what happens to a post, are decided in docs/adr/0006.
 *
 * A guild and an actor only ever come from the signed payload, and an option is read
 * by name, so extra options change nothing. Everything that changes state claims the
 * interaction first, which is why a replayed create makes one row and one post.
 *
 * Creating an event is a row, then a post, then a write joining them, and Discord or
 * the database can fail between any two:
 *
 * - No post was made: the row stays `pending`. The same /event create tries again.
 * - Discord did not confirm the post: the post may exist. The row keeps its post
 *   attempt, so /event create never posts for it again, and the reply says to run
 *   /event link inside the post, or to make the post by hand and link that.
 * - Two runs at once: each takes the row's post attempt first, and the other is told
 *   the post may already exist. A clear refusal gives the attempt back.
 * - The post exists but could not be saved: the reply names the post, the log holds
 *   both IDs, and /event link inside it attaches it.
 *
 * A post can also be deleted after all this, which marks the row `missing` and stops its
 * reminders. The tasks are on that row and cannot be moved, so nothing here makes a
 * second event beside it: /event link in a replacement post, or the same /event create,
 * gives the row a post again and its tasks and reminders carry on. /event link matches on
 * the post's title and the date, or takes the event it is told to, whatever the title.
 *
 * An event picker offers choices from autocomplete, but any value can be submitted, so
 * a submitted value only ever names a row to load by ID and signed guild. A deleted
 * event, another guild's event and a value that is no ID all get the one refusal.
 */

import {
  ApplicationCommandOptionType,
  ChannelType,
} from "discord-api-types/v10";
import {
  DiscordClientError,
  DiscordErrorCode,
  mayHaveLanded,
} from "../discord/client.ts";
import type { ChannelSummary, DiscordFailure } from "../discord/client.ts";
import { commandOptionValue } from "../discord/interactions.ts";
import {
  actionRow,
  button,
  channelMessage,
  threadCreate,
} from "../discord/outbound.ts";
import type { AutocompleteChoice, MessageInput } from "../discord/outbound.ts";
import {
  channelMention,
  escapeUserText,
  plain,
  plainLabel,
  safe,
  textLength,
  userMention,
  DISCORD_LIMITS,
} from "../discord/safe-text.ts";
import type { SafeText } from "../discord/safe-text.ts";
import { FORUM_CHANNEL_TYPES, isThreadChannelType } from "../discord/verify.ts";
import { findEventByThread } from "../db/task-events.ts";
import type { DbError, DbResult } from "../db/errors.ts";
import { errorSummary } from "../db/errors.ts";
import {
  attachEventPost,
  claimEventPostAttempt,
  closeEvent,
  createEvent,
  createLinkedEvent,
  getEvent,
  listEvents,
  listEventsNamed,
  releaseEventPostAttempt,
  searchEvents,
  setEventOverviewMessage,
  setEventThread,
  softDeleteEvent,
} from "../db/events.ts";
import {
  getManagedChannel,
  listManagedChannels,
} from "../db/managed-channels.ts";
import { getEventWorkflow } from "../db/event-steps.ts";
import { MAX_EVENT_NAME_LENGTH } from "../db/validate.ts";
import { listEventTasks } from "../db/tasks.ts";
import { REFUSED_TEXT, versionFingerprint } from "../tasks/shared.ts";
import type { EventChoice, EventRow, ManagedChannel } from "../db/types.ts";
import {
  hasInviteOrMaskedLink,
  normaliseEventName,
  parseEventDate,
} from "../events/input.ts";
import type { EventName } from "../events/input.ts";
import {
  dateText,
  eventStatusText,
  eventTitle,
  fitLines,
  overviewWorkflow,
  refreshOverview,
  renderOverview,
  threadTarget,
} from "../events/overview.ts";
import {
  assignStartingOwners,
  assignSubcommand,
  pickupSubcommand,
  retryHandoffs,
  STARTING_OWNER_OPTIONS,
  startingOwners,
  unassignSubcommand,
  workflowRoutes,
  type StartingOwners,
} from "../events/workflow.ts";
import type { OverviewTasks } from "../events/overview.ts";
import type { DateOnly } from "../lib/dates.ts";
import { authorize } from "../lib/permissions.ts";
import type { EventScopedAction } from "../lib/permissions.ts";
import { lines } from "./render.ts";
import {
  autocompleteRoute,
  commandRoute,
  componentRoute,
  noRow,
  tierOnly,
  valueOf,
  type AutocompleteRoute,
  type FinishContext,
  type Handler,
} from "./router.ts";

const NO_TASKS = { rows: [], truncated: false };
// Enough to tell events apart at a glance. The full ID is what a picker submits.
const SHORT_ID_LENGTH = 8;

const NOT_READY = safe`This server hasn't been set up yet. An administrator can run /setup.`;
const BAD_NAME = safe`That name can't be used. Give it some letters or numbers, up to 100 characters.`;
const NO_FORUMS = safe`No forums are managed yet. An admin can add one with /config.`;
const PICK_FORUM = safe`More than one forum is managed, so choose one with the forum option.`;
const NOT_MANAGED = safe`That forum isn't managed by this bot, so nothing was created.`;
const PENDING_HELP = safe`The event is saved without a post. Run the same /event create again to try once more, or /event delete to drop it.`;
const REWORD_HELP = safe`The event is saved without a post. Use /event delete to drop it, then create it again under different wording.`;
const NOT_A_POST = safe`Run this inside a post in a forum this bot manages. Nothing was changed.`;
const NOT_CONFIRMED = safe`Discord could not confirm what this channel is, so nothing was changed. Please try again in a moment.`;
const ALREADY_LINKED = safe`This post already belongs to an event, so nothing was changed.`;
const NO_EVENT_HERE = safe`Run this in an event's post, or choose the event in the event option.`;
const BAD_POST_NAME = safe`This post's title has no letters or numbers to name an event with. Rename the post, then try again.`;
const LINK_IN_NAME = safe`An event's name can't hold a server invite or a masked link, because the bot shows it in pings and reminders. Choose a name without one. Nothing was created.`;
const LINK_IN_POST_NAME = safe`This post's title holds a server invite or a masked link, so it can't name an event. Rename the post, then try again. Nothing was changed.`;
const MANY_LOST = safe`More than one event with this name and date has lost its post, so nothing was changed. Run /event link inside a replacement post and choose one in the event option.`;
const NO_DATE = safe`Give the date for a new event, or choose an existing event in the event option. Nothing was changed.`;
const LOST_AND_CLOSED = safe`An event with this name and date exists, but it is closed and its post has gone, so nothing was changed.`;
const CHANGED_MEANWHILE = safe`That event changed just now, so nothing more was done. Check it with /event status, then try again if you still need to.`;
const TASKS_KEPT = safe`Its tasks are kept and its reminders start again.`;
const OVERVIEW_UNSAVED = safe`I couldn't record its overview, so the next change to this event may post a second one. A moderator can remove the older one.`;
const OVERVIEW_BEHIND = safe`I couldn't bring its overview up to date just now, so it will catch up with the next change to this event.`;

function message(content: SafeText): MessageInput {
  return { content, mentionUserIds: [], components: [] };
}

type PostTarget = Pick<EventRow, "name" | "channel_id">;

function inProgress(event: PostTarget): SafeText {
  return safe`A post for **${eventTitle(event)}** may already exist in ${channelMention(event.channel_id)}. Run /event link inside it and choose this event. If there is none, make the post yourself and run /event link there.`;
}

/** What to do when Discord may have made the post without saying so. */
function unconfirmedHelp(event: PostTarget): SafeText {
  const forum = channelMention(event.channel_id);
  return safe`If **${eventTitle(event)}** is in ${forum}, run /event link inside it and choose this event. If it isn't, make the post yourself in ${forum} and run /event link inside it.`;
}

function logFailure(what: string, detail: string): void {
  console.error(`Event ${what} failed: ${detail}`);
}

async function chooseForum({
  db,
  actor,
  payload,
}: FinishContext): Promise<{ forumId: string } | { problem: SafeText }> {
  const managed = valueOf(
    await listManagedChannels(db, { guildId: actor.guildId }),
  );
  const active = managed.rows.filter((row) => row.status === "active");
  const requested = commandOptionValue(
    payload,
    "forum",
    ApplicationCommandOptionType.Channel,
  );
  if (requested !== undefined) {
    const chosen = active.find((row) => row.channel_id === requested);
    return chosen === undefined
      ? { problem: NOT_MANAGED }
      : { forumId: chosen.channel_id };
  }
  const [only] = active;
  if (only === undefined) {
    return { problem: NO_FORUMS };
  }
  return active.length === 1
    ? { forumId: only.channel_id }
    : { problem: PICK_FORUM };
}

// Discord's codes for refusing a post, beyond those the client itself has to tell apart.
const NO_USABLE_TAGS = 40066;
const TOO_MANY_POSTS = 160006;
const TITLE_BLOCKED = 200001;
const LINK_BLOCKED = 240000;

/** Discord blames the words, so running the same command again would fail the same way. */
function wordingBlocked(failure: DiscordFailure): boolean {
  return (
    failure.kind === "api" &&
    (failure.code === DiscordErrorCode.AutoModBlocked ||
      failure.code === TITLE_BLOCKED ||
      failure.code === LINK_BLOCKED)
  );
}

function postProblem(failure: DiscordFailure): SafeText {
  switch (failure.kind) {
    case "unmanaged_target":
      return safe`That forum is no longer managed, so nothing was posted.`;
    case "not_forum":
      return safe`That channel isn't a forum, so nothing was posted.`;
    case "channel_unavailable":
      return failure.code === DiscordErrorCode.MissingPermissions
        ? safe`I'm not allowed to post in that forum. Check that I can send messages there.`
        : safe`I can't see that forum. Check that it still exists and that I can view it.`;
    case "rate_limited":
      return safe`Discord is limiting how fast I can post.`;
    case "api":
      if (failure.code === DiscordErrorCode.ForumTagRequired) {
        return safe`That forum requires a tag on every post, and I can't choose one. Turn the requirement off, or make the post yourself and run /event link inside it.`;
      }
      if (failure.code === NO_USABLE_TAGS) {
        return safe`That forum requires a tag on every post, and only moderators can set its tags. Turn the requirement off, or make the post yourself and run /event link inside it.`;
      }
      if (failure.code === TOO_MANY_POSTS) {
        return safe`This server has reached Discord's limit on active posts, so an old one has to be archived first.`;
      }
      if (wordingBlocked(failure)) {
        return safe`This server's AutoMod blocked the post, so try different wording.`;
      }
      return safe`Discord refused to create the post.`;
    default:
      return safe`Discord couldn't create the post just now.`;
  }
}

/**
 * Records which message is the overview, or logs what is needed to find it. The bot can't
 * search a post for its own overview, since reading history is not among its permissions.
 */
async function saveOverviewId(
  ctx: FinishContext,
  event: EventRow,
  messageId: string,
): Promise<DbResult<EventRow>> {
  const result = await setEventOverviewMessage(ctx.db, {
    guildId: event.guild_id,
    eventId: event.id,
    messageId,
  });
  if (!result.ok) {
    logFailure(
      "overview save",
      `event ${event.id}, message ${messageId}: ${errorSummary(result.error)}`,
    );
  }
  return result;
}

function created(event: EventRow, threadId: string, cleaned: boolean) {
  const note = cleaned
    ? safe` Its name was tidied to fit a post title.`
    : safe``;
  return message(
    safe`Created **${eventTitle(event)}** for ${dateText(event.event_date)} in ${channelMention(threadId)}.${note}`,
  );
}

/** Says a post was made but not saved, and keeps its ID in the log in case the reply is lost. */
function unsavedPost(
  event: EventRow,
  threadId: string,
  error: DbError,
): MessageInput {
  logFailure(
    "post save",
    `event ${event.id}, post ${threadId}: ${errorSummary(error)}`,
  );
  return message(
    safe`${channelMention(threadId)} was posted, but it could not be saved to the event. Run /event link ${dateText(event.event_date)} inside that post to attach it.`,
  );
}

/** Joins a post that exists to its event, or says plainly that it could not. */
async function attachPost(
  ctx: FinishContext,
  event: EventRow,
  post: { threadId: string; messageId: string; cleaned: boolean },
): Promise<MessageInput> {
  const saved = await attachEventPost(ctx.db, {
    guildId: event.guild_id,
    eventId: event.id,
    threadId: post.threadId,
    overviewMessageId: post.messageId,
  });
  if (!saved.ok && saved.error.category === "not_found") {
    // Another run may have attached this same post first, which is success.
    const current = await getEvent(ctx.db, {
      guildId: event.guild_id,
      eventId: event.id,
    });
    if (current.ok && current.value?.thread_id === post.threadId) {
      return created(current.value, post.threadId, post.cleaned);
    }
  }
  if (!saved.ok) {
    return unsavedPost(event, post.threadId, saved.error);
  }
  return created(saved.value, post.threadId, post.cleaned);
}

async function makePost(
  ctx: FinishContext,
  event: EventRow,
  name: EventName,
  cleaned: boolean,
): Promise<MessageInput> {
  const key = { guildId: event.guild_id, eventId: event.id };
  if (!valueOf(await claimEventPostAttempt(ctx.db, key))) {
    return message(inProgress(event));
  }
  const workflow = await overviewWorkflow(ctx.db, event);
  try {
    const post = await ctx.discord.createThread(
      { kind: "channel", guildId: event.guild_id, channelId: event.channel_id },
      threadCreate({
        name: name.title,
        ...renderOverview(event, NO_TASKS, [], workflow),
      }),
    );
    return await attachPost(ctx, event, {
      threadId: post.id,
      messageId: post.firstMessageId,
      cleaned,
    });
  } catch (error) {
    if (!(error instanceof DiscordClientError)) {
      throw error;
    }
    logFailure("post", error.failure.kind);
    if (!mayHaveLanded(error.failure)) {
      // No post exists, so a retry need not wait. If this fails, it just has to wait.
      await releaseEventPostAttempt(ctx.db, key);
      const help = wordingBlocked(error.failure) ? REWORD_HELP : PENDING_HELP;
      return message(safe`${postProblem(error.failure)} ${help}`);
    }
    // The attempt stays taken, so no later /event create can make a second post.
    return message(
      safe`Discord didn't confirm the post, so it may have been made. ${unconfirmedHelp(event)}`,
    );
  }
}

/** Takes up a row left pending. */
async function resume(
  ctx: FinishContext,
  event: EventRow,
  name: EventName,
  cleaned: boolean,
): Promise<MessageInput> {
  const reply = await makePost(ctx, event, name, cleaned);
  // Tasks may have been added while it was pending.
  await refreshOverview(ctx, event);
  return reply;
}

/** Makes the post that replaces a deleted one, drawn with the tasks the event still has. */
async function postReplacement(
  ctx: FinishContext,
  event: EventRow,
  name: EventName,
): Promise<{ threadId: string; messageId: string } | { problem: SafeText }> {
  const tasks = valueOf(
    await listEventTasks(ctx.db, {
      guildId: event.guild_id,
      eventId: event.id,
    }),
  );
  const workflow = await overviewWorkflow(ctx.db, event);
  try {
    const post = await ctx.discord.createThread(
      { kind: "channel", guildId: event.guild_id, channelId: event.channel_id },
      threadCreate({
        name: name.title,
        ...renderOverview(event, tasks, [], workflow),
      }),
    );
    return { threadId: post.id, messageId: post.firstMessageId };
  } catch (error) {
    if (!(error instanceof DiscordClientError)) {
      throw error;
    }
    logFailure("post", error.failure.kind);
    if (!mayHaveLanded(error.failure)) {
      return {
        problem: wordingBlocked(error.failure)
          ? safe`${postProblem(error.failure)} The event and its tasks are kept. Make a post yourself under different wording, then run /event link inside it and choose this event.`
          : safe`${postProblem(error.failure)} The event and its tasks are kept. Run the same /event create again when that is sorted out.`,
      };
    }
    return {
      problem: safe`Discord didn't confirm the post, so it may have been made. The event and its tasks are kept. ${unconfirmedHelp(event)}`,
    };
  }
}

/**
 * Gives an event whose post was deleted a new one, keeping the row and so its tasks. Unlike a
 * pending row there is no post attempt to take, so two of these at once can each make a
 * post. Only one is joined to the event, and the other is named so that it can be removed.
 */
async function replacePost(
  ctx: FinishContext,
  event: EventRow,
  name: EventName,
): Promise<MessageInput> {
  const post = await postReplacement(ctx, event, name);
  if ("problem" in post) {
    return message(post.problem);
  }
  const key = { guildId: event.guild_id, eventId: event.id };
  const { threadId, messageId } = post;
  const saved = await setEventThread(ctx.db, { ...key, threadId });
  if (!saved.ok) {
    const current = await getEvent(ctx.db, key);
    const holder = current.ok ? current.value?.thread_id : undefined;
    if (
      current.ok &&
      current.value?.thread_status === "active" &&
      typeof holder === "string" &&
      holder !== threadId
    ) {
      return message(
        safe`Another request gave this event a post in ${channelMention(holder)} at the same moment. ${channelMention(threadId)} is spare, and a moderator can remove it.`,
      );
    }
    return unsavedPost(event, threadId, saved.error);
  }
  const told = safe`**${eventTitle(event)}** for ${dateText(event.event_date)} had lost its post, and now lives in ${channelMention(threadId)}. ${TASKS_KEPT}`;
  const overview = await saveOverviewId(ctx, saved.value, messageId);
  if (!overview.ok) {
    return message(safe`${told} ${OVERVIEW_UNSAVED}`);
  }
  return message(
    (await refreshOverview(ctx, overview.value))
      ? told
      : safe`${told} ${OVERVIEW_BEHIND}`,
  );
}

async function finishCreate(ctx: FinishContext): Promise<MessageInput> {
  const { actor, config, db, payload } = ctx;
  if (config === null) {
    return message(NOT_READY);
  }
  const rawName = commandOptionValue(
    payload,
    "name",
    ApplicationCommandOptionType.String,
  );
  if (hasInviteOrMaskedLink(rawName)) {
    return message(LINK_IN_NAME);
  }
  const name = normaliseEventName(rawName);
  if (name === undefined) {
    return message(BAD_NAME);
  }
  const date = parseEventDate(
    commandOptionValue(payload, "date", ApplicationCommandOptionType.String),
    config.timezone,
  );
  if (!date.ok) {
    return message(date.problem);
  }
  const picked = startingOwners(payload);
  if ("problem" in picked) {
    return message(picked.problem);
  }
  const { owners } = picked;
  const forum = await chooseForum(ctx);
  if ("problem" in forum) {
    return message(forum.problem);
  }
  const identity = {
    guildId: actor.guildId,
    channelId: forum.forumId,
    name: name.name,
    eventDate: date.date,
  };
  const named = valueOf(await listEventsNamed(db, identity));
  const cleaned = rawName !== name.name;
  const pending = named.find((row) => row.thread_status === "pending");
  if (pending !== undefined) {
    return withOwners(ctx, pending, owners, () =>
      resume(ctx, pending, name, cleaned),
    );
  }
  const withPost = named.filter((row) => row.thread_status === "active");
  const existing =
    withPost.find((row) => row.status === "active") ?? withPost[0];
  if (existing?.thread_id !== undefined && existing.thread_id !== null) {
    const where = channelMention(existing.thread_id);
    return message(
      existing.status === "closed"
        ? safe`That event already exists in ${where} and is closed, so nothing was created.`
        : safe`That event already exists in ${where}, so nothing was created.`,
    );
  }
  const lost = named.filter((row) => row.thread_status === "missing");
  const reusable = lost.filter((row) => row.status === "active");
  const [only] = reusable;
  if (reusable.length > 1) {
    return message(MANY_LOST);
  }
  if (only !== undefined) {
    return withOwners(ctx, only, owners, () => replacePost(ctx, only, name));
  }
  if (lost.length > 0) {
    return message(LOST_AND_CLOSED);
  }
  const inserted = await createEvent(db, {
    ...identity,
    actorId: actor.userId,
  });
  if (!inserted.ok && inserted.error.category === "parent_unavailable") {
    return message(NOT_MANAGED);
  }
  // An earlier try of this create committed after the bot gave up on it.
  if (!inserted.ok && inserted.error.category === "conflict") {
    return message(
      inProgress({ name: identity.name, channel_id: identity.channelId }),
    );
  }
  const event = valueOf(inserted);
  return withOwners(ctx, event, owners, () =>
    makePost(ctx, event, name, cleaned),
  );
}

/**
 * Puts the people picked on /event create on their steps before the post is drawn, and
 * adds what happened to the reply.
 */
async function withOwners(
  ctx: FinishContext,
  event: EventRow,
  owners: StartingOwners,
  next: () => Promise<MessageInput>,
): Promise<MessageInput> {
  const notes = await assignStartingOwners(ctx, event, owners);
  const reply = await next();
  return notes.length === 0
    ? reply
    : { ...reply, content: lines([reply.content, ...notes]) ?? reply.content };
}

/** What Discord says the channel is, or why that could not be learned. */
async function readChannel(
  { discord }: FinishContext,
  channelId: string,
): Promise<ChannelSummary | "unavailable" | "unknown"> {
  try {
    return await discord.describeChannel(channelId);
  } catch (error) {
    if (!(error instanceof DiscordClientError)) {
      throw error;
    }
    logFailure("link", error.failure.kind);
    return error.failure.kind === "channel_unavailable" ||
      error.failure.kind === "invalid_target"
      ? "unavailable"
      : "unknown";
  }
}

async function linkableThread(
  ctx: FinishContext,
): Promise<
  { thread: ChannelSummary; parentId: string } | { problem: SafeText }
> {
  const { actor, db, verified } = ctx;
  const thread = await readChannel(ctx, verified.channelId);
  if (thread === "unavailable") {
    return { problem: NOT_A_POST };
  }
  if (thread === "unknown") {
    return { problem: NOT_CONFIRMED };
  }
  const { parentId } = thread;
  if (
    thread.guildId !== actor.guildId ||
    !isThreadChannelType(thread.type) ||
    parentId === undefined
  ) {
    return { problem: NOT_A_POST };
  }
  const managed = valueOf(
    await getManagedChannel(db, {
      guildId: actor.guildId,
      channelId: parentId,
    }),
  );
  if (managed?.status !== "active") {
    return { problem: NOT_A_POST };
  }
  const parent = await readChannel(ctx, parentId);
  if (parent === "unknown") {
    return { problem: NOT_CONFIRMED };
  }
  return parent !== "unavailable" &&
    parent.guildId === actor.guildId &&
    FORUM_CHANNEL_TYPES.has(parent.type)
    ? { thread, parentId }
    : { problem: NOT_A_POST };
}

interface NewLink {
  readonly threadId: string;
  readonly parentId: string;
  readonly name: string;
  readonly date: DateOnly;
}

/**
 * Attaches the post to a row left pending for this name, or to one whose post was
 * deleted, so its tasks come along. Only if there is neither does it make a new row.
 */
async function linkRow(
  { actor, db }: FinishContext,
  { threadId, parentId, name, date }: NewLink,
): Promise<
  | { row: DbResult<EventRow>; adopted: boolean; recovered: boolean }
  | { duplicateOf: string }
  | { problem: SafeText }
> {
  const identity = {
    guildId: actor.guildId,
    channelId: parentId,
    name,
    eventDate: date,
  };
  const named = valueOf(await listEventsNamed(db, identity));
  const pending = named.find((row) => row.thread_status === "pending");
  const live = named.find((row) => row.thread_status === "active");
  if (pending === undefined && typeof live?.thread_id === "string") {
    return { duplicateOf: live.thread_id };
  }
  const lost = named.filter((row) => row.thread_status === "missing");
  const reusable = lost.filter((row) => row.status === "active");
  if (pending === undefined && reusable.length > 1) {
    return { problem: MANY_LOST };
  }
  const adoptable = pending ?? reusable[0];
  if (adoptable === undefined && lost.length > 0) {
    return { problem: LOST_AND_CLOSED };
  }
  return adoptable === undefined
    ? {
        adopted: false,
        recovered: false,
        row: await createLinkedEvent(db, {
          ...identity,
          actorId: actor.userId,
          threadId,
        }),
      }
    : {
        adopted: true,
        recovered: adoptable.thread_status === "missing",
        row: await setEventThread(db, {
          guildId: actor.guildId,
          eventId: adoptable.id,
          threadId,
        }),
      };
}

function linkedText(event: EventRow, recovered: boolean): SafeText {
  const linked = safe`Linked this post to **${eventTitle(event)}** for ${dateText(event.event_date)}.`;
  return recovered ? safe`${linked} ${TASKS_KEPT}` : linked;
}

/**
 * A new overview for a post that has none of the bot's. An adopted event may already have
 * tasks, so once the overview's ID is saved it is redrawn with them.
 */
async function postOverview(
  ctx: FinishContext,
  event: EventRow,
  threadId: string,
  { adopted, recovered }: { adopted: boolean; recovered: boolean },
): Promise<MessageInput> {
  const linked = linkedText(event, recovered);
  const workflow = await overviewWorkflow(ctx.db, event);
  try {
    const sent = await ctx.discord.sendMessage(
      threadTarget(event.guild_id, threadId),
      channelMessage(renderOverview(event, NO_TASKS, [], workflow)),
    );
    const saved = await saveOverviewId(ctx, event, sent.id);
    if (!saved.ok) {
      return message(safe`${linked} ${OVERVIEW_UNSAVED}`);
    }
    return adopted && !(await refreshOverview(ctx, saved.value))
      ? message(safe`${linked} ${OVERVIEW_BEHIND}`)
      : message(linked);
  } catch (error) {
    if (!(error instanceof DiscordClientError)) {
      throw error;
    }
    logFailure("overview", error.failure.kind);
    return message(
      safe`${linked} I couldn't post its overview just now, so it will appear with the next change to this event.`,
    );
  }
}

/**
 * The row's own post turned out to exist after all, since the command ran inside it. Its
 * overview is still there, so it is only redrawn, and a second one is never posted.
 */
async function relinkOwnPost(
  ctx: FinishContext,
  event: EventRow,
  threadId: string,
): Promise<MessageInput> {
  const row = await setEventThread(ctx.db, {
    guildId: event.guild_id,
    eventId: event.id,
    threadId,
  });
  if (!row.ok && row.error.category === "not_found") {
    return message(CHANGED_MEANWHILE);
  }
  const relinked = valueOf(row);
  const linked = linkedText(relinked, true);
  const current = await refreshOverview(ctx, relinked);
  await retryHandoffs(ctx, relinked);
  return current
    ? message(linked)
    : message(safe`${linked} ${OVERVIEW_BEHIND}`);
}

/**
 * /event link with the event named, for a replacement post with another title. The value
 * is only a row reference, and nothing about the row comes from the post.
 */
async function linkChosen(
  ctx: FinishContext,
  eventId: string,
): Promise<MessageInput> {
  const { actor, db } = ctx;
  const read = await getEvent(db, { guildId: actor.guildId, eventId });
  if (!read.ok && read.error.category === "invalid_input") {
    return message(REFUSED_TEXT);
  }
  const event = valueOf(read);
  if (event === null) {
    return message(REFUSED_TEXT);
  }
  if (event.status === "closed") {
    return message(
      safe`**${eventTitle(event)}** is closed, so it can't take a new post. Nothing was changed.`,
    );
  }
  if (event.thread_status === "active" && event.thread_id !== null) {
    return message(
      safe`**${eventTitle(event)}** already has its post in ${channelMention(event.thread_id)}, so nothing was changed.`,
    );
  }
  const target = await linkableThread(ctx);
  if ("problem" in target) {
    return message(target.problem);
  }
  const { thread, parentId } = target;
  // Reminders and the forum checks go by the event's forum, which a link never changes.
  if (parentId !== event.channel_id) {
    return message(
      safe`**${eventTitle(event)}** belongs to ${channelMention(event.channel_id)}, so its post has to be there. Nothing was changed.`,
    );
  }
  const held = valueOf(
    await findEventByThread(db, {
      guildId: actor.guildId,
      threadId: thread.id,
    }),
  );
  if (held?.id === event.id) {
    return relinkOwnPost(ctx, event, thread.id);
  }
  if (held !== null) {
    return message(ALREADY_LINKED);
  }
  const row = await setEventThread(db, {
    guildId: actor.guildId,
    eventId: event.id,
    threadId: thread.id,
  });
  if (!row.ok && row.error.category === "conflict") {
    return message(ALREADY_LINKED);
  }
  if (!row.ok && row.error.category === "not_found") {
    return message(CHANGED_MEANWHILE);
  }
  return settleOverview(ctx, valueOf(row), thread, {
    adopted: true,
    recovered: event.thread_status === "missing",
  });
}

/**
 * The post is now the event's. What is left is an overview for it, and any hand-off a
 * done step is still owed because it had no post to go to.
 */
async function settleOverview(
  ctx: FinishContext,
  event: EventRow,
  thread: ChannelSummary,
  how: { adopted: boolean; recovered: boolean },
): Promise<MessageInput> {
  const reply = await settleOverviewOnly(ctx, event, thread, how);
  await retryHandoffs(ctx, event);
  return reply;
}

async function settleOverviewOnly(
  ctx: FinishContext,
  event: EventRow,
  thread: ChannelSummary,
  how: { adopted: boolean; recovered: boolean },
): Promise<MessageInput> {
  // A post of the bot's own already opens with this event's overview.
  if (how.adopted && thread.ownerId === ctx.payload.application_id) {
    const linked = linkedText(event, how.recovered);
    const saved = await saveOverviewId(ctx, event, thread.id);
    if (!saved.ok) {
      return message(safe`${linked} ${OVERVIEW_UNSAVED}`);
    }
    return (await refreshOverview(ctx, saved.value))
      ? message(linked)
      : message(safe`${linked} ${OVERVIEW_BEHIND}`);
  }
  return postOverview(ctx, event, thread.id, how);
}

async function finishLink(ctx: FinishContext): Promise<MessageInput> {
  const { actor, config, db, payload } = ctx;
  if (config === null) {
    return message(NOT_READY);
  }
  const chosen = commandOptionValue(
    payload,
    "event",
    ApplicationCommandOptionType.String,
  );
  if (typeof chosen === "string") {
    return linkChosen(ctx, chosen);
  }
  const rawDate = commandOptionValue(
    payload,
    "date",
    ApplicationCommandOptionType.String,
  );
  if (rawDate === undefined) {
    return message(NO_DATE);
  }
  const date = parseEventDate(rawDate, config.timezone);
  if (!date.ok) {
    return message(date.problem);
  }
  const target = await linkableThread(ctx);
  if ("problem" in target) {
    return message(target.problem);
  }
  const { thread, parentId } = target;
  const held = valueOf(
    await findEventByThread(db, {
      guildId: actor.guildId,
      threadId: thread.id,
    }),
  );
  if (held?.thread_status === "missing" && held.status === "active") {
    return relinkOwnPost(ctx, held, thread.id);
  }
  if (held !== null) {
    return message(ALREADY_LINKED);
  }
  if (hasInviteOrMaskedLink(thread.name)) {
    return message(LINK_IN_POST_NAME);
  }
  const name = normaliseEventName(thread.name);
  if (name === undefined) {
    return message(BAD_POST_NAME);
  }
  const linked = await linkRow(ctx, {
    threadId: thread.id,
    parentId,
    name: name.name,
    date: date.date,
  });
  if ("duplicateOf" in linked) {
    return message(
      safe`An event with this post's title and that date already exists in ${channelMention(linked.duplicateOf)}, so nothing was changed.`,
    );
  }
  if ("problem" in linked) {
    return message(linked.problem);
  }
  const { row, adopted, recovered } = linked;
  if (!row.ok) {
    if (row.error.category === "conflict") {
      return message(ALREADY_LINKED);
    }
    if (row.error.category === "parent_unavailable") {
      return message(NOT_A_POST);
    }
    if (adopted && row.error.category === "not_found") {
      return message(CHANGED_MEANWHILE);
    }
  }
  return settleOverview(ctx, valueOf(row), thread, { adopted, recovered });
}

type ChosenEvent =
  | { readonly kind: "event"; readonly event: EventRow }
  | { readonly kind: "none" }
  | { readonly kind: "refused" };

/**
 * The event a command is about: the one it names, or else the post it was run in. A
 * named value is never trusted. It is a row reference, loaded with the signed guild.
 * Having named nothing, somewhere that is no event's post, is only a wrong place to ask.
 */
async function loadChosenEvent(
  ctx: FinishContext,
  action: EventScopedAction,
): Promise<ChosenEvent> {
  const { actor, db, payload, verified } = ctx;
  const named = commandOptionValue(
    payload,
    "event",
    ApplicationCommandOptionType.String,
  );
  if (typeof named !== "string" && !isThreadChannelType(verified.channelType)) {
    return { kind: "none" };
  }
  const read =
    typeof named === "string"
      ? await getEvent(db, { guildId: actor.guildId, eventId: named })
      : await findEventByThread(db, {
          guildId: actor.guildId,
          threadId: verified.channelId,
        });
  if (!read.ok && read.error.category === "invalid_input") {
    return { kind: "refused" };
  }
  const event = valueOf(read);
  if (event === null) {
    return typeof named === "string" ? { kind: "refused" } : { kind: "none" };
  }
  return authorize<EventScopedAction>(action, actor, ctx.config, event).allowed
    ? { kind: "event", event }
    : { kind: "refused" };
}

/**
 * The gate only checks the tier, so that one read comes before the acknowledgement. The
 * row is loaded and authorized here, on the longer deadline, with the same refusal.
 */
function onChosenEvent(
  action: EventScopedAction,
  step: (ctx: FinishContext, event: EventRow) => Promise<MessageInput>,
): (ctx: FinishContext) => Promise<MessageInput> {
  return async (ctx) => {
    const chosen = await loadChosenEvent(ctx, action);
    switch (chosen.kind) {
      case "refused":
        return message(REFUSED_TEXT);
      case "none":
        return message(NO_EVENT_HERE);
      case "event":
        return step(ctx, chosen.event);
    }
  };
}

function shortId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH);
}

/** Names can look alike, so each choice also shows what tells two events apart. */
function eventChoice(event: EventChoice): AutocompleteChoice {
  const closed = event.status === "closed" ? " - closed" : "";
  const suffix = ` - ${event.event_date} - ${shortId(event.id)}${closed}`;
  const room = DISCORD_LIMITS.autocompleteChoiceName - textLength(suffix);
  let name = "";
  // By code point, so a character is never cut in half.
  for (const character of event.name) {
    if (textLength(name + character) > room) {
      break;
    }
    name += character;
  }
  return { name: plainLabel(name + suffix), value: event.id };
}

/** Reads at most 25 of this guild's live events. No writes, no Discord. */
const eventChoices: AutocompleteRoute["choices"] = async (
  { db },
  { guildId },
  typed,
) => {
  const found = await searchEvents(db, { guildId, term: typed });
  return found.ok ? found.value.map(eventChoice) : [];
};

function postLine(event: EventRow): SafeText {
  if (event.thread_id === null) {
    return safe`Post: none yet. Run the same /event create again, or /event delete.`;
  }
  const post = channelMention(event.thread_id);
  if (event.thread_status !== "missing") {
    return safe`Post: ${post}`;
  }
  return event.status === "closed"
    ? safe`Post: ${post} can no longer be found.`
    : safe`Post: ${post} can no longer be found, so reminders are off. To bring them back, run the same /event create again for a new post, or run /event link inside a replacement post and choose this event. The tasks are kept.`;
}

const FORUM_NOTE = safe`This event's forum is no longer managed, so nothing is posted there.`;

async function finishStatus(
  { actor, db }: FinishContext,
  event: EventRow,
): Promise<MessageInput> {
  const key = { guildId: actor.guildId, eventId: event.id };
  const tasks = valueOf(await listEventTasks(db, key));
  const forum = valueOf(
    await getManagedChannel(db, {
      guildId: actor.guildId,
      channelId: event.channel_id,
    }),
  );
  const notes = [
    safe`ID: ${escapeUserText(shortId(event.id))}`,
    postLine(event),
    ...(forum?.status === "active" ? [] : [FORUM_NOTE]),
  ];
  const workflow = valueOf(await getEventWorkflow(db, key)) ?? undefined;
  return { ...renderOverview(event, tasks, notes, workflow), components: [] };
}

function listLine(
  event: EventRow,
  forums: ReadonlyMap<string, ManagedChannel["status"]>,
): SafeText {
  const where =
    event.thread_id === null
      ? safe`no post yet`
      : event.thread_status === "missing"
        ? event.status === "closed"
          ? safe`post missing`
          : safe`post missing and reminders off, see /event status`
        : channelMention(event.thread_id);
  const forum =
    forums.get(event.channel_id) === "active"
      ? safe``
      : safe` (forum no longer managed)`;
  return safe`**${eventTitle(event)}** ${dateText(event.event_date)}, ${eventStatusText(event)}, ${where}, ID ${escapeUserText(shortId(event.id))}${forum}`;
}

async function finishList({ actor, db }: FinishContext): Promise<MessageInput> {
  const { guildId } = actor;
  const events = valueOf(await listEvents(db, { guildId }));
  if (events.rows.length === 0) {
    return message(safe`There are no events yet.`);
  }
  const managed = valueOf(await listManagedChannels(db, { guildId }));
  const forums = new Map(
    managed.rows.map((row) => [row.channel_id, row.status]),
  );
  // The list comes with active events first, so what a limit hides is the closed ones.
  const content = fitLines(
    [safe`**Events**`],
    events.rows.map((row) => listLine(row, forums)),
    (count) => {
      if (count === 0 && !events.truncated) {
        return undefined;
      }
      return events.truncated
        ? safe`…and more than ${escapeUserText(String(count))} others not shown.`
        : safe`…and ${escapeUserText(String(count))} more not shown.`;
    },
  );
  return message(content);
}

/** The one line a post gets about a change. Failing it must not fail the change. */
async function noteInPost(
  { discord }: FinishContext,
  event: EventRow,
  content: SafeText,
): Promise<boolean> {
  if (event.thread_id === null || event.thread_status !== "active") {
    return false;
  }
  try {
    await discord.sendMessage(
      threadTarget(event.guild_id, event.thread_id),
      channelMessage({ content, mentionUserIds: [] }),
    );
    return true;
  } catch (error) {
    if (!(error instanceof DiscordClientError)) {
      throw error;
    }
    logFailure("note", error.failure.kind);
    return false;
  }
}

const POST_NOT_TOLD = safe` I couldn't add a line to its post.`;
const NO_REOPEN = safe` There is no command to reopen it, so if this was a mistake, ask the bot's maintainer, who can reopen it by hand.`;
const OVERVIEW_NOT_CLOSED = safe` I couldn't update its overview, so it may still say Active. Run /event close again to try once more.`;

/** Whether the bot can post there at all. A failed read counts as yes, to say more. */
async function postReachable(
  ctx: FinishContext,
  event: EventRow,
): Promise<boolean> {
  if (event.thread_status !== "active") {
    return false;
  }
  const forum = await getManagedChannel(ctx.db, {
    guildId: event.guild_id,
    channelId: event.channel_id,
  });
  return !forum.ok || forum.value?.status === "active";
}

/**
 * A second /event close changes nothing in the database, so it is also how an overview
 * left behind by the first gets put right: closed events take no other changes that would
 * redraw it. The one line is not sent again, as it may well have been sent the first time.
 */
async function repairClosed(
  ctx: FinishContext,
  event: EventRow,
): Promise<MessageInput> {
  const current = valueOf(
    await getEvent(ctx.db, { guildId: ctx.actor.guildId, eventId: event.id }),
  );
  if (current === null) {
    return message(safe`This event no longer exists.`);
  }
  if (!(await postReachable(ctx, current))) {
    return message(safe`This event is already closed.`);
  }
  return message(
    (await refreshOverview(ctx, current))
      ? safe`This event is already closed, and its overview now shows that.`
      : safe`This event is already closed.${OVERVIEW_NOT_CLOSED}`,
  );
}

async function finishClose(
  ctx: FinishContext,
  event: EventRow,
): Promise<MessageInput> {
  if (event.thread_status === "pending") {
    return message(
      safe`This event has no post yet, so there is nothing to close. Run the same /event create again, or /event delete.`,
    );
  }
  const closed = await closeEvent(ctx.db, {
    guildId: ctx.actor.guildId,
    eventId: event.id,
  });
  if (!closed.ok && closed.error.category === "not_found") {
    return repairClosed(ctx, event);
  }
  const row = valueOf(closed);
  const told = await noteInPost(
    ctx,
    row,
    safe`This event was closed by ${userMention(ctx.actor.userId)}. Its reminders have stopped.`,
  );
  const drawn = await refreshOverview(ctx, row);
  // With no post to reach, the missing line says it all, and a retry would not help.
  const stale = !drawn && (await postReachable(ctx, row));
  return message(
    safe`Closed **${eventTitle(row)}**. Its reminders have stopped.${told ? safe`` : POST_NOT_TOLD}${stale ? OVERVIEW_NOT_CLOSED : safe``}${NO_REOPEN}`,
  );
}

const DELETE_CHANGED = safe`This event or its tasks changed after this was shown, so it wasn't deleted. Check it and run /event delete again.`;

/**
 * Names what a Confirm was shown. Adding a task does not touch the event's row, so the
 * tasks count as well as the fields of the event that the prompt describes.
 */
export function deleteVersion(event: EventRow, tasks: OverviewTasks): string {
  return versionFingerprint(
    JSON.stringify([
      event.name,
      event.event_date,
      event.status,
      tasks.truncated,
      tasks.rows.map((task) => [task.id, task.updated_at]),
    ]),
  );
}

const confirmDelete = componentRoute({
  prefix: "event.delete.confirm",
  fields: ["uuid", "fingerprint"],
  // Authorized again from this click's own payload, and the row loaded again.
  gate: tierOnly("event.delete"),
  changesState: true,
  finish: async (ctx, _resource, [eventId, shown]) => {
    const event = valueOf(
      await getEvent(ctx.db, { guildId: ctx.actor.guildId, eventId }),
    );
    if (
      !authorize<EventScopedAction>(
        "event.delete",
        ctx.actor,
        ctx.config,
        event,
      ).allowed ||
      event === null
    ) {
      return message(REFUSED_TEXT);
    }
    const tasks = valueOf(
      await listEventTasks(ctx.db, {
        guildId: ctx.actor.guildId,
        eventId: event.id,
      }),
    );
    if (deleteVersion(event, tasks) !== shown) {
      return message(DELETE_CHANGED);
    }
    const deleted = await softDeleteEvent(ctx.db, {
      guildId: ctx.actor.guildId,
      eventId: event.id,
    });
    if (!deleted.ok && deleted.error.category === "not_found") {
      return message(safe`This event no longer exists.`);
    }
    valueOf(deleted);
    const hadPost = event.thread_status === "active";
    const told = await noteInPost(
      ctx,
      event,
      safe`This event was deleted by ${userMention(ctx.actor.userId)}. This post stays here, but the bot no longer tracks it.`,
    );
    return message(
      safe`Deleted **${eventTitle(event)}** and its tasks. Its reminders have stopped.${hadPost && !told ? POST_NOT_TOLD : safe``}`,
    );
  },
});

const DATE_INPUT_LIMIT = 32;
const SUBCOMMAND = ApplicationCommandOptionType.Subcommand;
const STRING = ApplicationCommandOptionType.String;

const EVENT_OPTION = {
  type: STRING,
  name: "event",
  description: "Which event. Leave empty inside the event's post",
  autocomplete: true,
};

const DATE_OPTION = {
  type: STRING,
  name: "date",
  description: "The date, as YYYY-MM-DD or MM/DD",
  required: true,
  max_length: DATE_INPUT_LIMIT,
};

export const handler: Handler = {
  commands: [
    {
      name: "event",
      description: "Create and look after events and their forum posts",
      options: [
        {
          type: SUBCOMMAND,
          name: "create",
          description: "Create an event and its forum post",
          options: [
            {
              type: STRING,
              name: "name",
              description: "The event's name, which also titles its post",
              required: true,
              max_length: MAX_EVENT_NAME_LENGTH,
            },
            DATE_OPTION,
            {
              type: ApplicationCommandOptionType.Channel,
              name: "forum",
              description: "Where to post, if more than one forum is managed",
              channel_types: [ChannelType.GuildForum],
            },
            ...STARTING_OWNER_OPTIONS,
          ],
        },
        {
          type: SUBCOMMAND,
          name: "link",
          description: "Make the post you are in the home of an event",
          options: [
            {
              ...DATE_OPTION,
              description: "A new event's date. Leave empty if you choose one",
              required: false,
            },
            {
              ...EVENT_OPTION,
              description: "An event that lost its post, if any",
            },
          ],
        },
        {
          type: SUBCOMMAND,
          name: "status",
          description: "Show an event and its tasks, privately",
          options: [EVENT_OPTION],
        },
        {
          type: SUBCOMMAND,
          name: "list",
          description: "List the events in every managed forum, privately",
        },
        {
          type: SUBCOMMAND,
          name: "close",
          description: "Close an event and stop its reminders",
          options: [EVENT_OPTION],
        },
        {
          type: SUBCOMMAND,
          name: "delete",
          description: "Delete an event and its tasks, after you confirm",
          options: [EVENT_OPTION],
        },
        assignSubcommand,
        unassignSubcommand,
        pickupSubcommand,
      ],
    },
  ],
  routes: [
    commandRoute({
      path: "event create",
      gate: noRow("event.create"),
      changesState: true,
      finish: finishCreate,
    }),
    commandRoute({
      path: "event link",
      gate: noRow("event.link"),
      changesState: true,
      finish: finishLink,
    }),
    commandRoute({
      path: "event status",
      gate: tierOnly("event.status"),
      changesState: false,
      finish: onChosenEvent("event.status", finishStatus),
    }),
    commandRoute({
      path: "event list",
      gate: noRow("event.list"),
      changesState: false,
      finish: finishList,
    }),
    commandRoute({
      path: "event close",
      gate: tierOnly("event.close"),
      changesState: true,
      finish: onChosenEvent("event.close", finishClose),
    }),
    commandRoute({
      path: "event delete",
      gate: tierOnly("event.delete"),
      // Deferred, though it is quick: an immediate reply would hand the event's name to
      // anyone replaying the request, in the HTTP response.
      changesState: false,
      finish: onChosenEvent("event.delete", async (ctx, event) => {
        const tasks = valueOf(
          await listEventTasks(ctx.db, {
            guildId: ctx.actor.guildId,
            eventId: event.id,
          }),
        );
        const count = escapeUserText(String(tasks.rows.length));
        return {
          content: safe`Delete **${eventTitle(event)}** for ${dateText(event.event_date)}, with all its tasks (${count}${tasks.truncated ? safe` or more` : safe``})? Its post stays in the forum, with one line saying it was deleted.`,
          mentionUserIds: [],
          components: [
            actionRow(
              button({
                customId: confirmDelete.id(
                  event.id,
                  deleteVersion(event, tasks),
                ),
                label: plain`Delete event`,
                style: "danger",
              }),
            ),
          ],
        };
      }),
    }),
    confirmDelete,
    autocompleteRoute({
      path: "event link",
      action: "event.link",
      choices: eventChoices,
    }),
    autocompleteRoute({
      path: "event status",
      action: "event.status",
      choices: eventChoices,
    }),
    autocompleteRoute({
      path: "event close",
      action: "event.close",
      choices: eventChoices,
    }),
    autocompleteRoute({
      path: "event delete",
      action: "event.delete",
      choices: eventChoices,
    }),
    ...workflowRoutes,
    autocompleteRoute({
      path: "event assign",
      action: "event.assign",
      choices: eventChoices,
    }),
    autocompleteRoute({
      path: "event unassign",
      action: "event.unassign",
      choices: eventChoices,
    }),
    autocompleteRoute({
      path: "event pickup",
      action: "event.pickup",
      choices: eventChoices,
    }),
  ],
};
