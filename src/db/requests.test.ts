/**
 * The exact requests sent to PostgREST, for ordinary and hostile inputs. Anything
 * sent here is what the database layer will parse, so a filter or column that changes
 * shape shows up as a failure.
 */

import { describe, expect, it } from "vitest";
import {
  HOSTILE_STRINGS,
  mockPostgrest,
  testSnowflake,
  type MockResponse,
} from "../../test/support/mock-postgrest.ts";
import type { DateOnly } from "../lib/dates.ts";
import { countOpenTasksInChannel } from "./tasks.ts";
import {
  closeEvent,
  createEvent,
  getEvent,
  listEvents,
  attachEventPost,
  claimEventPostAttempt,
  createLinkedEvent,
  listEventsNamed,
  markEventThreadMissing,
  releaseEventPostAttempt,
  searchEvents,
  setEventOverviewMessage,
  setEventThread,
  softDeleteEvent,
} from "./events.ts";
import {
  applyConfigChange,
  applyRoleBindings,
  getGuildConfig,
  listRecentConfigChanges,
} from "./guild-config.ts";
import { claimInteraction } from "./interaction-claims.ts";
import {
  finishJobRun,
  getLatestJobRun,
  beginJobRun,
  type JobName,
} from "./job-runs.ts";
import {
  getManagedChannel,
  listManagedChannels,
  listManagedChannelsByIds,
  listRecentEventsInChannel,
  markChannelUnavailable,
} from "./managed-channels.ts";
import {
  claimReminder,
  listReminderCandidates,
  listStaleClaims,
  markReminderSent,
  markReminderSkipped,
  recordReminderRefused,
  recordThreadRefusal,
  clearThreadRefusals,
  reclaimReminder,
} from "./reminders.ts";
import {
  findEventByThread,
  findEventEverOnThread,
  searchOpenEvents,
  searchOpenEventsByIdPrefix,
} from "./task-events.ts";
import {
  createTask,
  editTask,
  recordReassignment,
  searchOpenTasksByIdPrefix,
  searchOwnOpenTasksByIdPrefix,
  softDeleteTaskIfUnchanged,
  getTask,
  listEventTasks,
  listOpenTasksForAssignee,
  markOwnTaskDone,
  markTaskDoneAsOfficer,
  reassignTask,
  searchLiveTasks,
  searchLiveTasksByIdPrefix,
  searchOpenTasks,
  searchOwnOpenTasks,
  setTaskDescription,
  setTaskDueDate,
  softDeleteTask,
} from "./tasks.ts";

const GUILD = testSnowflake();
const ACTOR = testSnowflake();
const OTHER = testSnowflake();
const ID = "11111111-2222-4333-8444-555555555555";
const TOKEN = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const DATE = "2030-01-10" as DateOnly;
const NOW = new Date("2030-01-01T12:00:00.000Z");
const VERSION = "2030-01-01T11:00:00.123456+00:00";

const TASK_COLUMNS =
  "id,event_id,guild_id,assignee_id,description,due_date,status,completed_at,created_by,deleted_at,updated_at";
const EVENT_COLUMNS =
  "id,guild_id,channel_id,name,event_date,thread_id,overview_message_id,status,thread_status,created_by,deleted_at,created_at";

function taskRow() {
  return {
    id: ID,
    event_id: ID,
    guild_id: GUILD,
    assignee_id: ACTOR,
    description: "Book the room",
    due_date: DATE,
    status: "open",
    completed_at: null,
    created_by: ACTOR,
    deleted_at: null,
    updated_at: VERSION,
  };
}

function eventRow() {
  return {
    id: ID,
    guild_id: GUILD,
    channel_id: OTHER,
    name: "Social",
    event_date: DATE,
    thread_id: null,
    overview_message_id: null,
    status: "active",
    thread_status: "pending",
    created_by: ACTOR,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00+00:00",
  };
}

