/**
 * The bot's tables, in their own Postgres schema, `discord_bot`, beside buzz's tables in
 * `public`. This file is what `drizzle-kit generate` reads, and it is also what the code
 * in this folder queries with, so a column renamed here fails to compile everywhere it
 * is used.
 *
 * What Drizzle cannot say lives in a hand-written migration, `0001_*.sql`: the domain is
 * made at the top of the generated baseline, and the triggers, their functions, the
 * `bot_app` role and every grant are in the custom file. Every constraint, index and key
 * here is named, to match the database that dbmate made before Drizzle took over.
 *
 * Column order is the order in the database, which is the order dbmate's files made it:
 * `event_steps.not_needed_*` come last because a later migration added them.
 */

import { sql } from "drizzle-orm";
import { isoTimestamp } from "./parsers.ts";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgSchema,
  pgView,
  primaryKey,
  text,
  time,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const botSchema = pgSchema("discord_bot");

/** A Discord snowflake: 17 to 20 digits. The domain checks it, so no table repeats that. */
const discordId = customType<{ data: string }>({
  dataType: () => "discord_bot.discord_id",
});

/**
 * `timestamptz` read and written as text, so microseconds survive, and read as ISO text,
 * `2030-01-10T12:00:00.123456+00:00`, which a Date parses. An edit sends `updated_at`
 * back as the version it read, and a Date would round it to milliseconds and never match.
 */
const timestamptz = customType<{ data: string; driverData: string }>({
  dataType: () => "timestamp with time zone",
  fromDriver: isoTimestamp,
});

const createdAt = () =>
  timestamptz("created_at")
    .notNull()
    .default(sql`now()`);
const updatedAt = () =>
  timestamptz("updated_at")
    .notNull()
    .default(sql`now()`);

// Enums ---------------------------------------------------------------------------------

export const eventReminderKind = botSchema.enum("event_reminder_kind", [
  "daily_steps",
  "pickup_before",
  "pickup_day",
  "steps_unassigned",
  "budget_due",
  "engage_due",
  "budget_overdue",
  "engage_overdue",
  "engage_picture_late",
  "marketing_week",
  "slides_unassigned",
  "pickup_unset",
  "marketing_saturday",
  "slides_due",
  "slides_tomorrow",
  "event_today",
]);

export const eventStatus = botSchema.enum("event_status", ["active", "closed"]);

/** In the order the checklist shows the steps. */
export const eventStepKind = botSchema.enum("event_step_kind", [
  "budget_sheet",
  "engage_post",
  "engage_picture",
  "budget_approved",
  "slides",
  "food_pickup",
]);

export const jobRunStatus = botSchema.enum("job_run_status", [
  "running",
  "succeeded",
  "failed",
]);

export const managedChannelStatus = botSchema.enum("managed_channel_status", [
  "active",
  "unavailable",
  "removed",
]);

export const reminderKind = botSchema.enum("reminder_kind", [
  "three_days",
  "one_day",
  "due_day",
  "overdue",
]);

export const reminderState = botSchema.enum("reminder_state", [
  "claimed",
  "sent",
  "skipped",
]);

export const taskStatus = botSchema.enum("task_status", ["open", "done"]);

export const threadStatus = botSchema.enum("thread_status", [
  "pending",
  "active",
  "missing",
]);

// Tables --------------------------------------------------------------------------------

/** The login the bot connects as. It exists already: the migrations only grant to it. */
export const botApp = pgRole("bot_app").existing();

/** The server's list of time zone names, which a guild's zone has to be one of. */
export const timezoneNames = pgView("pg_timezone_names", {
  name: text("name"),
}).existing();

/**
 * The old version of every changed row of the seven tables that keep one. Written by the
 * bot with each update. `xid` is the transaction that made the change: while the old
 * triggers still run, the bot skips a version the trigger already kept in the same
 * transaction, which the index lets it find. Rows from before it was added have none.
 */
export const rowVersions = botSchema.table(
  "row_versions",
  {
    id: bigint("id", { mode: "number" })
      .notNull()
      .generatedAlwaysAsIdentity({ name: "row_versions_id_seq" }),
    sourceTable: text("source_table").notNull(),
    operation: text("operation").notNull(),
    rowId: text("row_id").notNull(),
    oldRow: jsonb("old_row").notNull(),
    changedAt: timestamptz("changed_at")
      .notNull()
      .default(sql`now()`),
    xid: text("xid").default(sql`pg_current_xact_id()::text`),
  },
  (t) => [
    primaryKey({ name: "row_versions_pkey", columns: [t.id] }),
    index("row_versions_change_idx").on(t.xid, t.sourceTable, t.rowId),
    check(
      "row_versions_operation_known",
      sql`${t.operation} = ANY (ARRAY['UPDATE'::text, 'DELETE'::text])`,
    ),
    index("row_versions_lookup_idx").on(
      t.sourceTable,
      t.rowId,
      t.id.desc().nullsFirst(),
    ),
  ],
);

export const guildConfig = botSchema.table(
  "guild_config",
  {
    guildId: discordId("guild_id").notNull(),
    officerRoleId: discordId("officer_role_id").notNull(),
    adminRoleId: discordId("admin_role_id").notNull(),
    timezone: text("timezone").notNull().default("America/New_York"),
    remindersEnabled: boolean("reminders_enabled").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    eboardRoleId: discordId("eboard_role_id"),
    eventsCommitteeRoleId: discordId("events_committee_role_id"),
    treasuryRoleId: discordId("treasury_role_id"),
    marketingRoleId: discordId("marketing_role_id"),
  },
  (t) => [
    primaryKey({ name: "guild_config_pkey", columns: [t.guildId] }),
    check(
      "guild_config_admin_not_everyone",
      sql`(${t.adminRoleId})::text <> (${t.guildId})::text`,
    ),
    check(
      "guild_config_eboard_not_everyone",
      sql`(${t.eboardRoleId})::text <> (${t.guildId})::text`,
    ),
    check(
      "guild_config_events_committee_not_everyone",
      sql`(${t.eventsCommitteeRoleId})::text <> (${t.guildId})::text`,
    ),
    check(
      "guild_config_marketing_not_everyone",
      sql`(${t.marketingRoleId})::text <> (${t.guildId})::text`,
    ),
    check(
      "guild_config_officer_not_everyone",
      sql`(${t.officerRoleId})::text <> (${t.guildId})::text`,
    ),
    check(
      "guild_config_treasury_not_everyone",
      sql`(${t.treasuryRoleId})::text <> (${t.guildId})::text`,
    ),
    check("guild_config_version_positive", sql`${t.version} >= 1`),
  ],
);

export const configAudit = botSchema.table(
  "config_audit",
  {
    id: bigint("id", { mode: "number" })
      .notNull()
      .generatedAlwaysAsIdentity({ name: "config_audit_id_seq" }),
    guildId: discordId("guild_id").notNull(),
    actorId: discordId("actor_id").notNull(),
    action: text("action").notNull(),
    oldValues: jsonb("old_values"),
    newValues: jsonb("new_values").notNull(),
    versionAfter: integer("version_after").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "config_audit_pkey", columns: [t.id] }),
    check(
      "config_audit_action_known",
      sql`${t.action} = ANY (ARRAY['role_bindings'::text, 'settings'::text])`,
    ),
    index("config_audit_guild_idx").on(t.guildId, t.id.desc().nullsFirst()),
    foreignKey({
      name: "config_audit_guild_id_fkey",
      columns: [t.guildId],
      foreignColumns: [guildConfig.guildId],
    }),
  ],
);

export const managedChannels = botSchema.table(
  "managed_channels",
  {
    guildId: discordId("guild_id").notNull(),
    channelId: discordId("channel_id").notNull(),
    status: managedChannelStatus("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: "managed_channels_pkey",
      columns: [t.guildId, t.channelId],
    }),
    foreignKey({
      name: "managed_channels_guild_id_fkey",
      columns: [t.guildId],
      foreignColumns: [guildConfig.guildId],
    }),
  ],
);