describe("exact requests", () => {
  const taskWrite = (body: unknown, filters: string) => ({
    method: "PATCH",
    target: `/rest/v1/tasks?${filters}&select=${TASK_COLUMNS}`,
    body,
  });
  const eventWrite = (body: unknown, filters: string) => ({
    method: "PATCH",
    target: `/rest/v1/events?${filters}&select=${EVENT_COLUMNS}`,
    body,
  });
  const rpc = (name: string, body: unknown) => ({
    method: "POST",
    target: `/rest/v1/rpc/${name}?`,
    body,
  });
  const read = (target: string) => ({
    method: "GET",
    target: `/rest/v1/${target}`,
    body: undefined,
  });

  const scopedTask = `id=eq.${ID}&guild_id=eq.${GUILD}`;
  const scopedEvent = `id=eq.${ID}&guild_id=eq.${GUILD}&deleted_at=is.null`;
  const reminderKey = {
    taskId: ID,
    kind: "one_day" as const,
    dueDate: DATE,
  };

  const cases: [
    string,
    (db: ReturnType<typeof mockPostgrest>["db"]) => Promise<{ ok: boolean }>,
    MockResponse,
    { method: string; target: string; body: unknown },
  ][] = [
    [
      "markOwnTaskDone",
      (db) =>
        markOwnTaskDone(db, {
          guildId: GUILD,
          taskId: ID,
          assigneeId: ACTOR,
          now: NOW,
        }),
      { body: [taskRow()] },
      taskWrite(
        { status: "done", completed_at: NOW.toISOString() },
        `${scopedTask}&assignee_id=eq.${ACTOR}&status=eq.open&deleted_at=is.null`,
      ),
    ],
    [
      "markTaskDoneAsOfficer",
      (db) =>
        markTaskDoneAsOfficer(db, { guildId: GUILD, taskId: ID, now: NOW }),
      { body: [taskRow()] },
      taskWrite(
        { status: "done", completed_at: NOW.toISOString() },
        `${scopedTask}&status=eq.open&deleted_at=is.null`,
      ),
    ],
    [
      "editTask",
      (db) =>
        editTask(db, {
          guildId: GUILD,
          taskId: ID,
          expectedUpdatedAt: VERSION,
          description: "Book it",
          dueDate: DATE,
          assigneeId: OTHER,
        }),
      { body: [taskRow()] },
      taskWrite(
        { description: "Book it", due_date: DATE, assignee_id: OTHER },
        `${scopedTask}&updated_at=eq.${VERSION}&status=eq.open&deleted_at=is.null`,
      ),
    ],
    [
      "softDeleteTaskIfUnchanged",
      (db) =>
        softDeleteTaskIfUnchanged(db, {
          guildId: GUILD,
          taskId: ID,
          expectedUpdatedAt: VERSION,
          now: NOW,
        }),
      { body: [taskRow()] },
      taskWrite(
        { deleted_at: NOW.toISOString() },
        `${scopedTask}&updated_at=eq.${VERSION}&deleted_at=is.null`,
      ),
    ],
    [
      "reassignTask",
      (db) =>
        reassignTask(db, {
          guildId: GUILD,
          taskId: ID,
          expectedUpdatedAt: VERSION,
          assigneeId: OTHER,
        }),
      { body: [taskRow()] },
      taskWrite(
        { assignee_id: OTHER },
        `${scopedTask}&updated_at=eq.${VERSION}&status=eq.open&deleted_at=is.null`,
      ),
    ],
    [
      "setTaskDescription",
      (db) =>
        setTaskDescription(db, {
          guildId: GUILD,
          taskId: ID,
          expectedUpdatedAt: VERSION,
          description: 'a,b).c"*%',
        }),
      { body: [taskRow()] },
      taskWrite(
        { description: 'a,b).c"*%' },
        `${scopedTask}&updated_at=eq.${VERSION}&status=eq.open&deleted_at=is.null`,
      ),
    ],
    [
      "setTaskDueDate",
      (db) =>
        setTaskDueDate(db, {
          guildId: GUILD,
          taskId: ID,
          expectedUpdatedAt: VERSION,
          dueDate: DATE,
        }),
      { body: [taskRow()] },
      taskWrite(
        { due_date: DATE },
        `${scopedTask}&updated_at=eq.${VERSION}&status=eq.open&deleted_at=is.null`,
      ),
    ],
    [
      "softDeleteTask",
      (db) => softDeleteTask(db, { guildId: GUILD, taskId: ID, now: NOW }),
      { body: [taskRow()] },
      taskWrite(
        { deleted_at: NOW.toISOString() },
        `${scopedTask}&deleted_at=is.null`,
      ),
    ],
    [
      "createTask",
      (db) =>
        createTask(db, {
          guildId: GUILD,
          eventId: ID,
          assigneeId: OTHER,
          actorId: ACTOR,
          description: "Book the room",
          dueDate: DATE,
        }),
      { status: 201, body: [taskRow()] },
      {
        method: "POST",
        target: `/rest/v1/tasks?select=${TASK_COLUMNS}`,
        body: {
          event_id: ID,
          guild_id: GUILD,
          assignee_id: OTHER,
          description: "Book the room",
          due_date: DATE,
          created_by: ACTOR,
        },
      },
    ],
    [
      "getTask",
      (db) => getTask(db, { guildId: GUILD, taskId: ID }),
      { body: [taskRow()] },
      read(
        `tasks?select=${TASK_COLUMNS}&${scopedTask}&deleted_at=is.null&limit=1`,
      ),
    ],
    [
      "searchOpenTasksByIdPrefix",
      (db) => searchOpenTasksByIdPrefix(db, { guildId: GUILD, prefix: "ab12" }),
      {},
      read(
        `tasks?select=id,description,due_date,events!inner(id)&guild_id=eq.${GUILD}&status=eq.open&deleted_at=is.null&events.status=eq.active&events.deleted_at=is.null&id=gte.ab120000-0000-0000-0000-000000000000&id=lte.ab12ffff-ffff-ffff-ffff-ffffffffffff&order=id.asc&limit=25`,
      ),
    ],
    [
      "searchLiveTasksByIdPrefix",
      (db) => searchLiveTasksByIdPrefix(db, { guildId: GUILD, prefix: "ab12" }),
      {},
      read(
        `tasks?select=id,description,due_date,status,events!inner(id)&guild_id=eq.${GUILD}&deleted_at=is.null&events.status=eq.active&events.deleted_at=is.null&id=gte.ab120000-0000-0000-0000-000000000000&id=lte.ab12ffff-ffff-ffff-ffff-ffffffffffff&order=id.asc&limit=25`,
      ),
    ],
    [
      "searchOwnOpenTasksByIdPrefix",
      (db) =>
        searchOwnOpenTasksByIdPrefix(db, {
          guildId: GUILD,
          assigneeId: ACTOR,
          prefix: "ab12",
        }),
      {},
      read(
        `tasks?select=id,description,due_date,events!inner(id)&guild_id=eq.${GUILD}&assignee_id=eq.${ACTOR}&status=eq.open&deleted_at=is.null&events.status=eq.active&events.deleted_at=is.null&id=gte.ab120000-0000-0000-0000-000000000000&id=lte.ab12ffff-ffff-ffff-ffff-ffffffffffff&order=id.asc&limit=25`,
      ),
    ],
    [
      "searchOpenEventsByIdPrefix",
      (db) =>
        searchOpenEventsByIdPrefix(db, { guildId: GUILD, prefix: "ab12" }),
      {},
      read(
        `events?select=id,name,event_date,status&guild_id=eq.${GUILD}&status=eq.active&deleted_at=is.null&id=gte.ab120000-0000-0000-0000-000000000000&id=lte.ab12ffff-ffff-ffff-ffff-ffffffffffff&order=id.asc&limit=25`,
      ),
    ],
    [
      "findEventByThread",
      (db) => findEventByThread(db, { guildId: GUILD, threadId: OTHER }),
      {},
      read(
        `events?select=${EVENT_COLUMNS}&thread_id=eq.${OTHER}&guild_id=eq.${GUILD}&deleted_at=is.null&limit=1`,
      ),
    ],
    [
      "findEventEverOnThread",
      (db) => findEventEverOnThread(db, { guildId: GUILD, threadId: OTHER }),
      {},
      read(
        `events?select=${EVENT_COLUMNS}&thread_id=eq.${OTHER}&guild_id=eq.${GUILD}&limit=1`,
      ),
    ],
    [
      "listOpenTasksForAssignee",
      (db) =>
        listOpenTasksForAssignee(db, { guildId: GUILD, assigneeId: ACTOR }),
      {},
      read(
        `tasks?select=id,event_id,description,due_date,events!inner(name)&guild_id=eq.${GUILD}&assignee_id=eq.${ACTOR}&status=eq.open&deleted_at=is.null&events.status=eq.active&events.deleted_at=is.null&order=due_date.asc,id.asc&limit=101`,
      ),
    ],
    [
      "listEventTasks",
      (db) => listEventTasks(db, { guildId: GUILD, eventId: ID }),
      {},
      read(
        `tasks?select=${TASK_COLUMNS}&guild_id=eq.${GUILD}&event_id=eq.${ID}&deleted_at=is.null&order=status.asc,due_date.asc,id.asc&limit=101`,
      ),
    ],
    [
      "createEvent",
      (db) =>
        createEvent(db, {
          guildId: GUILD,
          channelId: OTHER,
          actorId: ACTOR,
          name: "Social",
          eventDate: DATE,
        }),
      { status: 201, body: [eventRow()] },
      {
        method: "POST",
        target: `/rest/v1/events?select=${EVENT_COLUMNS}`,
        body: {
          guild_id: GUILD,
          channel_id: OTHER,
          name: "Social",
          event_date: DATE,
          created_by: ACTOR,
        },
      },
    ],
    [
      "createLinkedEvent",
      (db) =>
        createLinkedEvent(db, {
          guildId: GUILD,
          channelId: OTHER,
          actorId: ACTOR,
          name: "Social",
          eventDate: DATE,
          threadId: ACTOR,
        }),
      { status: 201, body: [eventRow()] },
      {
        method: "POST",
        target: `/rest/v1/events?select=${EVENT_COLUMNS}`,
        body: {
          guild_id: GUILD,
          channel_id: OTHER,
          name: "Social",
          event_date: DATE,
          created_by: ACTOR,
          thread_id: ACTOR,
          thread_status: "active",
        },
      },
    ],
    [
      "claimEventPostAttempt",
      (db) => claimEventPostAttempt(db, { guildId: GUILD, eventId: ID }),
      { body: true },
      rpc("claim_event_post_attempt", { p_event_id: ID, p_guild_id: GUILD }),
    ],
    [
      "releaseEventPostAttempt",
      (db) => releaseEventPostAttempt(db, { guildId: GUILD, eventId: ID }),
      { body: true },
      rpc("release_event_post_attempt", { p_event_id: ID, p_guild_id: GUILD }),
    ],
    [
      "listEventsNamed",
      (db) =>
        listEventsNamed(db, {
          guildId: GUILD,
          channelId: OTHER,
          name: "x,deleted_at.not.is.null",
          eventDate: DATE,
        }),
      {},
      read(
        `events?select=${EVENT_COLUMNS}&guild_id=eq.${GUILD}&channel_id=eq.${OTHER}&name=eq.x,deleted_at.not.is.null&event_date=eq.${DATE}&deleted_at=is.null&order=id.asc&limit=25`,
      ),
    ],
    [
      "attachEventPost",
      (db) =>
        attachEventPost(db, {
          guildId: GUILD,
          eventId: ID,
          threadId: OTHER,
          overviewMessageId: ACTOR,
        }),
      { body: [eventRow()] },
      eventWrite(
        {
          thread_id: OTHER,
          overview_message_id: ACTOR,
          thread_status: "active",
        },
        `${scopedEvent}&thread_status=eq.pending`,
      ),
    ],
    [
      "getEvent",
      (db) => getEvent(db, { guildId: GUILD, eventId: ID }),
      { body: [eventRow()] },
      read(`events?select=${EVENT_COLUMNS}&${scopedEvent}&limit=1`),
    ],
    [
      "listEvents",
      (db) => listEvents(db, { guildId: GUILD }),
      {},
      read(
        `events?select=${EVENT_COLUMNS}&guild_id=eq.${GUILD}&deleted_at=is.null&order=status.asc,event_date.desc,id.asc&limit=101`,
      ),
    ],
    [
      "setEventThread",
      (db) =>
        setEventThread(db, { guildId: GUILD, eventId: ID, threadId: OTHER }),
      { body: [eventRow()] },
      eventWrite(
        { thread_id: OTHER, thread_status: "active" },
        `${scopedEvent}&thread_status=neq.active`,
      ),
    ],
    [
      "markEventThreadMissing",
      (db) => markEventThreadMissing(db, { guildId: GUILD, eventId: ID }),
      { body: [eventRow()] },
      eventWrite(
        { thread_status: "missing" },
        `${scopedEvent}&thread_status=eq.active`,
      ),
    ],
    [
      "setEventOverviewMessage",
      (db) =>
        setEventOverviewMessage(db, {
          guildId: GUILD,
          eventId: ID,
          messageId: OTHER,
        }),
      { body: [eventRow()] },
      eventWrite({ overview_message_id: OTHER }, scopedEvent),
    ],
    [
      "closeEvent",
      (db) => closeEvent(db, { guildId: GUILD, eventId: ID }),
      { body: [eventRow()] },
      eventWrite({ status: "closed" }, `${scopedEvent}&status=eq.active`),
    ],
    [
      "softDeleteEvent",
      (db) => softDeleteEvent(db, { guildId: GUILD, eventId: ID }),
      { body: 2 },
      rpc("soft_delete_event", { p_event_id: ID, p_guild_id: GUILD }),
    ],
    [
      "getGuildConfig",
      (db) => getGuildConfig(db, { guildId: GUILD }),
      {},
      read(
        `guild_config?select=guild_id,officer_role_id,admin_role_id,timezone,reminders_enabled,version&guild_id=eq.${GUILD}&limit=1`,
      ),
    ],
    [
      "listRecentConfigChanges",
      (db) => listRecentConfigChanges(db, { guildId: GUILD }),
      {},
      read(
        `config_audit?select=id,actor_id,action,old_values,new_values,version_after,created_at&guild_id=eq.${GUILD}&order=id.desc&limit=6`,
      ),
    ],
    [
      "applyRoleBindings",
      (db) =>
        applyRoleBindings(db, {
          guildId: GUILD,
          actorId: ACTOR,
          expectedVersion: 0,
          officerRoleId: OTHER,
          adminRoleId: OTHER,
        }),
      { body: 1 },
      rpc("apply_role_bindings", {
        p_guild_id: GUILD,
        p_expected_version: 0,
        p_actor_id: ACTOR,
        p_officer_role_id: OTHER,
        p_admin_role_id: OTHER,
      }),
    ],
    [
      "applyConfigChange",
      (db) =>
        applyConfigChange(db, {
          guildId: GUILD,
          actorId: ACTOR,
          expectedVersion: 3,
          remindersEnabled: null,
          addChannelIds: [OTHER],
          removeChannelIds: [],
          timezone: null,
        }),
      { body: 4 },
      rpc("apply_config_change", {
        p_guild_id: GUILD,
        p_expected_version: 3,
        p_actor_id: ACTOR,
        p_reminders_enabled: null,
        p_add_channel_ids: [OTHER],
        p_remove_channel_ids: [],
        p_timezone: null,
      }),
    ],
    [
      "getManagedChannel",
      (db) => getManagedChannel(db, { guildId: GUILD, channelId: OTHER }),
      {},
      read(
        `managed_channels?select=guild_id,channel_id,status&guild_id=eq.${GUILD}&channel_id=eq.${OTHER}&limit=1`,
      ),
    ],
    [
      "listManagedChannels",
      (db) => listManagedChannels(db, { guildId: GUILD }),
      {},
      read(
        `managed_channels?select=guild_id,channel_id,status&guild_id=eq.${GUILD}&order=channel_id.asc&limit=501`,
      ),
    ],
    [
      "listManagedChannelsByIds",
      (db) =>
        listManagedChannelsByIds(db, {
          guildId: GUILD,
          channelIds: [OTHER, ACTOR],
        }),
      {},
      read(
        `managed_channels?select=guild_id,channel_id,status&guild_id=eq.${GUILD}&channel_id=in.(${OTHER},${ACTOR})&order=channel_id.asc&limit=501`,
      ),
    ],
    [
      "listRecentEventsInChannel",
      (db) =>
        listRecentEventsInChannel(db, {
          guildId: GUILD,
          channelId: OTHER,
          limit: 10,
        }),
      {},
      read(
        `events?select=id,guild_id,channel_id,name,event_date,thread_id,overview_message_id,status,thread_status,created_by,deleted_at,created_at&guild_id=eq.${GUILD}&channel_id=eq.${OTHER}&thread_status=eq.active&deleted_at=is.null&order=updated_at.desc,id.asc&limit=11`,
      ),
    ],
    [
      "markChannelUnavailable",
      (db) => markChannelUnavailable(db, { guildId: GUILD, channelId: OTHER }),
      { body: true },
      rpc("mark_channel_unavailable", {
        p_guild_id: GUILD,
        p_channel_id: OTHER,
      }),
    ],
    [
      "claimInteraction",
      (db) => claimInteraction(db, { interactionId: OTHER }),
      { body: true },
      rpc("claim_interaction", { p_interaction_id: OTHER }),
    ],
    [
      "listReminderCandidates",
      (db) => listReminderCandidates(db, { lastDueDate: DATE }),
      {},
      read(
        `tasks?select=id,event_id,guild_id,assignee_id,description,due_date,status,updated_at,events!inner(id,name,thread_id,status,thread_status,thread_refusals,managed_channels!inner(guild_config!inner(timezone))),reminder_log(kind,due_date,state,claimed_at)&status=eq.open&deleted_at=is.null&due_date=lte.${DATE}&events.status=eq.active&events.deleted_at=is.null&events.managed_channels.status=eq.active&events.managed_channels.guild_config.reminders_enabled=is.true&or=(due_date.gt.2000-01-01,and(due_date.eq.2000-01-01,id.gt.00000000-0000-0000-0000-000000000000))&order=due_date.asc,id.asc&limit=500`,
      ),
    ],
    [
      "listStaleClaims",
      (db) => listStaleClaims(db, { claimedBefore: NOW }),
      {},
      read(
        `reminder_log?select=task_id,kind,due_date,claim_token,attempts,refused_attempts,claimed_at&state=eq.claimed&claimed_at=lt.${NOW.toISOString()}&order=claimed_at.asc,task_id.asc,kind.asc,due_date.asc&limit=501`,
      ),
    ],
    [
      "claimReminder",
      (db) => claimReminder(db, reminderKey),
      { body: TOKEN },
      rpc("claim_reminder", {
        p_task_id: ID,
        p_kind: "one_day",
        p_due_date: DATE,
        p_assignee_id: null,
        p_updated_at: null,
      }),
    ],
    [
      "claimReminder, naming the task as read",
      (db) =>
        claimReminder(db, {
          ...reminderKey,
          asRead: { assigneeId: OTHER, updatedAt: VERSION },
        }),
      { body: TOKEN },
      rpc("claim_reminder", {
        p_task_id: ID,
        p_kind: "one_day",
        p_due_date: DATE,
        p_assignee_id: OTHER,
        p_updated_at: VERSION,
      }),
    ],
    [
      "recordReminderRefused",
      (db) => recordReminderRefused(db, { ...reminderKey, claimToken: TOKEN }),
      { body: true },
      rpc("record_reminder_refused", {
        p_task_id: ID,
        p_kind: "one_day",
        p_due_date: DATE,
        p_claim_token: TOKEN,
      }),
    ],
    [
      "recordThreadRefusal",
      (db) => recordThreadRefusal(db, { guildId: GUILD, eventId: ID }),
      { body: 2 },
      rpc("record_thread_refusal", { p_event_id: ID, p_guild_id: GUILD }),
    ],
    [
      "clearThreadRefusals",
      (db) => clearThreadRefusals(db, { guildId: GUILD, eventId: ID }),
      { body: true },
      rpc("clear_thread_refusals", { p_event_id: ID, p_guild_id: GUILD }),
    ],
    [
      "reclaimReminder",
      (db) => reclaimReminder(db, { ...reminderKey, claimToken: TOKEN }),
      { body: null },
      rpc("reclaim_reminder", {
        p_task_id: ID,
        p_kind: "one_day",
        p_due_date: DATE,
        p_claim_token: TOKEN,
        p_assignee_id: null,
        p_updated_at: null,
      }),
    ],
    [
      "markReminderSent",
      (db) =>
        markReminderSent(db, {
          ...reminderKey,
          claimToken: TOKEN,
          messageId: OTHER,
        }),
      { body: true },
      rpc("mark_reminder_sent", {
        p_task_id: ID,
        p_kind: "one_day",
        p_due_date: DATE,
        p_claim_token: TOKEN,
        p_message_id: OTHER,
      }),
    ],
    [
      "markReminderSkipped",
      (db) => markReminderSkipped(db, { ...reminderKey, claimToken: TOKEN }),
      { body: false },
      rpc("mark_reminder_skipped", {
        p_task_id: ID,
        p_kind: "one_day",
        p_due_date: DATE,
        p_claim_token: TOKEN,
      }),
    ],
    [
      "getLatestJobRun",
      (db) => getLatestJobRun(db, { jobName: "reminders" }),
      {},
      read(
        "job_runs?select=id,job_name,status,started_at,heartbeat_at,finished_at,results,error&job_name=eq.reminders&order=started_at.desc&limit=1",
      ),
    ],
  ];

  it.each(cases)("%s", async (_name, call, response, expected) => {
    const { db, requests } = mockPostgrest(() => response);
    const result = await call(db);
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect({
      method: requests[0]?.method,
      target: requests[0]?.target,
      body: requests[0]?.body,
    }).toEqual(expected);
  });

  it("asks for the changed row back on every write, so the count can be checked", async () => {
    const { db, requests } = mockPostgrest(() => ({ body: [taskRow()] }));
    await reassignTask(db, {
      guildId: GUILD,
      taskId: ID,
      expectedUpdatedAt: VERSION,
      assigneeId: OTHER,
    });
    expect(requests[0]?.headers.get("prefer")).toBe("return=representation");
  });

  const candidate = (id: string, dueDate: string) => ({
    ...taskRow(),
    id,
    due_date: dueDate,
    events: {
      id: ID,
      name: "Social",
      thread_id: null,
      status: "active",
      thread_status: "pending",
      thread_refusals: 0,
      managed_channels: {
        guild_config: { timezone: "America/New_York" },
      },
    },
    reminder_log: [],
  });

  it("reads the planner in pages, continuing after the last row of each", async () => {
    let call = 0;
    const { db, requests } = mockPostgrest(() => {
      call += 1;
      return {
        body:
          call === 1
            ? Array.from({ length: 500 }, () => candidate(TOKEN, "2030-01-05"))
            : [candidate(ID, "2030-01-06")],
      };
    });
    const result = await listReminderCandidates(db, { lastDueDate: DATE });
    expect(result.ok && result.value.rows).toHaveLength(501);
    expect(result.ok && result.value.truncated).toBe(false);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.target).toContain(
      `or=(due_date.gt.2030-01-05,and(due_date.eq.2030-01-05,id.gt.${TOKEN}))`,
    );
  });

  it("reports the planner as truncated when it stops at the page limit", async () => {
    const { db, requests } = mockPostgrest(() => ({
      body: Array.from({ length: 500 }, () => candidate(TOKEN, "2030-01-05")),
    }));
    const result = await listReminderCandidates(db, { lastDueDate: DATE });
    expect(result.ok && result.value.truncated).toBe(true);
    expect(requests).toHaveLength(20);
  });

  it("stops and reports truncated if a full page ends with no readable position", async () => {
    const { db, requests } = mockPostgrest(() => ({
      body: Array.from({ length: 500 }, () => ({ id: "not-a-uuid" })),
    }));
    const result = await listReminderCandidates(db, { lastDueDate: DATE });
    expect(result.ok && result.value.truncated).toBe(true);
    expect(result.ok && result.value.excluded).toHaveLength(500);
    expect(requests).toHaveLength(1);
  });
});

describe("autocomplete search", () => {
  const searches: [
    string,
    (
      db: ReturnType<typeof mockPostgrest>["db"],
      term: string,
    ) => Promise<{ ok: boolean }>,
    string,
    string,
    string,
  ][] = [
    [
      "searchEvents",
      (db, term) => searchEvents(db, { guildId: GUILD, term }),
      "events",
      `select=id,name,event_date,status&guild_id=eq.${GUILD}&deleted_at=is.null&name=ilike.`,
      "&order=status.asc,event_date.desc,id.asc&limit=25",
    ],
    [
      "searchOpenEvents",
      (db, term) => searchOpenEvents(db, { guildId: GUILD, term }),
      "events",
      `select=id,name,event_date,status&guild_id=eq.${GUILD}&status=eq.active&deleted_at=is.null&name=ilike.`,
      "&order=event_date.desc,id.asc&limit=25",
    ],
    [
      "searchOpenTasks",
      (db, term) => searchOpenTasks(db, { guildId: GUILD, term }),
      "tasks",
      `select=id,description,due_date,events!inner(id)&guild_id=eq.${GUILD}&status=eq.open&deleted_at=is.null&events.status=eq.active&events.deleted_at=is.null&description=ilike.`,
      "&order=due_date.asc,id.asc&limit=25",
    ],
    [
      "searchLiveTasks",
      (db, term) => searchLiveTasks(db, { guildId: GUILD, term }),
      "tasks",
      `select=id,description,due_date,status,events!inner(id)&guild_id=eq.${GUILD}&deleted_at=is.null&events.status=eq.active&events.deleted_at=is.null&description=ilike.`,
      "&order=status.asc,due_date.asc,id.asc&limit=25",
    ],
    [
      "searchOwnOpenTasks",
      (db, term) =>
        searchOwnOpenTasks(db, { guildId: GUILD, assigneeId: ACTOR, term }),
      "tasks",
      `select=id,description,due_date,events!inner(id)&guild_id=eq.${GUILD}&assignee_id=eq.${ACTOR}&status=eq.open&deleted_at=is.null&events.status=eq.active&events.deleted_at=is.null&description=ilike.`,
      "&order=due_date.asc,id.asc&limit=25",
    ],
  ];

  describe.each(searches)("%s", (_name, search, table, before, after) => {
    it.each([
      [
        "a comma and a filter",
        "x,deleted_at.not.is.null",
        "%x,deleted\\_at.not.is.null%",
      ],
      ["a closing paren", "x)", "%x)%"],
      ["a dot", "a.b", "%a.b%"],
      ["a double quote", 'x","y', '%x","y%'],
      ["an asterisk", "x*", "%x\\*%"],
      ["a percent sign", "%", "%\\%%"],
      ["an underscore", "_", "%\\_%"],
      ["a backslash", "\\", "%\\\\%"],
      ["an or() group", "or=(id.eq.1)", "%or=(id.eq.1)%"],
      [
        "an ampersand",
        "a&deleted_at=not.is.null",
        "%a&deleted\\_at=not.is.null%",
      ],
    ])("keeps %s inside the one value", async (_case, term, pattern) => {
      const { db, requests } = mockPostgrest();
      await search(db, term);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.target).toBe(
        `/rest/v1/${table}?${before}${pattern}${after}`,
      );
    });

    it("encodes the value so it cannot add a query parameter", async () => {
      const { db, requests } = mockPostgrest();
      await search(db, "a&deleted_at=not.is.null");
      const url = new URL(`https://x.test${requests[0]?.rawTarget ?? ""}`);
      expect(url.searchParams.getAll("deleted_at")).toEqual(["is.null"]);
    });

    it.each(["x\u0000y", "\u0000", "x\ud800", "\udc00y"])(
      "refuses %j before any query",
      async (term) => {
        const { db, requests } = mockPostgrest();
        const result = await search(db, term);
        expect(result).toEqual({
          ok: false,
          error: { category: "invalid_input", code: null },
        });
        expect(requests).toEqual([]);
      },
    );

    it("caps a long term", async () => {
      const { db, requests } = mockPostgrest();
      await search(db, "a".repeat(6000));
      expect(requests[0]?.target).toBe(
        `/rest/v1/${table}?${before}%${"a".repeat(100)}%${after}`,
      );
    });
  });
});