export const events = botSchema.table(
  "events",
  {
    id: uuid("id")
      .notNull()
      .default(sql`gen_random_uuid()`),
    guildId: discordId("guild_id").notNull(),
    channelId: discordId("channel_id").notNull(),
    name: text("name").notNull(),
    eventDate: date("event_date", { mode: "string" }).notNull(),
    threadId: discordId("thread_id"),
    overviewMessageId: discordId("overview_message_id"),
    status: eventStatus("status").notNull().default("active"),
    threadStatus: threadStatus("thread_status").notNull().default("pending"),
    createdBy: discordId("created_by").notNull(),
    deletedAt: timestamptz("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    postAttemptAt: timestamptz("post_attempt_at"),
    pickupTime: time("pickup_time"),
  },
  (t) => [
    primaryKey({ name: "events_pkey", columns: [t.id] }),
    unique("events_id_guild_unique").on(t.id, t.guildId),
    check(
      "events_event_date_range",
      sql`${t.eventDate} >= '2000-01-01'::date AND ${t.eventDate} <= '9999-12-31'::date`,
    ),
    check("events_name_length", sql`char_length(${t.name}) >= 1`),
    check(
      "events_thread_matches_status",
      sql`(${t.threadId} IS NULL) = (${t.threadStatus} = 'pending'::discord_bot.thread_status)`,
    ),
    index("events_channel_idx").on(t.guildId, t.channelId),
    // The task commands' lookup of a post's event, including deleted ones.
    index("events_by_thread_idx")
      .on(t.guildId, t.threadId)
      .where(sql`${t.threadId} IS NOT NULL`),
    // The event reminder run's read of live, active events by date, across guilds.
    index("events_open_by_date_idx")
      .on(t.status, t.eventDate)
      .where(sql`${t.deletedAt} IS NULL`),
    index("events_live_by_date_idx")
      .on(t.guildId, t.eventDate)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex("events_live_thread_uq")
      .on(t.threadId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.threadId} IS NOT NULL`),
    // /event create resumes an event still waiting for its post rather than making
    // another. This stops an officer's retry from racing their own insert that committed
    // after the bot gave up on it.
    uniqueIndex("events_one_pending_create_uq")
      .on(t.guildId, t.channelId, t.createdBy, t.name, t.eventDate)
      .where(
        sql`${t.deletedAt} IS NULL AND ${t.threadStatus} = 'pending'::discord_bot.thread_status`,
      ),
    foreignKey({
      name: "events_guild_id_channel_id_fkey",
      columns: [t.guildId, t.channelId],
      foreignColumns: [managedChannels.guildId, managedChannels.channelId],
    }),
  ],
);

export const eventSteps = botSchema.table(
  "event_steps",
  {
    eventId: uuid("event_id").notNull(),
    guildId: discordId("guild_id").notNull(),
    kind: eventStepKind("kind").notNull(),
    status: taskStatus("status").notNull().default("open"),
    completedAt: timestamptz("completed_at"),
    completedBy: discordId("completed_by"),
    handoffClaimedAt: timestamptz("handoff_claimed_at"),
    handoffSentAt: timestamptz("handoff_sent_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    notNeededAt: timestamptz("not_needed_at"),
    notNeededBy: discordId("not_needed_by"),
  },
  (t) => [
    primaryKey({ name: "event_steps_pkey", columns: [t.eventId, t.kind] }),
    check(
      "event_steps_completed_by_matches_status",
      sql`(${t.completedBy} IS NOT NULL) = (${t.status} = 'done'::discord_bot.task_status)`,
    ),
    check(
      "event_steps_completed_matches_status",
      sql`(${t.completedAt} IS NOT NULL) = (${t.status} = 'done'::discord_bot.task_status)`,
    ),
    check(
      "event_steps_handoff_only_when_done",
      sql`${t.handoffClaimedAt} IS NULL OR (${t.status} = 'done'::discord_bot.task_status AND ${t.kind} <> 'food_pickup'::discord_bot.event_step_kind)`,
    ),
    check(
      "event_steps_handoff_sent_after_claim",
      sql`${t.handoffSentAt} IS NULL OR ${t.handoffClaimedAt} IS NOT NULL`,
    ),
    check(
      "event_steps_not_needed_together",
      sql`(${t.notNeededAt} IS NULL) = (${t.notNeededBy} IS NULL)`,
    ),
    check(
      "event_steps_not_needed_only_open_slides",
      sql`${t.notNeededAt} IS NULL OR (${t.kind} = 'slides'::discord_bot.event_step_kind AND ${t.status} = 'open'::discord_bot.task_status)`,
    ),
    foreignKey({
      name: "event_steps_event_id_guild_id_fkey",
      columns: [t.eventId, t.guildId],
      foreignColumns: [events.id, events.guildId],
    }),
  ],
);

export const eventStepAssignees = botSchema.table(
  "event_step_assignees",
  {
    id: uuid("id")
      .notNull()
      .default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").notNull(),
    guildId: discordId("guild_id").notNull(),
    kind: eventStepKind("kind").notNull(),
    userId: discordId("user_id").notNull(),
    assignedBy: discordId("assigned_by").notNull(),
    removedAt: timestamptz("removed_at"),
    removedBy: discordId("removed_by"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "event_step_assignees_pkey", columns: [t.id] }),
    // Budget approved has nobody on it, and Engage picture added is marked by the
    // Marketing role.
    check(
      "event_step_assignees_kind_assignable",
      sql`${t.kind} <> ALL (ARRAY['budget_approved', 'engage_picture']::discord_bot.event_step_kind[])`,
    ),
    check(
      "event_step_assignees_removed_together",
      sql`(${t.removedAt} IS NULL) = (${t.removedBy} IS NULL)`,
    ),
    index("event_step_assignees_by_user_idx")
      .on(t.guildId, t.userId)
      .where(sql`${t.removedAt} IS NULL`),
    uniqueIndex("event_step_assignees_live_uq")
      .on(t.eventId, t.kind, t.userId)
      .where(sql`${t.removedAt} IS NULL`),
    foreignKey({
      name: "event_step_assignees_event_id_guild_id_fkey",
      columns: [t.eventId, t.guildId],
      foreignColumns: [events.id, events.guildId],
    }),
  ],
);

export const eventReminderLog = botSchema.table(
  "event_reminder_log",
  {
    eventId: uuid("event_id").notNull(),
    kind: eventReminderKind("kind").notNull(),
    reminderDate: date("reminder_date", { mode: "string" }).notNull(),
    state: reminderState("state").notNull().default("claimed"),
    claimToken: uuid("claim_token")
      .notNull()
      .default(sql`gen_random_uuid()`),
    attempts: integer("attempts").notNull().default(1),
    claimedAt: timestamptz("claimed_at")
      .notNull()
      .default(sql`now()`),
    sentAt: timestamptz("sent_at"),
    messageId: discordId("message_id"),
  },
  (t) => [
    primaryKey({
      name: "event_reminder_log_pkey",
      columns: [t.eventId, t.kind, t.reminderDate],
    }),
    check("event_reminder_log_attempts_positive", sql`${t.attempts} >= 1`),
    check(
      "event_reminder_log_date_range",
      sql`${t.reminderDate} >= '2000-01-01'::date AND ${t.reminderDate} <= '9999-12-31'::date`,
    ),
    check(
      "event_reminder_log_message_only_when_sent",
      sql`${t.messageId} IS NULL OR ${t.state} = 'sent'::discord_bot.reminder_state`,
    ),
    check(
      "event_reminder_log_sent_at_matches_state",
      sql`(${t.sentAt} IS NOT NULL) = (${t.state} = 'sent'::discord_bot.reminder_state)`,
    ),
    index("event_reminder_log_open_claims_idx")
      .on(t.claimedAt)
      .where(sql`${t.state} = 'claimed'::discord_bot.reminder_state`),
    foreignKey({
      name: "event_reminder_log_event_id_fkey",
      columns: [t.eventId],
      foreignColumns: [events.id],
    }),
  ],
);

export const tasks = botSchema.table(
  "tasks",
  {
    id: uuid("id")
      .notNull()
      .default(sql`gen_random_uuid()`),
    eventId: uuid("event_id").notNull(),
    guildId: discordId("guild_id").notNull(),
    assigneeId: discordId("assignee_id").notNull(),
    description: text("description").notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    status: taskStatus("status").notNull().default("open"),
    completedAt: timestamptz("completed_at"),
    createdBy: discordId("created_by").notNull(),
    deletedAt: timestamptz("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "tasks_pkey", columns: [t.id] }),
    check(
      "tasks_completed_matches_status",
      sql`(${t.completedAt} IS NOT NULL) = (${t.status} = 'done'::discord_bot.task_status)`,
    ),
    check("tasks_description_length", sql`char_length(${t.description}) >= 1`),
    check(
      "tasks_due_date_range",
      sql`${t.dueDate} >= '2000-01-01'::date AND ${t.dueDate} <= '9999-12-31'::date`,
    ),
    index("tasks_by_creator_idx").on(t.guildId, t.createdBy, t.createdAt),
    index("tasks_event_idx").on(t.eventId),
    index("tasks_open_by_assignee_idx")
      .on(t.guildId, t.assigneeId, t.dueDate)
      .where(
        sql`${t.status} = 'open'::discord_bot.task_status AND ${t.deletedAt} IS NULL`,
      ),
    index("tasks_open_by_due_date_idx")
      .on(t.dueDate, t.guildId)
      .where(
        sql`${t.status} = 'open'::discord_bot.task_status AND ${t.deletedAt} IS NULL`,
      ),
    foreignKey({
      name: "tasks_event_id_guild_id_fkey",
      columns: [t.eventId, t.guildId],
      foreignColumns: [events.id, events.guildId],
    }),
  ],
);

export const reminderLog = botSchema.table(
  "reminder_log",
  {
    taskId: uuid("task_id").notNull(),
    kind: reminderKind("kind").notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    state: reminderState("state").notNull().default("claimed"),
    claimToken: uuid("claim_token")
      .notNull()
      .default(sql`gen_random_uuid()`),
    attempts: integer("attempts").notNull().default(1),
    claimedAt: timestamptz("claimed_at")
      .notNull()
      .default(sql`now()`),
    sentAt: timestamptz("sent_at"),
    messageId: discordId("message_id"),
    refusedAttempts: integer("refused_attempts").notNull().default(0),
  },
  (t) => [
    primaryKey({
      name: "reminder_log_pkey",
      columns: [t.taskId, t.kind, t.dueDate],
    }),
    check("reminder_log_attempts_positive", sql`${t.attempts} >= 1`),
    check(
      "reminder_log_due_date_range",
      sql`${t.dueDate} >= '2000-01-01'::date AND ${t.dueDate} <= '9999-12-31'::date`,
    ),
    check(
      "reminder_log_message_only_when_sent",
      sql`${t.messageId} IS NULL OR ${t.state} = 'sent'::discord_bot.reminder_state`,
    ),
    check(
      "reminder_log_refused_attempts_range",
      sql`${t.refusedAttempts} >= 0 AND ${t.refusedAttempts} <= ${t.attempts}`,
    ),
    check(
      "reminder_log_sent_at_matches_state",
      sql`(${t.sentAt} IS NOT NULL) = (${t.state} = 'sent'::discord_bot.reminder_state)`,
    ),
    index("reminder_log_open_claims_idx")
      .on(t.claimedAt)
      .where(sql`${t.state} = 'claimed'::discord_bot.reminder_state`),
    foreignKey({
      name: "reminder_log_task_id_fkey",
      columns: [t.taskId],
      foreignColumns: [tasks.id],
    }),
  ],
);

export const taskReassignments = botSchema.table(
  "task_reassignments",
  {
    id: bigint("id", { mode: "number" })
      .notNull()
      .generatedAlwaysAsIdentity({ name: "task_reassignments_id_seq" }),
    guildId: discordId("guild_id").notNull(),
    actorId: discordId("actor_id").notNull(),
    taskId: uuid("task_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "task_reassignments_pkey", columns: [t.id] }),
    index("task_reassignments_by_actor_idx").on(
      t.guildId,
      t.actorId,
      t.createdAt,
    ),
    foreignKey({
      name: "task_reassignments_guild_id_fkey",
      columns: [t.guildId],
      foreignColumns: [guildConfig.guildId],
    }),
    foreignKey({
      name: "task_reassignments_task_id_fkey",
      columns: [t.taskId],
      foreignColumns: [tasks.id],
    }),
  ],
);

/**
 * Lets a mutating handler run once per Discord interaction, even if the request is
 * delivered or retried more than once. An interaction's token lasts 15 minutes, so a
 * row is only useful for about that long. The daily cron deletes rows older than a day.
 */
export const interactionClaims = botSchema
  .table(
    "interaction_claims",
    {
      interactionId: discordId("interaction_id").notNull(),
      claimedAt: timestamptz("claimed_at")
        .notNull()
        .default(sql`now()`),
    },
    (t) => [
      primaryKey({
        name: "interaction_claims_pkey",
        columns: [t.interactionId],
      }),
      // bot_app may read and add claims, and delete only those past a day: what the daily
      // expiry removes. The table's owner is not subject to row-level security.
      pgPolicy("interaction_claims_read", {
        as: "permissive",
        for: "select",
        to: botApp,
        using: sql`true`,
      }),
      pgPolicy("interaction_claims_insert", {
        as: "permissive",
        for: "insert",
        to: botApp,
        withCheck: sql`true`,
      }),
      pgPolicy("interaction_claims_expire", {
        as: "permissive",
        for: "delete",
        to: botApp,
        using: sql`${t.claimedAt} < now() - interval '1 day'`,
      }),
    ],
  )
  .enableRLS();

export const jobRuns = botSchema.table(
  "job_runs",
  {
    id: uuid("id")
      .notNull()
      .default(sql`gen_random_uuid()`),
    jobName: text("job_name").notNull(),
    status: jobRunStatus("status").notNull().default("running"),
    startedAt: timestamptz("started_at")
      .notNull()
      .default(sql`now()`),
    heartbeatAt: timestamptz("heartbeat_at")
      .notNull()
      .default(sql`now()`),
    finishedAt: timestamptz("finished_at"),
    results: jsonb("results")
      .notNull()
      .default(sql`'{}'::jsonb`),
    error: text("error"),
  },
  (t) => [
    primaryKey({ name: "job_runs_pkey", columns: [t.id] }),
    check("job_runs_error_size", sql`char_length(${t.error}) <= 4000`),
    check(
      "job_runs_finished_matches_status",
      sql`(${t.finishedAt} IS NULL) = (${t.status} = 'running'::discord_bot.job_run_status)`,
    ),
    check(
      "job_runs_job_name_length",
      sql`char_length(${t.jobName}) >= 1 AND char_length(${t.jobName}) <= 64`,
    ),
    check(
      "job_runs_results_size",
      sql`char_length((${t.results})::text) <= 16000`,
    ),
    index("job_runs_latest_idx").on(t.jobName, t.startedAt.desc().nullsFirst()),
    uniqueIndex("job_runs_one_running_idx")
      .on(t.jobName)
      .where(sql`${t.status} = 'running'::discord_bot.job_run_status`),
  ],
);

export const setupDrafts = botSchema.table(
  "setup_drafts",
  {
    guildId: discordId("guild_id").notNull(),
    actorId: discordId("actor_id").notNull(),
    officerRoleId: discordId("officer_role_id").notNull(),
    adminRoleId: discordId("admin_role_id").notNull(),
    eboardRoleId: discordId("eboard_role_id").notNull(),
    eventsCommitteeRoleId: discordId("events_committee_role_id").notNull(),
    treasuryRoleId: discordId("treasury_role_id").notNull(),
    marketingRoleId: discordId("marketing_role_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "setup_drafts_pkey", columns: [t.guildId] }),
    check(
      "setup_drafts_admin_not_everyone",
      sql`(${t.adminRoleId})::text <> (${t.guildId})::text`,
    ),
    check(
      "setup_drafts_eboard_not_everyone",
      sql`(${t.eboardRoleId})::text <> (${t.guildId})::text`,
    ),
    check(
      "setup_drafts_events_committee_not_everyone",
      sql`(${t.eventsCommitteeRoleId})::text <> (${t.guildId})::text`,
    ),
    check(
      "setup_drafts_fingerprint_shape",
      sql`${t.fingerprint} ~ '^[A-Za-z0-9_-]{8,64}$'::text`,
    ),
    check(
      "setup_drafts_marketing_not_everyone",
      sql`(${t.marketingRoleId})::text <> (${t.guildId})::text`,
    ),
    check(
      "setup_drafts_officer_not_everyone",
      sql`(${t.officerRoleId})::text <> (${t.guildId})::text`,
    ),
    check(
      "setup_drafts_treasury_not_everyone",
      sql`(${t.treasuryRoleId})::text <> (${t.guildId})::text`,
    ),
  ],
);