describe("refusals before any query", () => {
  const db = () => mockPostgrest();

  /** Each call with one hostile value in the given position. */
  const idCalls: [
    string,
    (
      client: ReturnType<typeof mockPostgrest>["db"],
      hostile: string,
    ) => Promise<{ ok: boolean }>,
  ][] = [
    ["getTask guild", (c, h) => getTask(c, { guildId: h, taskId: ID })],
    ["getTask id", (c, h) => getTask(c, { guildId: GUILD, taskId: h })],
    ["getEvent guild", (c, h) => getEvent(c, { guildId: h, eventId: ID })],
    ["getEvent id", (c, h) => getEvent(c, { guildId: GUILD, eventId: h })],
    [
      "markOwnTaskDone assignee",
      (c, h) =>
        markOwnTaskDone(c, {
          guildId: GUILD,
          taskId: ID,
          assigneeId: h,
          now: NOW,
        }),
    ],
    [
      "markOwnTaskDone id",
      (c, h) =>
        markOwnTaskDone(c, {
          guildId: GUILD,
          taskId: h,
          assigneeId: ACTOR,
          now: NOW,
        }),
    ],
    [
      "softDeleteTask id",
      (c, h) => softDeleteTask(c, { guildId: GUILD, taskId: h, now: NOW }),
    ],
    [
      "softDeleteEvent guild",
      (c, h) => softDeleteEvent(c, { guildId: h, eventId: ID }),
    ],
    [
      "claimEventPostAttempt id",
      (c, h) => claimEventPostAttempt(c, { guildId: GUILD, eventId: h }),
    ],
    [
      "releaseEventPostAttempt id",
      (c, h) => releaseEventPostAttempt(c, { guildId: GUILD, eventId: h }),
    ],
    [
      "listEventsNamed channel",
      (c, h) =>
        listEventsNamed(c, {
          guildId: GUILD,
          channelId: h,
          name: "Social",
          eventDate: DATE,
        }),
    ],
    [
      "attachEventPost thread",
      (c, h) =>
        attachEventPost(c, {
          guildId: GUILD,
          eventId: ID,
          threadId: h,
          overviewMessageId: OTHER,
        }),
    ],
    [
      "attachEventPost message",
      (c, h) =>
        attachEventPost(c, {
          guildId: GUILD,
          eventId: ID,
          threadId: OTHER,
          overviewMessageId: h,
        }),
    ],
    [
      "createLinkedEvent thread",
      (c, h) =>
        createLinkedEvent(c, {
          guildId: GUILD,
          channelId: OTHER,
          actorId: ACTOR,
          name: "Social",
          eventDate: DATE,
          threadId: h,
        }),
    ],
    [
      "setEventThread thread",
      (c, h) => setEventThread(c, { guildId: GUILD, eventId: ID, threadId: h }),
    ],
    ["getGuildConfig", (c, h) => getGuildConfig(c, { guildId: h })],
    [
      "applyRoleBindings actor",
      (c, h) =>
        applyRoleBindings(c, {
          guildId: GUILD,
          actorId: h,
          expectedVersion: 0,
          officerRoleId: OTHER,
          adminRoleId: OTHER,
        }),
    ],
    [
      "applyConfigChange guild",
      (c, h) =>
        applyConfigChange(c, {
          guildId: h,
          actorId: ACTOR,
          expectedVersion: 1,
          remindersEnabled: false,
          addChannelIds: [],
          removeChannelIds: [],
          timezone: null,
        }),
    ],
    [
      "applyConfigChange channel list",
      (c, h) =>
        applyConfigChange(c, {
          guildId: GUILD,
          actorId: ACTOR,
          expectedVersion: 1,
          remindersEnabled: null,
          addChannelIds: [OTHER, h],
          removeChannelIds: [],
          timezone: null,
        }),
    ],
    [
      "listManagedChannelsByIds",
      (c, h) =>
        listManagedChannelsByIds(c, {
          guildId: GUILD,
          channelIds: [OTHER, h],
        }),
    ],
    [
      "listRecentEventsInChannel",
      (c, h) =>
        listRecentEventsInChannel(c, {
          guildId: GUILD,
          channelId: h,
          limit: 10,
        }),
    ],
    [
      "markChannelUnavailable",
      (c, h) => markChannelUnavailable(c, { guildId: GUILD, channelId: h }),
    ],
    ["claimInteraction", (c, h) => claimInteraction(c, { interactionId: h })],
    [
      "claimReminder task",
      (c, h) => claimReminder(c, { taskId: h, kind: "one_day", dueDate: DATE }),
    ],
    [
      "markReminderSent token",
      (c, h) =>
        markReminderSent(c, {
          taskId: ID,
          kind: "one_day",
          dueDate: DATE,
          claimToken: h,
          messageId: OTHER,
        }),
    ],
  ];

  describe.each(idCalls)("%s", (_name, call) => {
    it.each(HOSTILE_STRINGS)("refuses the ID %j", async (hostile) => {
      const { db: client, requests } = db();
      expect(await call(client, hostile)).toEqual({
        ok: false,
        error: { category: "invalid_input", code: null },
      });
      expect(requests).toEqual([]);
    });
  });

  const textCalls: [
    string,
    (
      client: ReturnType<typeof mockPostgrest>["db"],
      text: string,
    ) => Promise<{ ok: boolean }>,
  ][] = [
    [
      "createEvent name",
      (c, t) =>
        createEvent(c, {
          guildId: GUILD,
          channelId: OTHER,
          actorId: ACTOR,
          name: t,
          eventDate: DATE,
        }),
    ],
    [
      "createTask description",
      (c, t) =>
        createTask(c, {
          guildId: GUILD,
          eventId: ID,
          assigneeId: OTHER,
          actorId: ACTOR,
          description: t,
          dueDate: DATE,
        }),
    ],
    [
      "setTaskDescription",
      (c, t) =>
        setTaskDescription(c, {
          guildId: GUILD,
          taskId: ID,
          expectedUpdatedAt: VERSION,
          description: t,
        }),
    ],
    [
      "applyConfigChange timezone",
      (c, t) =>
        applyConfigChange(c, {
          guildId: GUILD,
          actorId: ACTOR,
          expectedVersion: 1,
          remindersEnabled: null,
          addChannelIds: [],
          removeChannelIds: [],
          timezone: t,
        }),
    ],
  ];

  describe.each(textCalls)("%s", (_name, call) => {
    it.each(["a\u0000b", "a\ud800b", "\udc00", "", "   "])(
      "refuses the text %j",
      async (text) => {
        const { db: client, requests } = db();
        expect((await call(client, text)).ok).toBe(false);
        expect(requests).toEqual([]);
      },
    );
  });

  it("refuses an overlong event name and task description", async () => {
    const { db: client, requests } = db();
    const name = await createEvent(client, {
      guildId: GUILD,
      channelId: OTHER,
      actorId: ACTOR,
      name: "x".repeat(101),
      eventDate: DATE,
    });
    const description = await setTaskDescription(client, {
      guildId: GUILD,
      taskId: ID,
      expectedUpdatedAt: VERSION,
      description: "x".repeat(1001),
    });
    expect([name.ok, description.ok]).toEqual([false, false]);
    expect(requests).toEqual([]);
  });

  it.each(["infinity", "2030-02-30", "1999-12-31", "2030-01-10,x", ""])(
    "refuses the date %j",
    async (date) => {
      const { db: client, requests } = db();
      const results = await Promise.all([
        setTaskDueDate(client, {
          guildId: GUILD,
          taskId: ID,
          expectedUpdatedAt: VERSION,
          dueDate: date as DateOnly,
        }),
        listReminderCandidates(client, { lastDueDate: date as DateOnly }),
        claimReminder(client, {
          taskId: ID,
          kind: "one_day",
          dueDate: date as DateOnly,
        }),
      ]);
      expect(results.map((result) => result.ok)).toEqual([false, false, false]);
      expect(requests).toEqual([]);
    },
  );

  it("refuses an invalid instant", async () => {
    const { db: client, requests } = db();
    const bad = new Date(Number.NaN);
    const results = await Promise.all([
      listStaleClaims(client, { claimedBefore: bad }),
      markTaskDoneAsOfficer(client, { guildId: GUILD, taskId: ID, now: bad }),
    ]);
    expect(results.map((result) => result.ok)).toEqual([false, false]);
    expect(requests).toEqual([]);
  });

  it("refuses a kind that is not a reminder kind", async () => {
    const { db: client, requests } = db();
    const result = await claimReminder(client, {
      taskId: ID,
      kind: "constructor" as "one_day",
      dueDate: DATE,
    });
    expect(result.ok).toBe(false);
    expect(requests).toEqual([]);
  });

  it("refuses the guild ID as a role, since that is @everyone", async () => {
    const { db: client, requests } = db();
    const result = await applyRoleBindings(client, {
      guildId: GUILD,
      actorId: ACTOR,
      expectedVersion: 0,
      officerRoleId: GUILD,
      adminRoleId: OTHER,
    });
    expect(result.ok).toBe(false);
    expect(requests).toEqual([]);
  });

  it("refuses a bad version", async () => {
    const { db: client, requests } = db();
    for (const expectedVersion of [-1, 1.5, Number.NaN, 2 ** 31]) {
      const result = await applyRoleBindings(client, {
        guildId: GUILD,
        actorId: ACTOR,
        expectedVersion,
        officerRoleId: OTHER,
        adminRoleId: OTHER,
      });
      expect(result.ok).toBe(false);
    }
    expect(requests).toEqual([]);
  });

  it("refuses more channels than one change may carry", async () => {
    const { db: client, requests } = db();
    const result = await applyConfigChange(client, {
      guildId: GUILD,
      actorId: ACTOR,
      expectedVersion: 1,
      remindersEnabled: null,
      addChannelIds: Array.from({ length: 26 }, () => testSnowflake()),
      removeChannelIds: [],
      timezone: null,
    });
    expect(result.ok).toBe(false);
    expect(requests).toEqual([]);
  });
});

describe("arguments are named, so extra properties go nowhere", () => {
  it("ignores a hostile p_actor_id on the input object", async () => {
    const { db, requests } = mockPostgrest(() => ({ body: 2 }));
    const input = {
      guildId: GUILD,
      actorId: ACTOR,
      expectedVersion: 1,
      officerRoleId: OTHER,
      adminRoleId: OTHER,
      p_actor_id: "hostile",
      p_guild_id: "hostile",
    };
    await applyRoleBindings(db, input);
    expect(JSON.stringify(requests[0]?.body)).not.toContain("hostile");
  });

  it("ignores extra columns on a new task", async () => {
    const { db, requests } = mockPostgrest(() => ({
      status: 201,
      body: [taskRow()],
    }));
    const input = {
      guildId: GUILD,
      eventId: ID,
      assigneeId: OTHER,
      actorId: ACTOR,
      description: "Book the room",
      dueDate: DATE,
      deleted_at: "hostile",
      status: "hostile",
    };
    await createTask(db, input);
    expect(JSON.stringify(requests[0]?.body)).not.toContain("hostile");
  });
});

describe("row counts on writes", () => {
  const write = (db: ReturnType<typeof mockPostgrest>["db"]) =>
    markTaskDoneAsOfficer(db, { guildId: GUILD, taskId: ID, now: NOW });

  it("treats no changed row as not found", async () => {
    const { db } = mockPostgrest(() => ({ body: [] }));
    expect(await write(db)).toEqual({
      ok: false,
      error: { category: "not_found", code: null },
    });
  });

  it("treats two changed rows as a failure", async () => {
    const { db } = mockPostgrest(() => ({ body: [taskRow(), taskRow()] }));
    expect(await write(db)).toEqual({
      ok: false,
      error: { category: "unexpected", code: null },
    });
  });

  it("treats a changed row it cannot read as a failure", async () => {
    const { db } = mockPostgrest(() => ({
      body: [{ ...taskRow(), due_date: "bad" }],
    }));
    expect(await write(db)).toEqual({
      ok: false,
      error: { category: "bad_row", code: null },
    });
  });

  it("reports a null from soft_delete_event as not found", async () => {
    const { db } = mockPostgrest(() => ({ body: null }));
    expect(await softDeleteEvent(db, { guildId: GUILD, eventId: ID })).toEqual({
      ok: false,
      error: { category: "not_found", code: null },
    });
  });

  it("reports an RPC value of the wrong type as a bad row", async () => {
    const { db } = mockPostgrest(() => ({ body: "yes" }));
    expect((await claimInteraction(db, { interactionId: OTHER })).ok).toBe(
      false,
    );
    expect(
      (await claimReminder(db, { taskId: ID, kind: "due_day", dueDate: DATE }))
        .ok,
    ).toBe(false);
  });
});

describe("countOpenTasksInChannel", () => {
  const CHANNEL = testSnowflake();
  const row = (index: number) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    events: { channel_id: CHANNEL },
  });

  it("asks only for open, live tasks of live events in this guild and channel", async () => {
    const { db, requests } = mockPostgrest(() => ({ body: [row(1), row(2)] }));

    expect(
      await countOpenTasksInChannel(db, { guildId: GUILD, channelId: CHANNEL }),
    ).toEqual({ ok: true, value: { count: 2, truncated: false } });
    expect(requests[0]?.target).toBe(
      `/rest/v1/tasks?select=id,events!inner(channel_id)&guild_id=eq.${GUILD}&status=eq.open&deleted_at=is.null&events.channel_id=eq.${CHANNEL}&events.deleted_at=is.null&limit=101`,
    );
  });

  it("says when it stopped counting", async () => {
    const { db } = mockPostgrest(() => ({
      body: Array.from({ length: 101 }, (_, index) => row(index)),
    }));

    expect(
      await countOpenTasksInChannel(db, { guildId: GUILD, channelId: CHANNEL }),
    ).toEqual({ ok: true, value: { count: 100, truncated: true } });
  });

  it.each(HOSTILE_STRINGS)(
    "refuses the ID %j with no query",
    async (hostile) => {
      const { db, requests } = mockPostgrest();

      expect(
        (
          await countOpenTasksInChannel(db, {
            guildId: GUILD,
            channelId: hostile,
          })
        ).ok,
      ).toBe(false);
      expect(
        (
          await countOpenTasksInChannel(db, {
            guildId: hostile,
            channelId: CHANNEL,
          })
        ).ok,
      ).toBe(false);
      expect(requests).toEqual([]);
    },
  );

  it("passes a failure on with no text", async () => {
    const { db } = mockPostgrest(() => ({
      status: 500,
      body: { code: "XX000", message: "canary" },
    }));

    const result = await countOpenTasksInChannel(db, {
      guildId: GUILD,
      channelId: CHANNEL,
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("canary");
  });
});

describe("database errors", () => {
  const canary = "canary-text";
  const failing = (code: string) =>
    mockPostgrest(() => ({
      status: 400,
      body: { code, message: canary, details: canary, hint: canary },
    }));

  it.each([
    ["CF409", "stale_version"],
    ["CF410", "parent_unavailable"],
    ["23505", "conflict"],
    ["23514", "constraint"],
    ["42501", "forbidden"],
  ])("reports %s as %s with no text", async (code, category) => {
    const { db } = failing(code);
    const result = await reassignTask(db, {
      guildId: GUILD,
      taskId: ID,
      expectedUpdatedAt: VERSION,
      assigneeId: OTHER,
    });
    expect(result).toEqual({ ok: false, error: { category, code } });
    expect(JSON.stringify(result)).not.toContain(canary);
  });
});

describe("job runs", () => {
  const run = {
    id: ID,
    job_name: "reminders",
    status: "running",
    started_at: "2030-01-01T12:00:00+00:00",
    heartbeat_at: "2030-01-01T12:00:00.5+00:00",
    finished_at: null,
    results: {},
    error: null,
  };

  it("starts a run only through the lock function", async () => {
    const { db, requests } = mockPostgrest(() => ({ body: ID }));
    const result = await beginJobRun(db, {
      jobName: "reminders",
      staleAfterSeconds: 120,
    });
    expect(result).toEqual({ ok: true, value: ID });
    expect(requests[0]?.target).toBe("/rest/v1/rpc/begin_job_run?");
    expect(requests[0]?.body).toEqual({
      p_job_name: "reminders",
      p_stale_after_seconds: 120,
    });
  });

  it("refuses a job name that is not a known job", async () => {
    const { db, requests } = mockPostgrest();
    const result = await beginJobRun(db, {
      jobName: "x,y" as JobName,
      staleAfterSeconds: 120,
    });
    expect(result.ok).toBe(false);
    expect(requests).toEqual([]);
  });

  it("stores a list of event IDs next to the counts", async () => {
    const { db, requests } = mockPostgrest(() => ({ body: [run] }));
    await finishJobRun(db, {
      id: ID,
      now: NOW,
      results: { threads_held: 1, held_event_ids: [TOKEN] },
      error: null,
    });
    expect(requests[0]?.body).toMatchObject({
      p_results: { threads_held: 1, held_event_ids: [TOKEN] },
    });
  });

  it("stores only a category and code as the error", async () => {
    const { db, requests } = mockPostgrest(() => ({ body: [run] }));
    await finishJobRun(db, {
      id: ID,
      now: NOW,
      results: { sent: 3 },
      error: { category: "constraint", code: "23514" },
    });
    expect(requests[0]?.target).toBe("/rest/v1/rpc/finish_job_run?");
    expect(requests[0]?.body).toEqual({
      p_id: ID,
      p_finished_at: NOW.toISOString(),
      p_results: { sent: 3 },
      p_error: "constraint:23514",
    });
  });

  it("sends no error for a run that succeeded", async () => {
    const { db, requests } = mockPostgrest(() => ({ body: [run] }));
    await finishJobRun(db, { id: ID, now: NOW, results: {}, error: null });
    expect(requests[0]?.body).toMatchObject({ p_error: null });
  });

  it("fails as not_found when the function finished nothing", async () => {
    const { db } = mockPostgrest(() => ({ body: [] }));
    expect(
      await finishJobRun(db, { id: ID, now: NOW, results: {}, error: null }),
    ).toMatchObject({ ok: false, error: { category: "not_found" } });
  });

  it.each([
    [{ "bad key": 1 }],
    [{ text: Number.NaN }],
    [{ text: "words" as unknown as number }],
    [{ text: ["words"] }],
    [{ held_event_ids: ["words"] }],
    [{ held_event_ids: Array.from({ length: 26 }, () => ID) }],
    [{ held_event_ids: "words" as unknown as string[] }],
  ])("refuses the results %j", async (results) => {
    const { db, requests } = mockPostgrest();
    const result = await finishJobRun(db, {
      id: ID,
      now: NOW,
      results,
      error: null,
    });
    expect(result.ok).toBe(false);
    expect(requests).toEqual([]);
  });
});

describe("recordReassignment", () => {
  it("writes the three named columns and no more", async () => {
    const { db, requests } = mockPostgrest(() => ({ status: 201, body: null }));

    const result = await recordReassignment(db, {
      guildId: GUILD,
      actorId: ACTOR,
      taskId: ID,
    });

    expect(result).toEqual({ ok: true, value: null });
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.body).toEqual({
      guild_id: GUILD,
      actor_id: ACTOR,
      task_id: ID,
    });
  });

  it("reports the officer limit", async () => {
    const { db } = mockPostgrest(() => ({
      status: 400,
      body: { code: "CF430", message: "row text" },
    }));

    expect(
      await recordReassignment(db, {
        guildId: GUILD,
        actorId: ACTOR,
        taskId: ID,
      }),
    ).toEqual({
      ok: false,
      error: { category: "actor_task_limit", code: "CF430" },
    });
  });

  it.each([
    ["a bad guild", { guildId: "x", actorId: ACTOR, taskId: ID }],
    ["a bad actor", { guildId: GUILD, actorId: "x", taskId: ID }],
    ["a bad task", { guildId: GUILD, actorId: ACTOR, taskId: "x" }],
  ])("sends nothing for %s", async (_name, key) => {
    const { db, requests } = mockPostgrest();

    expect((await recordReassignment(db, key)).ok).toBe(false);
    expect(requests).toEqual([]);
  });
});

describe("searching by the start of an ID", () => {
  it.each(["", "ABC", "abc123456", "g", "a,b", "a b", "a%"])(
    "sends nothing for %j",
    async (prefix) => {
      const { db, requests } = mockPostgrest();

      expect(
        (await searchOpenTasksByIdPrefix(db, { guildId: GUILD, prefix })).ok,
      ).toBe(false);
      expect(requests).toEqual([]);
    },
  );
});
