import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "../../src/db/client.ts";
import type { DbResult } from "../../src/db/errors.ts";
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
  markEventThreadMissing,
  searchEvents,
  setEventOverviewMessage,
  setEventThread,
  softDeleteEvent,
} from "../../src/db/events.ts";
import {
  assignEventStep,
  claimEventReminder,
  claimStepHandoff,
  completeEventStep,
  getEventWorkflow,
  listEventReminderCandidates,
  listEventWorkflows,
  listOpenStepsForUser,
  listStaleEventReminderClaims,
  markEventReminderSent,
  markEventReminderSkipped,
  markStepHandoffSent,
  MAX_ASSIGNEES_PER_STEP,
  MAX_FOOD_PICKUP_ASSIGNEES,
  reclaimEventReminder,
  setEventPickupTime,
  unassignEventStep,
} from "../../src/db/event-steps.ts";
import {
  applyConfigChange,
  applyRoleBindings,
  getGuildConfig,
  getSetupDraft,
  listRecentConfigChanges,
  saveSetupDraft,
} from "../../src/db/guild-config.ts";
import {
  claimInteraction,
  expireInteractionClaims,
} from "../../src/db/interaction-claims.ts";
import {
  findEventByThread,
  findEventEverOnThread,
  searchOpenEvents,
  searchOpenEventsByIdPrefix,
} from "../../src/db/task-events.ts";
import {
  finishJobRun,
  getLatestJobRun,
  getLatestSucceededJobRun,
  beginJobRun,
} from "../../src/db/job-runs.ts";
import {
  getManagedChannel,
  listActiveManagedChannels,
  listManagedChannels,
  listManagedChannelsByIds,
  listRecentEventsInChannel,
  markChannelUnavailable,
} from "../../src/db/managed-channels.ts";
import {
  claimReminder,
  listReminderCandidates,
  listStaleClaims,
  markReminderSent,
  markReminderSkipped,
  reclaimReminder,
  resolveStaleClaim,
} from "../../src/db/reminders.ts";
import {
  countOpenTasksInChannel,
  MAX_TASK_ACTIONS_PER_OFFICER_PER_DAY,
  MAX_TASKS_PER_EVENT,
  createTask,
  editTask,
  searchOpenTasksByIdPrefix,
  searchOwnOpenTasksByIdPrefix,
  softDeleteTaskIfUnchanged,
  getTask,
  listEventTasks,
  listOpenTasksForAssignee,
  markOwnTaskDone,
  markTaskDoneAsOfficer,
  searchLiveTasks,
  searchLiveTasksByIdPrefix,
  searchOpenTasks,
  searchOwnOpenTasks,
  softDeleteTask,
} from "../../src/db/tasks.ts";
import type { Actor } from "../../src/lib/actor.ts";
import {
  parseIsoDate,
  todayInZone,
  type DateOnly,
} from "../../src/lib/dates.ts";
import { authorize } from "../../src/lib/permissions.ts";
import { openBackend, type Backend } from "./backend.ts";
import {
  insertEvent,
  insertGuild,
  insertTask,
  withoutQuotas,
  type GuildFixture,
} from "./fixtures.ts";
import {
  errorCodeOf,
  MIGRATION_OWNER,
  fakeId,
  queryAs,
  type Connection,
} from "./harness.ts";
import {
  reassignAs,
  reassignTask,
  setTaskDescription,
  setTaskDueDate,
} from "./task-edits.ts";

function date(value: string): DateOnly {
  const parsed = parseIsoDate(value);
  if (parsed === null) throw new Error("bad test date");
  return parsed;
}

function unwrap<T>(result: DbResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

const NOW = new Date("2030-01-01T12:00:00.000Z");
const DUE = date("2030-01-10");
const UNKNOWN_ID = "99999999-9999-4999-8999-999999999999";
const NOT_FOUND = {
  ok: false,
  error: { category: "not_found", code: null },
} as const;

describe("database layer against the real schema", () => {
  let backend: Backend;
  let pg: Connection;
  let db: DbClient;
  let guild: GuildFixture;

  beforeAll(async () => {
    backend = await openBackend();
    pg = backend.connection;
    db = backend.db;
    guild = await insertGuild(pg);
  });

  afterAll(async () => {
    await backend.close();
  });

  const taskState = async (taskId: string) => {
    const { rows } = await pg.query<{
      status: string;
      assignee_id: string;
      deleted: boolean;
      description: string;
      due_date: string;
    }>(
      `SELECT status, assignee_id, deleted_at IS NOT NULL AS deleted, description,
              due_date::text AS due_date
       FROM public.tasks WHERE id = $1`,
      [taskId],
    );
    return rows[0];
  };

  const eventState = async (eventId: string) => {
    const { rows } = await pg.query<{
      thread_status: string;
      overview_message_id: string | null;
      deleted: boolean;
    }>(
      `SELECT thread_status, overview_message_id, deleted_at IS NOT NULL AS deleted
       FROM public.events WHERE id = $1`,
      [eventId],
    );
    return rows[0];
  };

  /** The version an edit must name: the updated_at the caller last read. */
  const versionOf = async (guildId: string, taskId: string) => {
    const row = unwrap(await getTask(db, { guildId, taskId }));
    if (row === null) throw new Error("expected a live task");
    // PGlite's clock has millisecond resolution, so wait until a new write would get a
    // new version. Otherwise a write in the same millisecond leaves this one still valid.
    for (;;) {
      const { rows } = await pg.query<{ moved: boolean }>(
        "SELECT clock_timestamp() > $1::timestamptz AS moved",
        [row.updated_at],
      );
      if (rows[0]?.moved === true) break;
    }
    return row.updated_at;
  };

  /** Deletes an event but not its tasks, which the bot's role has no way to do. */
  const deleteEventOnly = (eventId: string) =>
    queryAs(
      pg,
      MIGRATION_OWNER,
      `UPDATE public.events SET deleted_at = now() WHERE id = $1`,
      [eventId],
    );

  const linkThread = async (guildId: string, eventId: string) => {
    const threadId = fakeId();
    unwrap(await setEventThread(db, { guildId, eventId, threadId }));
    return threadId;
  };

  describe("config", () => {
    it("sets up a guild, reads it back and refuses a stale version", async () => {
      const guildId = fakeId();
      const officerRoleId = fakeId();
      const adminRoleId = fakeId();
      const actorId = fakeId();
      const treasuryRoleId = fakeId();
      const bindings = {
        guildId,
        actorId,
        expectedVersion: 0,
        officerRoleId,
        adminRoleId,
        eboardRoleId: null,
        eventsCommitteeRoleId: null,
        treasuryRoleId,
        marketingRoleId: null,
      };

      expect(unwrap(await getGuildConfig(db, { guildId }))).toBeNull();
      expect(unwrap(await applyRoleBindings(db, bindings))).toBe(1);
      expect(unwrap(await getGuildConfig(db, { guildId }))).toEqual({
        guild_id: guildId,
        officer_role_id: officerRoleId,
        admin_role_id: adminRoleId,
        eboard_role_id: null,
        events_committee_role_id: null,
        treasury_role_id: treasuryRoleId,
        marketing_role_id: null,
        timezone: "America/New_York",
        reminders_enabled: true,
        version: 1,
      });
      expect(await applyRoleBindings(db, bindings)).toEqual({
        ok: false,
        error: { category: "stale_version", code: "CF409" },
      });
    });

    it("applies a change, writes audit rows and lists them newest first", async () => {
      const own = await insertGuild(pg);
      const actorId = fakeId();
      expect(
        unwrap(
          await applyConfigChange(db, {
            guildId: own.guildId,
            actorId,
            expectedVersion: 2,
            remindersEnabled: false,
            addChannelIds: [fakeId()],
            removeChannelIds: [],
            timezone: "Europe/London",
          }),
        ),
      ).toBe(3);

      expect(
        unwrap(await getGuildConfig(db, { guildId: own.guildId })),
      ).toMatchObject({
        reminders_enabled: false,
        timezone: "Europe/London",
      });

      const { rows, truncated } = unwrap(
        await listRecentConfigChanges(db, { guildId: own.guildId }),
      );
      expect(truncated).toBe(false);
      expect(rows.map((row) => row.version_after)).toEqual([3, 2, 1]);
      expect(rows[0]).toMatchObject({ actor_id: actorId, action: "settings" });
      expect(rows[2]?.old_values).toBeNull();
    });

    it("lists only the latest five changes, and says there were more", async () => {
      const own = await insertGuild(pg);
      for (let version = 2; version < 8; version += 1) {
        unwrap(
          await applyConfigChange(db, {
            guildId: own.guildId,
            actorId: fakeId(),
            expectedVersion: version,
            remindersEnabled: version % 2 === 0,
            addChannelIds: [],
            removeChannelIds: [],
            timezone: null,
          }),
        );
      }
      const { rows, truncated } = unwrap(
        await listRecentConfigChanges(db, { guildId: own.guildId }),
      );
      expect(rows.map((row) => row.version_after)).toEqual([8, 7, 6, 5, 4]);
      expect(truncated).toBe(true);
    });

    it("reports an unknown timezone with a code and no text", async () => {
      const own = await insertGuild(pg);
      expect(
        await applyConfigChange(db, {
          guildId: own.guildId,
          actorId: fakeId(),
          expectedVersion: 2,
          remindersEnabled: null,
          addChannelIds: [],
          removeChannelIds: [],
          timezone: "america/new_york",
        }),
      ).toEqual({
        ok: false,
        error: { category: "constraint", code: "22023" },
      });
    });

    it("gives authorize() the rows it needs, straight from a read", async () => {
      const own = await insertGuild(pg);
      const eventId = await insertEvent(pg, own);
      const assigneeId = fakeId();
      const taskId = await insertTask(pg, own, eventId, assigneeId);
      const config = unwrap(await getGuildConfig(db, { guildId: own.guildId }));
      const task = unwrap(await getTask(db, { guildId: own.guildId, taskId }));
      const actor = (userId: string, roleId?: string): Actor => ({
        userId,
        guildId: own.guildId,
        roleIds: new Set(roleId === undefined ? [] : [roleId]),
        isAdministrator: false,
      });

      expect(
        authorize("task.done", actor(assigneeId), config, task).allowed,
      ).toBe(true);
      expect(
        authorize("task.done", actor(fakeId()), config, task).allowed,
      ).toBe(false);
      expect(
        authorize("task.edit", actor(fakeId(), own.officerRoleId), config, task)
          .allowed,
      ).toBe(true);
    });
  });

  describe("managed channels", () => {
    it("reads channels by guild and refuses to see another guild's", async () => {
      const own = await insertGuild(pg);
      const other = await insertGuild(pg);
      expect(
        unwrap(
          await getManagedChannel(db, {
            guildId: own.guildId,
            channelId: own.channelId,
          }),
        ),
      ).toEqual({
        guild_id: own.guildId,
        channel_id: own.channelId,
        status: "active",
      });
      expect(
        unwrap(
          await getManagedChannel(db, {
            guildId: own.guildId,
            channelId: other.channelId,
          }),
        ),
      ).toBeNull();
      expect(
        unwrap(
          await listManagedChannels(db, { guildId: own.guildId }),
        ).rows.map((row) => row.channel_id),
      ).toEqual([own.channelId]);
      expect(
        unwrap(
          await listManagedChannelsByIds(db, {
            guildId: own.guildId,
            channelIds: [own.channelId, other.channelId],
          }),
        ).rows.map((row) => row.channel_id),
      ).toEqual([own.channelId]);
    });

    it("lists only the channels asked for, leaving out others in the guild", async () => {
      const own = await insertGuild(pg);
      const second = fakeId();
      unwrap(
        await applyConfigChange(db, {
          guildId: own.guildId,
          actorId: fakeId(),
          expectedVersion: 2,
          remindersEnabled: null,
          addChannelIds: [second],
          removeChannelIds: [],
          timezone: null,
        }),
      );
      const { rows } = unwrap(
        await listManagedChannelsByIds(db, {
          guildId: own.guildId,
          channelIds: [second],
        }),
      );
      expect(rows.map((row) => row.channel_id)).toEqual([second]);
    });

    it("marks a channel unavailable once", async () => {
      const own = await insertGuild(pg);
      const key = { guildId: own.guildId, channelId: own.channelId };
      expect(unwrap(await markChannelUnavailable(db, key))).toBe(true);
      expect(unwrap(await markChannelUnavailable(db, key))).toBe(false);
      expect(unwrap(await getManagedChannel(db, key))?.status).toBe(
        "unavailable",
      );
    });
  });

  describe("interaction claims", () => {
    it("is true once for each interaction", async () => {
      const interactionId = fakeId();
      expect(unwrap(await claimInteraction(db, { interactionId }))).toBe(true);
      expect(unwrap(await claimInteraction(db, { interactionId }))).toBe(false);
    });

    it("lets only one of two simultaneous claims win", async () => {
      const interactionId = fakeId();
      const results = await Promise.all([
        claimInteraction(db, { interactionId }),
        claimInteraction(db, { interactionId }),
      ]);
      expect(results.map(unwrap).sort()).toEqual([false, true]);
    });
  });

  describe("events", () => {
    const newEvent = (name = "Social", own: GuildFixture = guild) =>
      createEvent(db, {
        guildId: own.guildId,
        channelId: own.channelId,
        actorId: fakeId(),
        name,
        eventDate: DUE,
      });

    it("creates and reads an event", async () => {
      const event = unwrap(await newEvent());
      expect(event).toMatchObject({
        name: "Social",
        event_date: DUE,
        status: "active",
        thread_status: "pending",
        thread_id: null,
        deleted_at: null,
      });
      expect(
        unwrap(
          await getEvent(db, { guildId: guild.guildId, eventId: event.id }),
        ),
      ).toEqual(event);
    });

    it("refuses a second create by the same officer while the first waits for its post", async () => {
      const create = (actorId: string) =>
        createEvent(db, {
          guildId: guild.guildId,
          channelId: guild.channelId,
          actorId,
          name: "Retried",
          eventDate: DUE,
        });
      const officer = fakeId();
      const first = unwrap(await create(officer));
      expect(await create(officer)).toEqual({
        ok: false,
        error: { category: "conflict", code: "23505" },
      });

      unwrap(
        await attachEventPost(db, {
          guildId: guild.guildId,
          eventId: first.id,
          threadId: fakeId(),
          overviewMessageId: fakeId(),
        }),
      );
      expect((await create(officer)).ok).toBe(true);
    });

    it("attaches a post and its overview to a pending event in one write", async () => {
      const event = unwrap(await newEvent("One write"));
      const key = { guildId: guild.guildId, eventId: event.id };
      const threadId = fakeId();
      const overviewMessageId = fakeId();

      expect(
        unwrap(
          await attachEventPost(db, { ...key, threadId, overviewMessageId }),
        ),
      ).toMatchObject({
        thread_id: threadId,
        overview_message_id: overviewMessageId,
        thread_status: "active",
      });
      expect(
        await attachEventPost(db, {
          ...key,
          threadId: fakeId(),
          overviewMessageId: fakeId(),
        }),
      ).toEqual(NOT_FOUND);
    });

    it("attaches no post to a deleted event or one in another guild", async () => {
      const deleted = unwrap(await newEvent("Gone"));
      const key = { guildId: guild.guildId, eventId: deleted.id };
      unwrap(await softDeleteEvent(db, key));
      const post = { threadId: fakeId(), overviewMessageId: fakeId() };
      const foreign = await insertEvent(pg, await insertGuild(pg));

      expect(await attachEventPost(db, { ...key, ...post })).toEqual(NOT_FOUND);
      expect(
        await attachEventPost(db, {
          guildId: guild.guildId,
          eventId: foreign,
          ...post,
        }),
      ).toEqual(NOT_FOUND);
    });

    describe("the post attempt", () => {
      const attemptAgo = (eventId: string, seconds: number) =>
        pg.query(
          `UPDATE public.events
           SET post_attempt_at = now() - make_interval(secs => $2)
           WHERE id = $1`,
          [eventId, seconds],
        );

      it("goes to one caller, and comes free again after a minute", async () => {
        const event = unwrap(await newEvent("Attempted"));
        const key = { guildId: guild.guildId, eventId: event.id };

        expect(unwrap(await claimEventPostAttempt(db, key))).toBe(true);
        expect(unwrap(await claimEventPostAttempt(db, key))).toBe(false);

        await attemptAgo(event.id, 59);
        expect(unwrap(await claimEventPostAttempt(db, key))).toBe(false);

        await attemptAgo(event.id, 61);
        expect(unwrap(await claimEventPostAttempt(db, key))).toBe(true);
      });

      it("can be given back", async () => {
        const event = unwrap(await newEvent("Given back"));
        const key = { guildId: guild.guildId, eventId: event.id };
        unwrap(await claimEventPostAttempt(db, key));

        expect(unwrap(await releaseEventPostAttempt(db, key))).toBe(true);
        expect(unwrap(await claimEventPostAttempt(db, key))).toBe(true);
      });

      it("is refused once the event has a post, or is deleted", async () => {
        const posted = unwrap(await newEvent("Has post"));
        const postedKey = { guildId: guild.guildId, eventId: posted.id };
        unwrap(await setEventThread(db, { ...postedKey, threadId: fakeId() }));
        const gone = unwrap(await newEvent("Gone"));
        const goneKey = { guildId: guild.guildId, eventId: gone.id };
        unwrap(await softDeleteEvent(db, goneKey));

        expect(unwrap(await claimEventPostAttempt(db, postedKey))).toBe(false);
        expect(unwrap(await releaseEventPostAttempt(db, postedKey))).toBe(
          false,
        );
        expect(unwrap(await claimEventPostAttempt(db, goneKey))).toBe(false);
      });

      it("is refused for another guild's event", async () => {
        const event = unwrap(await newEvent("Theirs"));
        const other = await insertGuild(pg);

        expect(
          unwrap(
            await claimEventPostAttempt(db, {
              guildId: other.guildId,
              eventId: event.id,
            }),
          ),
        ).toBe(false);
      });
    });

    it("lists active events first at the cap, then the latest dates", async () => {
      const own = await insertGuild(pg);
      await pg.query(
        `INSERT INTO public.events
           (guild_id, channel_id, name, event_date, created_by, status)
         SELECT $1::text, $2::text, 'Old ' || n, date '2030-01-15', $3::text, 'closed'
         FROM generate_series(1, 101) AS n`,
        [own.guildId, own.channelId, fakeId()],
      );
      const live = unwrap(await newEvent("Live", own));

      const { rows, truncated } = unwrap(
        await listEvents(db, { guildId: own.guildId }),
      );

      expect(rows[0]?.id).toBe(live.id);
      expect(rows).toHaveLength(100);
      expect(truncated).toBe(true);

      const found = unwrap(
        await searchEvents(db, { guildId: own.guildId, term: "" }),
      );
      expect(found[0]?.id).toBe(live.id);
    });

    it("creates an event already attached to a post, once per live post", async () => {
      const threadId = fakeId();
      const linked = () =>
        createLinkedEvent(db, {
          guildId: guild.guildId,
          channelId: guild.channelId,
          actorId: fakeId(),
          name: "Linked",
          eventDate: DUE,
          threadId,
        });
      const first = unwrap(await linked());

      expect(first).toMatchObject({
        thread_id: threadId,
        thread_status: "active",
        overview_message_id: null,
      });
      expect(await linked()).toEqual({
        ok: false,
        error: { category: "conflict", code: "23505" },
      });

      unwrap(
        await softDeleteEvent(db, {
          guildId: guild.guildId,
          eventId: first.id,
        }),
      );
      expect(unwrap(await linked()).thread_id).toBe(threadId);
    });

    it("finds an event by its thread, only live and only in this guild", async () => {
      const event = unwrap(await newEvent("By thread"));
      const key = { guildId: guild.guildId, eventId: event.id };
      const threadId = fakeId();
      unwrap(await setEventThread(db, { ...key, threadId }));
      const byThread = (guildId: string) =>
        findEventByThread(db, { guildId, threadId });

      expect(unwrap(await byThread(guild.guildId))?.id).toBe(event.id);
      expect(
        unwrap(await byThread((await insertGuild(pg)).guildId)),
      ).toBeNull();

      unwrap(await softDeleteEvent(db, key));
      expect(unwrap(await byThread(guild.guildId))).toBeNull();
    });

    it("finds live events by exact name and date in one forum", async () => {
      const own = await insertGuild(pg);
      const wanted = unwrap(await newEvent("Exact,name.eq.x", own));
      unwrap(await newEvent("Exact", own));
      const gone = unwrap(await newEvent("Exact,name.eq.x", own));
      unwrap(
        await softDeleteEvent(db, { guildId: own.guildId, eventId: gone.id }),
      );

      const named = await listEventsNamed(db, {
        guildId: own.guildId,
        channelId: own.channelId,
        name: "Exact,name.eq.x",
        eventDate: DUE,
      });

      expect(unwrap(named).map((row) => row.id)).toEqual([wanted.id]);
    });

    it("refuses an event on a removed channel with the fixed category", async () => {
      const own = await insertGuild(pg);
      await queryAs(
        pg,
        MIGRATION_OWNER,
        `UPDATE public.managed_channels SET status = 'removed' WHERE guild_id = $1`,
        [own.guildId],
      );
      expect(await newEvent("Social", own)).toEqual({
        ok: false,
        error: { category: "parent_unavailable", code: "CF410" },
      });
    });

    it("answers the same for another guild's ID as for an unknown one", async () => {
      const other = await insertGuild(pg);
      const foreign = await insertEvent(pg, other);
      const unknown = await getEvent(db, {
        guildId: guild.guildId,
        eventId: UNKNOWN_ID,
      });
      expect(
        await getEvent(db, { guildId: guild.guildId, eventId: foreign }),
      ).toEqual(unknown);

      const writes = (eventId: string) =>
        Promise.all([
          closeEvent(db, { guildId: guild.guildId, eventId }),
          softDeleteEvent(db, { guildId: guild.guildId, eventId }),
          setEventThread(db, {
            guildId: guild.guildId,
            eventId,
            threadId: fakeId(),
          }),
        ]);
      expect(await writes(foreign)).toEqual(await writes(UNKNOWN_ID));
      expect(await writes(foreign)).toEqual([NOT_FOUND, NOT_FOUND, NOT_FOUND]);
      expect(
        unwrap(await getEvent(db, { guildId: other.guildId, eventId: foreign }))
          ?.status,
      ).toBe("active");
    });

    it("lists only this guild's events", async () => {
      const own = await insertGuild(pg);
      const other = await insertGuild(pg);
      const mine = unwrap(await newEvent("Mine", own)).id;
      unwrap(await newEvent("Theirs", other));
      const { rows } = unwrap(await listEvents(db, { guildId: own.guildId }));
      expect(rows.map((row) => row.id)).toEqual([mine]);
    });

    it("caps the list at 100 and says there were more", async () => {
      const own = await insertGuild(pg);
      await pg.query(
        `INSERT INTO public.events (guild_id, channel_id, name, event_date, created_by)
         SELECT $1::text, $2::text, 'Bulk ' || n, date '2030-01-15', $3::text
         FROM generate_series(1, 101) AS n`,
        [own.guildId, own.channelId, fakeId()],
      );
      const { rows, truncated } = unwrap(
        await listEvents(db, { guildId: own.guildId }),
      );
      expect(rows).toHaveLength(100);
      expect(truncated).toBe(true);
      const ids = rows.map((row) => row.id);
      expect(ids).toEqual([...ids].sort());
    });

    it("links a thread, marks it missing and links again", async () => {
      const key = {
        guildId: guild.guildId,
        eventId: unwrap(await newEvent()).id,
      };
      expect(await markEventThreadMissing(db, key)).toEqual(NOT_FOUND);

      const threadId = fakeId();
      expect(
        unwrap(await setEventThread(db, { ...key, threadId })),
      ).toMatchObject({ thread_id: threadId, thread_status: "active" });
      expect(await setEventThread(db, { ...key, threadId })).toEqual(NOT_FOUND);

      expect(unwrap(await markEventThreadMissing(db, key)).thread_status).toBe(
        "missing",
      );
      expect(
        unwrap(await setEventThread(db, { ...key, threadId: fakeId() }))
          .thread_status,
      ).toBe("active");
    });

    it("marks only the named event's thread missing", async () => {
      const own = await insertGuild(pg);
      const target = unwrap(await newEvent("Target", own)).id;
      const neighbour = unwrap(await newEvent("Neighbour", own)).id;
      await linkThread(own.guildId, target);
      await linkThread(own.guildId, neighbour);

      unwrap(
        await markEventThreadMissing(db, {
          guildId: own.guildId,
          eventId: target,
        }),
      );
      expect((await eventState(target))?.thread_status).toBe("missing");
      expect((await eventState(neighbour))?.thread_status).toBe("active");
    });

    it("refuses to mark a thread missing from another guild, or on a deleted event", async () => {
      const own = await insertGuild(pg);
      const other = await insertGuild(pg);
      const eventId = unwrap(await newEvent("Target", own)).id;
      await linkThread(own.guildId, eventId);

      expect(
        await markEventThreadMissing(db, { guildId: other.guildId, eventId }),
      ).toEqual(NOT_FOUND);
      expect((await eventState(eventId))?.thread_status).toBe("active");

      unwrap(await softDeleteEvent(db, { guildId: own.guildId, eventId }));
      expect(
        await markEventThreadMissing(db, { guildId: own.guildId, eventId }),
      ).toEqual(NOT_FOUND);
      expect((await eventState(eventId))?.thread_status).toBe("active");
    });

    it("refuses to link a thread to a deleted event", async () => {
      const own = await insertGuild(pg);
      const eventId = unwrap(await newEvent("Target", own)).id;
      unwrap(await softDeleteEvent(db, { guildId: own.guildId, eventId }));
      expect(
        await setEventThread(db, {
          guildId: own.guildId,
          eventId,
          threadId: fakeId(),
        }),
      ).toEqual(NOT_FOUND);
      expect((await eventState(eventId))?.thread_status).toBe("pending");
    });

    it("reports a thread already held by a live event as a conflict", async () => {
      const threadId = fakeId();
      unwrap(
        await setEventThread(db, {
          guildId: guild.guildId,
          eventId: unwrap(await newEvent()).id,
          threadId,
        }),
      );
      expect(
        await setEventThread(db, {
          guildId: guild.guildId,
          eventId: unwrap(await newEvent()).id,
          threadId,
        }),
      ).toEqual({
        ok: false,
        error: { category: "conflict", code: "23505" },
      });
    });

    it("sets the overview message and closes once", async () => {
      const key = {
        guildId: guild.guildId,
        eventId: unwrap(await newEvent()).id,
      };
      const messageId = fakeId();
      expect(
        unwrap(await setEventOverviewMessage(db, { ...key, messageId }))
          .overview_message_id,
      ).toBe(messageId);
      expect(unwrap(await closeEvent(db, key)).status).toBe("closed");
      expect(await closeEvent(db, key)).toEqual(NOT_FOUND);
    });

    it("refuses to set the overview from another guild, or on a deleted event", async () => {
      const own = await insertGuild(pg);
      const other = await insertGuild(pg);
      const eventId = unwrap(await newEvent("Target", own)).id;
      const messageId = fakeId();

      expect(
        await setEventOverviewMessage(db, {
          guildId: other.guildId,
          eventId,
          messageId,
        }),
      ).toEqual(NOT_FOUND);
      expect((await eventState(eventId))?.overview_message_id).toBeNull();

      unwrap(await softDeleteEvent(db, { guildId: own.guildId, eventId }));
      expect(
        await setEventOverviewMessage(db, {
          guildId: own.guildId,
          eventId,
          messageId,
        }),
      ).toEqual(NOT_FOUND);
      expect((await eventState(eventId))?.overview_message_id).toBeNull();
    });

    it("hides a soft-deleted event from reads and refuses writes to it", async () => {
      const key = {
        guildId: guild.guildId,
        eventId: unwrap(await newEvent("Deleted one")).id,
      };
      await insertTask(pg, guild, key.eventId);

      expect(unwrap(await softDeleteEvent(db, key))).toBe(1);
      expect(await softDeleteEvent(db, key)).toEqual(NOT_FOUND);
      expect(unwrap(await getEvent(db, key))).toBeNull();
      expect(await closeEvent(db, key)).toEqual(NOT_FOUND);

      const { rows } = unwrap(await listEvents(db, { guildId: guild.guildId }));
      expect(rows.map((row) => row.id)).not.toContain(key.eventId);
    });
  });

  describe("autocomplete", () => {
    let own: GuildFixture;

    const named = async (name: string) =>
      unwrap(
        await createEvent(db, {
          guildId: own.guildId,
          channelId: own.channelId,
          actorId: fakeId(),
          name,
          eventDate: DUE,
        }),
      ).id;

    const namesFor = async (term: string) =>
      unwrap(await searchEvents(db, { guildId: own.guildId, term })).map(
        (row) => row.name,
      );

    beforeAll(async () => {
      own = await insertGuild(pg);
      await named("Spring social");
      await named("Budget 100%");
      await named("snake_case meeting");
      await named("Back\\slash");
      await named('Quoted "name", (with) dots.');
    });

    it("matches part of a name, ignoring case", async () => {
      expect(await namesFor("SPRING")).toEqual(["Spring social"]);
    });

    it("treats % as a literal percent sign", async () => {
      expect(await namesFor("%")).toEqual(["Budget 100%"]);
    });

    it("treats _ as a literal underscore", async () => {
      expect(await namesFor("_")).toEqual(["snake_case meeting"]);
    });

    it("matches on the first 100 characters of a longer term", async () => {
      const long = await insertGuild(pg);
      unwrap(
        await createEvent(db, {
          guildId: long.guildId,
          channelId: long.channelId,
          actorId: fakeId(),
          name: "L".repeat(100),
          eventDate: DUE,
        }),
      );
      const rows = unwrap(
        await searchEvents(db, {
          guildId: long.guildId,
          term: "L".repeat(6000),
        }),
      );
      expect(rows.map((row) => row.name)).toEqual(["L".repeat(100)]);
    });

    it.each(["x\u0000y", "x\ud800y", "\udc00"])(
      "refuses %j as a term",
      async (term) => {
        expect(await searchEvents(db, { guildId: own.guildId, term })).toEqual({
          ok: false,
          error: { category: "invalid_input", code: null },
        });
      },
    );

    it("treats a backslash as a literal backslash", async () => {
      expect(await namesFor("\\")).toEqual(["Back\\slash"]);
    });

    it("matches * only as itself, never as a wildcard", async () => {
      expect(await namesFor("*")).toEqual([]);
      expect(await namesFor("S*g")).toEqual([]);
    });

    it.each([",", ")", ".", '"', '"name", (with'])(
      "finds %s as plain text",
      async (term) => {
        expect(await namesFor(term)).toEqual(['Quoted "name", (with) dots.']);
      },
    );

    it("does not let a filter in the term widen the result", async () => {
      expect(await namesFor("x,deleted_at.not.is.null")).toEqual([]);
      expect(await namesFor("x)&deleted_at=not.is.null")).toEqual([]);
    });

    it("returns every live name for an empty term, within the guild", async () => {
      const other = await insertGuild(pg);
      await insertEvent(pg, other);
      expect(await namesFor("")).toHaveLength(5);
    });

    it("leaves out deleted events and other guilds", async () => {
      const id = await named("Hidden event");
      const other = await insertGuild(pg);
      unwrap(
        await createEvent(db, {
          guildId: other.guildId,
          channelId: other.channelId,
          actorId: fakeId(),
          name: "Hidden event",
          eventDate: DUE,
        }),
      );
      expect(await namesFor("Hidden")).toEqual(["Hidden event"]);
      unwrap(await softDeleteEvent(db, { guildId: own.guildId, eventId: id }));
      expect(await namesFor("Hidden")).toEqual([]);
    });

    it("returns at most 25 choices", async () => {
      const crowded = await insertGuild(pg);
      await pg.query(
        `INSERT INTO public.events (guild_id, channel_id, name, event_date, created_by)
         SELECT $1::text, $2::text, 'Crowded ' || n, date '2030-01-15', $3::text
         FROM generate_series(1, 30) AS n`,
        [crowded.guildId, crowded.channelId, fakeId()],
      );
      const rows = unwrap(
        await searchEvents(db, { guildId: crowded.guildId, term: "Crowded" }),
      );
      expect(rows).toHaveLength(25);
    });

    describe("on tasks", () => {
      let taskGuild: GuildFixture;
      let otherGuild: GuildFixture;
      let eventId: string;
      let otherEventId: string;
      const mine = fakeId();
      const ids: Record<string, string> = {};

      const taskFor = async (
        assigneeId: string,
        description: string,
        where: { guildId: string; eventId: string } = {
          guildId: taskGuild.guildId,
          eventId,
        },
      ) =>
        unwrap(
          await createTask(db, {
            ...where,
            assigneeId,
            actorId: fakeId(),
            description,
            dueDate: DUE,
          }),
        ).id;

      beforeAll(async () => {
        taskGuild = await insertGuild(pg);
        otherGuild = await insertGuild(pg);
        eventId = await insertEvent(pg, taskGuild);
        otherEventId = await insertEvent(pg, otherGuild);

        ids.posters = await taskFor(mine, "Print posters");
        ids.flyers = await taskFor(fakeId(), "Print flyers");
        ids.booking = await taskFor(mine, "Book the room");
        ids.done = await taskFor(mine, "Print done");
        ids.deleted = await taskFor(mine, "Print deleted");
        ids.foreign = await taskFor(mine, "Print foreign", {
          guildId: otherGuild.guildId,
          eventId: otherEventId,
        });
        unwrap(
          await markTaskDoneAsOfficer(db, {
            guildId: taskGuild.guildId,
            taskId: ids.done,
            now: NOW,
          }),
        );
        unwrap(
          await softDeleteTask(db, {
            guildId: taskGuild.guildId,
            taskId: ids.deleted,
            now: NOW,
          }),
        );
      });

      it("searches the guild's open tasks by description, for officers", async () => {
        const rows = unwrap(
          await searchOpenTasks(db, {
            guildId: taskGuild.guildId,
            term: "print",
          }),
        );
        expect(rows.map((row) => row.description).sort()).toEqual([
          "Print flyers",
          "Print posters",
        ]);
      });

      it("searches one member's own open tasks in one guild", async () => {
        const rows = unwrap(
          await searchOwnOpenTasks(db, {
            guildId: taskGuild.guildId,
            assigneeId: mine,
            term: "print",
          }),
        );
        expect(rows.map((row) => row.id)).toEqual([ids.posters]);
      });
    });
  });

  describe("tasks", () => {
    let eventId: string;

    beforeAll(async () => {
      eventId = await insertEvent(pg, guild);
    });

    const newTask = async (assigneeId: string = fakeId()) => ({
      assigneeId,
      taskId: unwrap(
        await createTask(db, {
          guildId: guild.guildId,
          eventId,
          assigneeId,
          actorId: fakeId(),
          description: "Book the room",
          dueDate: DUE,
        }),
      ).id,
    });

    it("stores text with every hostile character intact", async () => {
      const { taskId } = await newTask();
      const description = `a,b).c"*%_\\ ' ; DROP TABLE tasks; -- \u{1F389}`;
      expect(
        unwrap(
          await setTaskDescription(db, {
            guildId: guild.guildId,
            taskId,
            expectedUpdatedAt: await versionOf(guild.guildId, taskId),
            description,
          }),
        ).description,
      ).toBe(description);
    });

    it("lets the assignee mark their task done", async () => {
      const { taskId, assigneeId } = await newTask();
      const done = unwrap(
        await markOwnTaskDone(db, {
          guildId: guild.guildId,
          taskId,
          assigneeId,
          now: NOW,
        }),
      );
      expect(done.status).toBe("done");
      expect(new Date(done.completed_at ?? "").toISOString()).toBe(
        NOW.toISOString(),
      );
    });

    it("marks only the named task done, not the assignee's others", async () => {
      const first = await newTask();
      const second = await newTask(first.assigneeId);
      unwrap(
        await markOwnTaskDone(db, {
          guildId: guild.guildId,
          taskId: first.taskId,
          assigneeId: first.assigneeId,
          now: NOW,
        }),
      );
      expect((await taskState(first.taskId))?.status).toBe("done");
      expect((await taskState(second.taskId))?.status).toBe("open");
    });

    it("refuses mark-done with the task's assignee but another guild", async () => {
      const other = await insertGuild(pg);
      const { taskId, assigneeId } = await newTask();
      expect(
        await markOwnTaskDone(db, {
          guildId: other.guildId,
          taskId,
          assigneeId,
          now: NOW,
        }),
      ).toEqual(NOT_FOUND);
      expect((await taskState(taskId))?.status).toBe("open");
    });

    it("changes nothing when someone else tries to mark it done", async () => {
      const { taskId, assigneeId } = await newTask();
      expect(
        await markOwnTaskDone(db, {
          guildId: guild.guildId,
          taskId,
          assigneeId: fakeId(),
          now: NOW,
        }),
      ).toEqual(NOT_FOUND);
      expect(await taskState(taskId)).toMatchObject({
        status: "open",
        assignee_id: assigneeId,
      });
    });

    it("stops mark-done when the task was reassigned after the check", async () => {
      const { taskId, assigneeId } = await newTask();
      const seen = unwrap(
        await getTask(db, { guildId: guild.guildId, taskId }),
      );
      expect(seen?.assignee_id).toBe(assigneeId);

      const newAssignee = fakeId();
      unwrap(
        await reassignTask(db, {
          guildId: guild.guildId,
          taskId,
          expectedUpdatedAt: seen?.updated_at ?? "",
          assigneeId: newAssignee,
        }),
      );

      expect(
        await markOwnTaskDone(db, {
          guildId: guild.guildId,
          taskId,
          assigneeId,
          now: NOW,
        }),
      ).toEqual(NOT_FOUND);
      expect(await taskState(taskId)).toMatchObject({
        status: "open",
        assignee_id: newAssignee,
      });
    });

    describe("simultaneous writes", () => {
      it("lets exactly one of two mark-done calls count", async () => {
        const { taskId, assigneeId } = await newTask();
        const key = { guildId: guild.guildId, taskId, assigneeId, now: NOW };
        const results = await Promise.all([
          markOwnTaskDone(db, key),
          markOwnTaskDone(db, key),
        ]);
        expect(results.filter((result) => result.ok)).toHaveLength(1);
        expect(results.filter((result) => !result.ok)).toEqual([NOT_FOUND]);
        expect((await taskState(taskId))?.status).toBe("done");
      });

      it("never lets the old assignee finish a task reassigned at the same moment", async () => {
        const { taskId, assigneeId } = await newTask();
        const newAssignee = fakeId();
        const expectedUpdatedAt = await versionOf(guild.guildId, taskId);
        const [done, moved] = await Promise.all([
          markOwnTaskDone(db, {
            guildId: guild.guildId,
            taskId,
            assigneeId,
            now: NOW,
          }),
          reassignTask(db, {
            guildId: guild.guildId,
            taskId,
            expectedUpdatedAt,
            assigneeId: newAssignee,
          }),
        ]);
        expect(done.ok && moved.ok).toBe(false);
        expect(done.ok || moved.ok).toBe(true);
        expect(await taskState(taskId)).toEqual(
          expect.objectContaining(
            done.ok
              ? { status: "done", assignee_id: assigneeId }
              : { status: "open", assignee_id: newAssignee },
          ),
        );
      });

      it("lets exactly one of two edits from the same version win", async () => {
        const { taskId } = await newTask();
        const expectedUpdatedAt = await versionOf(guild.guildId, taskId);
        const results = await Promise.all(
          ["First officer", "Second officer"].map((description) =>
            setTaskDescription(db, {
              guildId: guild.guildId,
              taskId,
              expectedUpdatedAt,
              description,
            }),
          ),
        );
        expect(results.filter((result) => result.ok)).toHaveLength(1);
        expect(results.filter((result) => !result.ok)).toEqual([NOT_FOUND]);
      });
    });

    it("refuses an edit based on an old version, keeping the later one", async () => {
      const { taskId } = await newTask();
      const key = { guildId: guild.guildId, taskId };
      const seen = await versionOf(guild.guildId, taskId);

      unwrap(
        await setTaskDescription(db, {
          ...key,
          expectedUpdatedAt: seen,
          description: "First officer's edit",
        }),
      );
      const stale = [
        setTaskDescription(db, {
          ...key,
          expectedUpdatedAt: seen,
          description: "Second officer's edit",
        }),
        setTaskDueDate(db, {
          ...key,
          expectedUpdatedAt: seen,
          dueDate: date("2031-01-01"),
        }),
        reassignTask(db, {
          ...key,
          expectedUpdatedAt: seen,
          assigneeId: fakeId(),
        }),
      ];
      expect(await Promise.all(stale)).toEqual(Array(3).fill(NOT_FOUND));
      expect(await taskState(taskId)).toMatchObject({
        description: "First officer's edit",
        due_date: DUE,
      });
    });

    it("lets edits follow one another using the new version", async () => {
      const { taskId } = await newTask();
      const first = unwrap(
        await setTaskDescription(db, {
          guildId: guild.guildId,
          taskId,
          expectedUpdatedAt: await versionOf(guild.guildId, taskId),
          description: "One",
        }),
      );
      const second = unwrap(
        await setTaskDueDate(db, {
          guildId: guild.guildId,
          taskId,
          expectedUpdatedAt: first.updated_at,
          dueDate: date("2031-01-01"),
        }),
      );
      expect(second).toMatchObject({
        description: "One",
        due_date: "2031-01-01",
      });
    });

    it("refuses reassign and due date changes from another guild, even with the right version", async () => {
      const other = await insertGuild(pg);
      const { taskId, assigneeId } = await newTask();
      const expectedUpdatedAt = await versionOf(guild.guildId, taskId);
      expect(
        await reassignTask(db, {
          guildId: other.guildId,
          taskId,
          expectedUpdatedAt,
          assigneeId: fakeId(),
        }),
      ).toEqual(NOT_FOUND);
      expect(
        await setTaskDueDate(db, {
          guildId: other.guildId,
          taskId,
          expectedUpdatedAt,
          dueDate: date("2031-01-01"),
        }),
      ).toEqual(NOT_FOUND);
      expect(await taskState(taskId)).toMatchObject({
        assignee_id: assigneeId,
        due_date: DUE,
      });
    });

    it("lets an officer finish a task only once, keeping the first time", async () => {
      const { taskId } = await newTask();
      const key = { guildId: guild.guildId, taskId };
      const first = unwrap(
        await markTaskDoneAsOfficer(db, { ...key, now: NOW }),
      );
      expect(
        await markTaskDoneAsOfficer(db, {
          ...key,
          now: new Date("2031-01-01T00:00:00.000Z"),
        }),
      ).toEqual(NOT_FOUND);
      expect(unwrap(await getTask(db, key))?.completed_at).toBe(
        first.completed_at,
      );
    });

    it("edits only the named task when another has the same version", async () => {
      // One statement gives both rows the same updated_at, so only the ID separates them.
      const assigneeId = fakeId();
      const { rows } = await pg.query<{ id: string }>(
        `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
         SELECT $1::uuid, $2::text, $3::text, 'Twin', date '2030-01-10', $3::text
         FROM generate_series(1, 4)
         RETURNING id`,
        [eventId, guild.guildId, assigneeId],
      );
      const [reassigned, redescribed, redated, neighbour] = rows.map(
        (row) => row.id,
      );
      if (
        reassigned === undefined ||
        redescribed === undefined ||
        redated === undefined ||
        neighbour === undefined
      ) {
        throw new Error("expected four tasks");
      }
      const expectedUpdatedAt = await versionOf(guild.guildId, neighbour);
      const edit = { guildId: guild.guildId, expectedUpdatedAt };

      unwrap(
        await reassignTask(db, {
          ...edit,
          taskId: reassigned,
          assigneeId: fakeId(),
        }),
      );
      unwrap(
        await setTaskDescription(db, {
          ...edit,
          taskId: redescribed,
          description: "Changed",
        }),
      );
      unwrap(
        await setTaskDueDate(db, {
          ...edit,
          taskId: redated,
          dueDate: date("2031-01-01"),
        }),
      );
      expect(await taskState(neighbour)).toEqual({
        status: "open",
        assignee_id: assigneeId,
        deleted: false,
        description: "Twin",
        due_date: DUE,
      });
    });

    it("refuses edits to a deleted task, even naming its current version", async () => {
      const { taskId, assigneeId } = await newTask();
      const key = { guildId: guild.guildId, taskId };
      unwrap(await softDeleteTask(db, { ...key, now: NOW }));
      const { rows } = await pg.query<{ version: string }>(
        `SELECT to_jsonb(updated_at) #>> '{}' AS version FROM public.tasks WHERE id = $1`,
        [taskId],
      );
      const edit = { ...key, expectedUpdatedAt: rows[0]?.version ?? "" };

      expect(await reassignTask(db, { ...edit, assigneeId: fakeId() })).toEqual(
        NOT_FOUND,
      );
      expect(
        await setTaskDescription(db, { ...edit, description: "x" }),
      ).toEqual(NOT_FOUND);
      expect(
        await setTaskDueDate(db, { ...edit, dueDate: date("2031-01-01") }),
      ).toEqual(NOT_FOUND);
      expect(await taskState(taskId)).toEqual({
        status: "open",
        assignee_id: assigneeId,
        deleted: true,
        description: "Book the room",
        due_date: DUE,
      });
    });

    it("refuses edits to a finished task", async () => {
      const { taskId } = await newTask();
      const key = { guildId: guild.guildId, taskId };
      const done = unwrap(
        await markTaskDoneAsOfficer(db, { ...key, now: NOW }),
      );
      const edit = { ...key, expectedUpdatedAt: done.updated_at };
      expect(await reassignTask(db, { ...edit, assigneeId: fakeId() })).toEqual(
        NOT_FOUND,
      );
      expect(
        await setTaskDescription(db, { ...edit, description: "x" }),
      ).toEqual(NOT_FOUND);
      expect(await setTaskDueDate(db, { ...edit, dueDate: DUE })).toEqual(
        NOT_FOUND,
      );
    });

    it("answers the same for another guild's task as for an unknown one", async () => {
      const other = await insertGuild(pg);
      const foreign = await insertTask(pg, other, await insertEvent(pg, other));
      const before = await taskState(foreign);
      const version = await versionOf(other.guildId, foreign);
      const call = (taskId: string) =>
        Promise.all([
          getTask(db, { guildId: guild.guildId, taskId }),
          markTaskDoneAsOfficer(db, {
            guildId: guild.guildId,
            taskId,
            now: NOW,
          }),
          softDeleteTask(db, { guildId: guild.guildId, taskId, now: NOW }),
          setTaskDescription(db, {
            guildId: guild.guildId,
            taskId,
            expectedUpdatedAt: version,
            description: "taken",
          }),
        ]);
      expect(await call(foreign)).toEqual(await call(UNKNOWN_ID));
      expect(await taskState(foreign)).toEqual(before);
    });

    it("refuses a task on an event in another guild", async () => {
      const other = await insertGuild(pg);
      const foreignEvent = await insertEvent(pg, other);
      expect(
        await createTask(db, {
          guildId: guild.guildId,
          eventId: foreignEvent,
          assigneeId: fakeId(),
          actorId: fakeId(),
          description: "Sneak in",
          dueDate: DUE,
        }),
      ).toEqual({
        ok: false,
        error: { category: "constraint", code: "23503" },
      });
    });

    it("refuses a task on a closed event", async () => {
      const closed = await insertEvent(pg, guild);
      unwrap(await closeEvent(db, { guildId: guild.guildId, eventId: closed }));
      expect(
        await createTask(db, {
          guildId: guild.guildId,
          eventId: closed,
          assigneeId: fakeId(),
          actorId: fakeId(),
          description: "Too late",
          dueDate: DUE,
        }),
      ).toEqual({
        ok: false,
        error: { category: "parent_unavailable", code: "CF410" },
      });
    });

    it("soft-deletes once and keeps the first timestamp", async () => {
      const { taskId } = await newTask();
      const key = { guildId: guild.guildId, taskId };
      unwrap(await softDeleteTask(db, { ...key, now: NOW }));
      const stamped = async () =>
        (
          await pg.query<{ deleted_at: Date }>(
            `SELECT deleted_at FROM public.tasks WHERE id = $1`,
            [taskId],
          )
        ).rows[0]?.deleted_at;
      const first = await stamped();

      expect(
        await softDeleteTask(db, {
          ...key,
          now: new Date("2031-01-01T00:00:00.000Z"),
        }),
      ).toEqual(NOT_FOUND);
      expect(await stamped()).toEqual(first);
      expect(unwrap(await getTask(db, key))).toBeNull();
    });

    it("keeps a task under a deleted event deleted through every write", async () => {
      const ownEvent = await insertEvent(pg, guild);
      const assigneeId = fakeId();
      const taskId = await insertTask(pg, guild, ownEvent, assigneeId);
      const expectedUpdatedAt = await versionOf(guild.guildId, taskId);
      unwrap(
        await softDeleteEvent(db, {
          guildId: guild.guildId,
          eventId: ownEvent,
        }),
      );
      const key = { guildId: guild.guildId, taskId };
      const edit = { ...key, expectedUpdatedAt };
      const writes = await Promise.all([
        softDeleteTask(db, { ...key, now: NOW }),
        markOwnTaskDone(db, { ...key, assigneeId, now: NOW }),
        markTaskDoneAsOfficer(db, { ...key, now: NOW }),
        reassignTask(db, { ...edit, assigneeId: fakeId() }),
        setTaskDescription(db, { ...edit, description: "revived" }),
        setTaskDueDate(db, { ...edit, dueDate: date("2031-01-01") }),
      ]);
      expect(writes).toEqual(Array(6).fill(NOT_FOUND));

      expect(await taskState(taskId)).toEqual({
        status: "open",
        assignee_id: assigneeId,
        deleted: true,
        description: "Book the room",
        due_date: DUE,
      });
      expect(unwrap(await getTask(db, key))).toBeNull();
      expect(
        unwrap(
          await listOpenTasksForAssignee(db, {
            guildId: guild.guildId,
            assigneeId,
          }),
        ).rows,
      ).toEqual([]);
      expect(
        unwrap(
          await listEventTasks(db, {
            guildId: guild.guildId,
            eventId: ownEvent,
          }),
        ).rows,
      ).toEqual([]);
    });

    describe("a member's open tasks", () => {
      const openFor = async (guildId: string, assigneeId: string) =>
        unwrap(await listOpenTasksForAssignee(db, { guildId, assigneeId }))
          .rows.map((row) => row.id)
          .sort();

      it("lists them soonest first, with the event's name", async () => {
        const assigneeId = fakeId();
        const later = await newTask(assigneeId);
        const sooner = await newTask(assigneeId);
        unwrap(
          await setTaskDueDate(db, {
            guildId: guild.guildId,
            taskId: sooner.taskId,
            expectedUpdatedAt: await versionOf(guild.guildId, sooner.taskId),
            dueDate: date("2030-01-05"),
          }),
        );
        const { rows, truncated } = unwrap(
          await listOpenTasksForAssignee(db, {
            guildId: guild.guildId,
            assigneeId,
          }),
        );
        expect(truncated).toBe(false);
        expect(rows.map((row) => row.id)).toEqual([
          sooner.taskId,
          later.taskId,
        ]);
        expect(rows[0]?.event_name).toBe("General meeting");
        expect(rows[0]?.due_date).toBe("2030-01-05");
      });

      it("leaves out the same member's tasks in another guild", async () => {
        const own = await insertGuild(pg);
        const other = await insertGuild(pg);
        const assigneeId = fakeId();
        const mine = await insertTask(
          pg,
          own,
          await insertEvent(pg, own),
          assigneeId,
        );
        await insertTask(pg, other, await insertEvent(pg, other), assigneeId);
        expect(await openFor(own.guildId, assigneeId)).toEqual([mine]);
      });

      it("leaves out done and deleted tasks", async () => {
        const assigneeId = fakeId();
        const open = await newTask(assigneeId);
        const done = await newTask(assigneeId);
        const deleted = await newTask(assigneeId);
        unwrap(
          await markTaskDoneAsOfficer(db, {
            guildId: guild.guildId,
            taskId: done.taskId,
            now: NOW,
          }),
        );
        unwrap(
          await softDeleteTask(db, {
            guildId: guild.guildId,
            taskId: deleted.taskId,
            now: NOW,
          }),
        );
        expect(await openFor(guild.guildId, assigneeId)).toEqual([open.taskId]);
      });

      it("leaves out a live task whose event was deleted", async () => {
        const assigneeId = fakeId();
        const ownEvent = await insertEvent(pg, guild);
        await insertTask(pg, guild, ownEvent, assigneeId);
        await deleteEventOnly(ownEvent);
        expect(await openFor(guild.guildId, assigneeId)).toEqual([]);
      });

      it("still lists a task whose channel was removed", async () => {
        const own = await insertGuild(pg);
        const assigneeId = fakeId();
        await insertTask(pg, own, await insertEvent(pg, own), assigneeId);
        await queryAs(
          pg,
          MIGRATION_OWNER,
          `UPDATE public.managed_channels SET status = 'removed' WHERE guild_id = $1`,
          [own.guildId],
        );
        expect(await openFor(own.guildId, assigneeId)).toHaveLength(1);
      });
    });

    it("lists an event's tasks only for its own guild", async () => {
      const own = await insertGuild(pg);
      const other = await insertGuild(pg);
      const ownEvent = await insertEvent(pg, own);
      const taskId = await insertTask(pg, own, ownEvent);
      expect(
        unwrap(
          await listEventTasks(db, {
            guildId: own.guildId,
            eventId: ownEvent,
          }),
        ).rows.map((row) => row.id),
      ).toEqual([taskId]);
      expect(
        unwrap(
          await listEventTasks(db, {
            guildId: other.guildId,
            eventId: ownEvent,
          }),
        ).rows,
      ).toEqual([]);
    });

    it("reports a failing CHECK as its category and code", async () => {
      const { taskId } = await newTask();
      const expectedUpdatedAt = await versionOf(guild.guildId, taskId);
      await pg.exec(`
        CREATE FUNCTION public.test_fail_description() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'failing row %', NEW.description
          USING ERRCODE = '23514', DETAIL = NEW.description, HINT = NEW.description; END; $$;
        CREATE TRIGGER test_fail_description BEFORE UPDATE ON public.tasks
          FOR EACH ROW EXECUTE FUNCTION public.test_fail_description();
      `);
      try {
        const result = await setTaskDescription(db, {
          guildId: guild.guildId,
          taskId,
          expectedUpdatedAt,
          description: "row text",
        });
        expect(result).toEqual({
          ok: false,
          error: { category: "constraint", code: "23514" },
        });
      } finally {
        await pg.exec(`
          DROP TRIGGER test_fail_description ON public.tasks;
          DROP FUNCTION public.test_fail_description();
        `);
      }
    });
  });

  describe("reminder candidates", () => {
    // The query from schema.test.ts, without its per-kind log check, which the
    // planner applies to the log each candidate carries.
    const expectedIds = async (lastDueDate: string) => {
      const rows = await queryAs<{ id: string }>(
        pg,
        "bot_app",
        `SELECT t.id
         FROM public.tasks t
         JOIN public.events e ON e.id = t.event_id AND e.guild_id = t.guild_id
         JOIN public.managed_channels c ON c.guild_id = e.guild_id AND c.channel_id = e.channel_id
         JOIN public.guild_config g ON g.guild_id = t.guild_id
         WHERE t.status = 'open'
           AND t.deleted_at IS NULL
           AND t.due_date <= $1
           AND e.status = 'active'
           AND e.deleted_at IS NULL
           AND c.status = 'active'
           AND g.reminders_enabled`,
        [lastDueDate],
      );
      return rows.map((row) => row.id).sort();
    };

    const candidateIds = async () =>
      unwrap(await listReminderCandidates(db, { lastDueDate: DUE })).rows.map(
        (row) => row.task.id,
      );

    const setUp = async () => {
      const own = await insertGuild(pg);
      const eventId = await insertEvent(pg, own);
      const assigneeId = fakeId();
      const taskId = await insertTask(pg, own, eventId, assigneeId);
      expect(await candidateIds()).toContain(taskId);
      return { own, eventId, taskId, assigneeId };
    };

    it("returns what the planner needs for a task", async () => {
      const { own, eventId, taskId, assigneeId } = await setUp();
      const threadId = await linkThread(own.guildId, eventId);
      const { rows } = unwrap(
        await listReminderCandidates(db, { lastDueDate: DUE }),
      );
      expect(rows.find((row) => row.task.id === taskId)).toEqual({
        guild_id: own.guildId,
        timezone: "America/New_York",
        assignee_id: assigneeId,
        description: "Book the room",
        event_name: "General meeting",
        updated_at: await versionOf(own.guildId, taskId),
        task: {
          id: taskId,
          eventId,
          dueDate: DUE,
          status: "open",
          deleted: false,
        },
        event: {
          id: eventId,
          threadId,
          status: "active",
          threadStatus: "active",
          deleted: false,
          forumManaged: true,
        },
        log: [],
      });
    });

    it("leaves out a task due after the last date", async () => {
      const { own, taskId } = await setUp();
      unwrap(
        await setTaskDueDate(db, {
          guildId: own.guildId,
          taskId,
          expectedUpdatedAt: await versionOf(own.guildId, taskId),
          dueDate: date("2030-01-11"),
        }),
      );
      expect(await candidateIds()).not.toContain(taskId);
    });

    it("leaves out a done or deleted task", async () => {
      const done = await setUp();
      const deleted = await setUp();
      unwrap(
        await markTaskDoneAsOfficer(db, {
          guildId: done.own.guildId,
          taskId: done.taskId,
          now: NOW,
        }),
      );
      unwrap(
        await softDeleteTask(db, {
          guildId: deleted.own.guildId,
          taskId: deleted.taskId,
          now: NOW,
        }),
      );
      const ids = await candidateIds();
      expect(ids).not.toContain(done.taskId);
      expect(ids).not.toContain(deleted.taskId);
    });

    it("leaves out a task with reminders off for its guild", async () => {
      const { own, taskId } = await setUp();
      unwrap(
        await applyConfigChange(db, {
          guildId: own.guildId,
          actorId: fakeId(),
          expectedVersion: 2,
          remindersEnabled: false,
          addChannelIds: [],
          removeChannelIds: [],
          timezone: null,
        }),
      );
      expect(await candidateIds()).not.toContain(taskId);
    });

    it("leaves out a task in a removed or unavailable channel", async () => {
      const removed = await setUp();
      const unavailable = await setUp();
      unwrap(
        await applyConfigChange(db, {
          guildId: removed.own.guildId,
          actorId: fakeId(),
          expectedVersion: 2,
          remindersEnabled: null,
          addChannelIds: [],
          removeChannelIds: [removed.own.channelId],
          timezone: null,
        }),
      );
      unwrap(
        await markChannelUnavailable(db, {
          guildId: unavailable.own.guildId,
          channelId: unavailable.own.channelId,
        }),
      );
      const ids = await candidateIds();
      expect(ids).not.toContain(removed.taskId);
      expect(ids).not.toContain(unavailable.taskId);
    });

    it("leaves out a task under a closed or deleted event", async () => {
      const closed = await setUp();
      const deleted = await setUp();
      unwrap(
        await closeEvent(db, {
          guildId: closed.own.guildId,
          eventId: closed.eventId,
        }),
      );
      unwrap(
        await softDeleteEvent(db, {
          guildId: deleted.own.guildId,
          eventId: deleted.eventId,
        }),
      );
      const ids = await candidateIds();
      expect(ids).not.toContain(closed.taskId);
      expect(ids).not.toContain(deleted.taskId);
    });

    it("leaves out a live task whose event alone was deleted", async () => {
      const { eventId, taskId } = await setUp();
      await deleteEventOnly(eventId);
      expect(await candidateIds()).not.toContain(taskId);
    });

    it("returns the same tasks as the query the schema tests pin", async () => {
      const { truncated } = unwrap(
        await listReminderCandidates(db, { lastDueDate: DUE }),
      );
      expect(truncated).toBe(false);
      expect((await candidateIds()).sort()).toEqual(
        await expectedIds("2030-01-10"),
      );
    });

    it("carries the task's log, so an old due date can be told apart", async () => {
      const { own, taskId } = await setUp();
      const key = { taskId, kind: "one_day" as const, dueDate: DUE };
      expect(unwrap(await claimReminder(db, key))).not.toBeNull();

      const moved = date("2030-01-09");
      unwrap(
        await setTaskDueDate(db, {
          guildId: own.guildId,
          taskId,
          expectedUpdatedAt: await versionOf(own.guildId, taskId),
          dueDate: moved,
        }),
      );
      const { rows } = unwrap(
        await listReminderCandidates(db, { lastDueDate: DUE }),
      );
      const candidate = rows.find((row) => row.task.id === taskId);
      expect(candidate?.task.dueDate).toBe(moved);
      expect(candidate?.log).toHaveLength(1);
      expect(candidate?.log[0]).toMatchObject({
        taskId,
        dueDate: DUE,
        kind: "one_day",
        state: "claimed",
      });
      expect(candidate?.log[0]?.claimedAt.getTime()).not.toBeNaN();
    });

    it("reads past a page boundary with every row once, in order", async () => {
      const own = await insertGuild(pg);
      const eventId = await insertEvent(pg, own);
      // Far more than the quotas allow, so they are off for this one insert.
      const { rows: inserted } = await withoutQuotas(pg, () =>
        pg.query<{ id: string }>(
          `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
         SELECT $1::uuid, $2::text, $3::text, 'Bulk', date '2030-01-08' + (n % 2), $3::text
         FROM generate_series(1, 700) AS n
         RETURNING id`,
          [eventId, own.guildId, fakeId()],
        ),
      );
      const { rows, truncated } = unwrap(
        await listReminderCandidates(db, { lastDueDate: DUE }),
      );
      expect(truncated).toBe(false);
      const ids = rows.map((row) => row.task.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(expect.arrayContaining(inserted.map((r) => r.id)));
      const positions = rows.map((row) => `${row.task.dueDate} ${row.task.id}`);
      expect(positions).toEqual([...positions].sort());

      // Later tests share this database and do not want 700 more rows to read.
      await pg.query(
        `UPDATE public.tasks SET deleted_at = now() WHERE event_id = $1`,
        [eventId],
      );
    });
  });

  describe("what the task commands rely on", () => {
    let own: GuildFixture;

    beforeAll(async () => {
      own = await insertGuild(pg);
    });

    const newTaskOn = (eventId: string, assigneeId: string, actorId: string) =>
      createTask(db, {
        guildId: own.guildId,
        eventId,
        assigneeId,
        actorId,
        description: "Print the signs",
        dueDate: DUE,
      });

    it("leaves tasks on a closed or deleted event out of /mytasks and the pickers", async () => {
      const assigneeId = fakeId();
      const open = await insertEvent(pg, own);
      const closed = await insertEvent(pg, own);
      const deleted = await insertEvent(pg, own);
      const kept = unwrap(await newTaskOn(open, assigneeId, fakeId()));
      unwrap(await newTaskOn(closed, assigneeId, fakeId()));
      unwrap(await newTaskOn(deleted, assigneeId, fakeId()));
      unwrap(await closeEvent(db, { guildId: own.guildId, eventId: closed }));
      unwrap(
        await softDeleteEvent(db, { guildId: own.guildId, eventId: deleted }),
      );

      const mine = unwrap(
        await listOpenTasksForAssignee(db, {
          guildId: own.guildId,
          assigneeId,
        }),
      );
      const ownPicker = unwrap(
        await searchOwnOpenTasks(db, {
          guildId: own.guildId,
          assigneeId,
          term: "signs",
        }),
      );
      const officerPicker = unwrap(
        await searchOpenTasks(db, { guildId: own.guildId, term: "signs" }),
      );

      expect(mine.rows.map((row) => row.id)).toEqual([kept.id]);
      expect(ownPicker.map((row) => row.id)).toEqual([kept.id]);
      expect(officerPicker.map((row) => row.id)).toEqual([kept.id]);
    });

    it("finds a thread's event in this guild only, closed or not, and not once deleted", async () => {
      const other = await insertGuild(pg);
      const eventId = await insertEvent(pg, own);
      const threadId = fakeId();
      unwrap(
        await setEventThread(db, { guildId: own.guildId, eventId, threadId }),
      );

      const key = { guildId: own.guildId, threadId };
      expect(unwrap(await findEventByThread(db, key))?.id).toBe(eventId);
      expect(
        unwrap(
          await findEventByThread(db, { guildId: other.guildId, threadId }),
        ),
      ).toBeNull();

      unwrap(await closeEvent(db, { guildId: own.guildId, eventId }));
      expect(unwrap(await findEventByThread(db, key))?.status).toBe("closed");

      unwrap(await softDeleteEvent(db, { guildId: own.guildId, eventId }));
      expect(unwrap(await findEventByThread(db, key))).toBeNull();
    });

    it("offers only open events of this guild in the event picker", async () => {
      const other = await insertGuild(pg);
      const open = await insertEvent(pg, own);
      const closed = await insertEvent(pg, own);
      const foreign = await insertEvent(pg, other);
      unwrap(await closeEvent(db, { guildId: own.guildId, eventId: closed }));

      const ids = unwrap(
        await searchOpenEvents(db, { guildId: own.guildId, term: "meeting" }),
      ).map((row) => row.id);

      expect(ids).toContain(open);
      expect(ids).not.toContain(closed);
      expect(ids).not.toContain(foreign);
    });

    describe("searching by the start of an ID", () => {
      it("finds only live open rows, in this guild and for this member", async () => {
        const mine = fakeId();
        const eventId = await insertEvent(pg, own);
        const closed = await insertEvent(pg, own);
        const kept = unwrap(await newTaskOn(eventId, mine, fakeId()));
        const onClosed = unwrap(await newTaskOn(closed, mine, fakeId()));
        unwrap(await closeEvent(db, { guildId: own.guildId, eventId: closed }));

        for (const prefix of [kept.id.slice(0, 8), kept.id.slice(0, 3)]) {
          const officer = unwrap(
            await searchOpenTasksByIdPrefix(db, {
              guildId: own.guildId,
              prefix,
            }),
          ).map((row) => row.id);
          expect(officer).toContain(kept.id);
          expect(officer).not.toContain(onClosed.id);
        }
        const prefix = kept.id.slice(0, 8);
        expect(
          unwrap(
            await searchOwnOpenTasksByIdPrefix(db, {
              guildId: own.guildId,
              assigneeId: mine,
              prefix,
            }),
          ).map((row) => row.id),
        ).toEqual([kept.id]);
        expect(
          unwrap(
            await searchOwnOpenTasksByIdPrefix(db, {
              guildId: own.guildId,
              assigneeId: fakeId(),
              prefix,
            }),
          ),
        ).toEqual([]);
        expect(
          unwrap(
            await searchOpenTasksByIdPrefix(db, {
              guildId: guild.guildId,
              prefix,
            }),
          ),
        ).toEqual([]);
      });

      it("finds open events only", async () => {
        const open = await insertEvent(pg, own);
        const closed = await insertEvent(pg, own);
        unwrap(await closeEvent(db, { guildId: own.guildId, eventId: closed }));
        const search = async (eventId: string) =>
          unwrap(
            await searchOpenEventsByIdPrefix(db, {
              guildId: own.guildId,
              prefix: eventId.slice(0, 8),
            }),
          ).map((row) => row.id);

        expect(await search(open)).toEqual([open]);
        expect(await search(closed)).toEqual([]);
      });
    });

    describe("softDeleteTaskIfUnchanged", () => {
      it("deletes the version read, and refuses a later one", async () => {
        const eventId = await insertEvent(pg, own);
        const task = unwrap(await newTaskOn(eventId, fakeId(), fakeId()));
        await new Promise((resolve) => setTimeout(resolve, 5));
        const edited = unwrap(
          await editTask(db, {
            actorId: fakeId(),
            guildId: own.guildId,
            taskId: task.id,
            expectedUpdatedAt: task.updated_at,
            description: "Changed",
            dueDate: DUE,
            assigneeId: task.assignee_id,
          }),
        );
        const key = { guildId: own.guildId, taskId: task.id, now: NOW };

        expect(
          await softDeleteTaskIfUnchanged(db, {
            ...key,
            expectedUpdatedAt: task.updated_at,
          }),
        ).toEqual(NOT_FOUND);
        expect((await taskState(task.id))?.deleted).toBe(false);

        unwrap(
          await softDeleteTaskIfUnchanged(db, {
            ...key,
            expectedUpdatedAt: edited.updated_at,
          }),
        );
        expect((await taskState(task.id))?.deleted).toBe(true);
      });
    });

    describe("a closed event's tasks", () => {
      async function closedEventTask() {
        const eventId = await insertEvent(pg, own);
        const task = unwrap(await newTaskOn(eventId, fakeId(), fakeId()));
        unwrap(await closeEvent(db, { guildId: own.guildId, eventId }));
        return { eventId, task };
      }

      const unavailable = {
        ok: false,
        error: { category: "parent_unavailable", code: "CF410" },
      };

      it("refuses every change of work", async () => {
        const { task } = await closedEventTask();
        const key = { guildId: own.guildId, taskId: task.id };

        expect(
          await editTask(db, {
            actorId: fakeId(),
            ...key,
            expectedUpdatedAt: task.updated_at,
            description: "Changed",
            dueDate: DUE,
            assigneeId: task.assignee_id,
          }),
        ).toEqual(unavailable);
        expect(await markTaskDoneAsOfficer(db, { ...key, now: NOW })).toEqual(
          unavailable,
        );
        expect(
          await markOwnTaskDone(db, {
            ...key,
            assigneeId: task.assignee_id,
            now: NOW,
          }),
        ).toEqual(unavailable);
        expect((await taskState(task.id))?.status).toBe("open");
      });

      it("still lets a task or its event be soft deleted", async () => {
        const { eventId, task } = await closedEventTask();
        unwrap(
          await softDeleteTask(db, {
            guildId: own.guildId,
            taskId: task.id,
            now: NOW,
          }),
        );
        expect((await taskState(task.id))?.deleted).toBe(true);
        expect(
          unwrap(await softDeleteEvent(db, { guildId: own.guildId, eventId })),
        ).toBe(0);
      });

      it("refuses a change once the event is deleted, too", async () => {
        const eventId = await insertEvent(pg, own);
        const task = unwrap(await newTaskOn(eventId, fakeId(), fakeId()));
        unwrap(await softDeleteEvent(db, { guildId: own.guildId, eventId }));

        // The bot's filters stop this first, so the trigger needs a direct write to reach.
        await expect(
          queryAs(
            pg,
            MIGRATION_OWNER,
            `UPDATE public.tasks SET description = 'Changed' WHERE id = $1`,
            [task.id],
          ),
        ).rejects.toMatchObject({ code: "CF410" });
      });
    });

    describe("editTask", () => {
      it("changes all three fields in one write", async () => {
        const eventId = await insertEvent(pg, own);
        const task = unwrap(await newTaskOn(eventId, fakeId(), fakeId()));
        const assigneeId = fakeId();

        const edited = unwrap(
          await editTask(db, {
            actorId: fakeId(),
            guildId: own.guildId,
            taskId: task.id,
            expectedUpdatedAt: task.updated_at,
            description: "Print the banner",
            dueDate: date("2030-02-02"),
            assigneeId,
          }),
        );

        expect(edited).toMatchObject({
          description: "Print the banner",
          due_date: "2030-02-02",
          assignee_id: assigneeId,
        });
      });

      it.each([
        ["an old version", "2001-01-01T00:00:00+00:00"],
        ["a version that is not a timestamp", "x,status.eq.done"],
      ])("writes nothing given %s", async (_name, expectedUpdatedAt) => {
        const eventId = await insertEvent(pg, own);
        const task = unwrap(await newTaskOn(eventId, fakeId(), fakeId()));

        const edited = await editTask(db, {
          actorId: fakeId(),
          guildId: own.guildId,
          taskId: task.id,
          expectedUpdatedAt,
          description: "Overwritten",
          dueDate: DUE,
          assigneeId: task.assignee_id,
        });

        expect(edited.ok).toBe(false);
        expect((await taskState(task.id))?.description).toBe(task.description);
      });

      it("does not reach a finished task, a deleted task or another guild's task", async () => {
        const eventId = await insertEvent(pg, own);
        const edit = (taskId: string, updated: string, guildId = own.guildId) =>
          editTask(db, {
            actorId: fakeId(),
            guildId,
            taskId,
            expectedUpdatedAt: updated,
            description: "Overwritten",
            dueDate: DUE,
            assigneeId: fakeId(),
          });

        const finished = unwrap(await newTaskOn(eventId, fakeId(), fakeId()));
        const done = unwrap(
          await markTaskDoneAsOfficer(db, {
            guildId: own.guildId,
            taskId: finished.id,
            now: NOW,
          }),
        );
        expect(await edit(done.id, done.updated_at)).toEqual(NOT_FOUND);

        const removed = unwrap(await newTaskOn(eventId, fakeId(), fakeId()));
        const deleted = unwrap(
          await softDeleteTask(db, {
            guildId: own.guildId,
            taskId: removed.id,
            now: NOW,
          }),
        );
        expect(await edit(deleted.id, deleted.updated_at)).toEqual(NOT_FOUND);

        const live = unwrap(await newTaskOn(eventId, fakeId(), fakeId()));
        expect(await edit(live.id, live.updated_at, guild.guildId)).toEqual(
          NOT_FOUND,
        );
        expect((await taskState(live.id))?.description).toBe(live.description);
      });
    });

    describe("task quotas", () => {
      const eventLimit = {
        ok: false,
        error: { category: "event_task_limit", code: "CF429" },
      };
      const actorLimit = {
        ok: false,
        error: { category: "actor_task_limit", code: "CF430" },
      };

      async function fill(
        eventId: string,
        count: number,
        actorId: () => string,
      ) {
        for (let index = 0; index < count; index += 1) {
          unwrap(await newTaskOn(eventId, fakeId(), actorId()));
        }
      }

      it(`refuses task ${String(MAX_TASKS_PER_EVENT + 1)} on one event, until one is deleted`, async () => {
        const eventId = await insertEvent(pg, own);
        await fill(eventId, MAX_TASKS_PER_EVENT, fakeId);

        expect(await newTaskOn(eventId, fakeId(), fakeId())).toEqual(
          eventLimit,
        );

        const { rows } = await pg.query<{ id: string }>(
          `SELECT id FROM public.tasks WHERE event_id = $1 LIMIT 1`,
          [eventId],
        );
        unwrap(
          await softDeleteTask(db, {
            guildId: own.guildId,
            taskId: rows[0]?.id ?? "",
            now: NOW,
          }),
        );
        unwrap(await newTaskOn(eventId, fakeId(), fakeId()));
      });

      it(`refuses an officer's task ${String(MAX_TASK_ACTIONS_PER_OFFICER_PER_DAY + 1)} in a day, counting deleted ones`, async () => {
        const actorId = fakeId();
        const eventId = await insertEvent(pg, own);
        const secondEvent = await insertEvent(pg, own);
        await fill(
          eventId,
          MAX_TASK_ACTIONS_PER_OFFICER_PER_DAY,
          () => actorId,
        );

        await pg.query(
          `UPDATE public.tasks SET deleted_at = now() WHERE event_id = $1`,
          [eventId],
        );

        expect(await newTaskOn(secondEvent, fakeId(), actorId)).toEqual(
          actorLimit,
        );
        unwrap(await newTaskOn(secondEvent, fakeId(), fakeId()));
      });

      it("counts reassignments and new tasks together, in either order", async () => {
        const actorId = fakeId();
        const eventId = await insertEvent(pg, own);
        const task = unwrap(await newTaskOn(eventId, fakeId(), actorId));
        const reassign = () =>
          reassignAs(db, {
            guildId: own.guildId,
            actorId,
            taskId: task.id,
          });
        for (let i = 1; i < MAX_TASK_ACTIONS_PER_OFFICER_PER_DAY; i += 1) {
          unwrap(await reassign());
        }

        expect(await reassign()).toEqual(actorLimit);
        expect(await newTaskOn(eventId, fakeId(), actorId)).toEqual(actorLimit);
        unwrap(await newTaskOn(eventId, fakeId(), fakeId()));
      });

      it("stops counting reassignments after 24 hours, and can't be backdated", async () => {
        const actorId = fakeId();
        const eventId = await insertEvent(pg, own);
        const task = unwrap(await newTaskOn(eventId, fakeId(), fakeId()));
        const reassign = () =>
          reassignAs(db, {
            guildId: own.guildId,
            actorId,
            taskId: task.id,
          });
        for (let i = 0; i < MAX_TASK_ACTIONS_PER_OFFICER_PER_DAY; i += 1) {
          unwrap(await reassign());
        }
        expect(await reassign()).toEqual(actorLimit);

        await pg.query(
          `UPDATE public.task_reassignments SET created_at = now() - interval '25 hours'
           WHERE actor_id = $1`,
          [actorId],
        );
        unwrap(await reassign());
      });

      it("refuses a reassignment naming a task that does not exist", async () => {
        const refused = await reassignAs(db, {
          guildId: own.guildId,
          actorId: fakeId(),
          taskId: UNKNOWN_ID,
        });
        expect(refused.ok).toBe(false);
      });

      it("stops counting an officer's tasks after 24 hours", async () => {
        const actorId = fakeId();
        const eventId = await insertEvent(pg, own);
        await fill(
          eventId,
          MAX_TASK_ACTIONS_PER_OFFICER_PER_DAY,
          () => actorId,
        );

        await pg.query(
          `UPDATE public.tasks SET created_at = now() - interval '25 hours'
           WHERE event_id = $1`,
          [eventId],
        );

        unwrap(await newTaskOn(eventId, fakeId(), actorId));
      });

      it("counts per guild, so another guild's officer limit is its own", async () => {
        const other = await insertGuild(pg);
        const actorId = fakeId();
        const eventId = await insertEvent(pg, own);
        const otherEvent = await insertEvent(pg, other);
        await fill(
          eventId,
          MAX_TASK_ACTIONS_PER_OFFICER_PER_DAY,
          () => actorId,
        );

        unwrap(
          await createTask(db, {
            guildId: other.guildId,
            eventId: otherEvent,
            assigneeId: fakeId(),
            actorId,
            description: "Print the signs",
            dueDate: DUE,
          }),
        );
      });

      it("reports a closed event as closed even when it is also full", async () => {
        const eventId = await insertEvent(pg, own);
        await fill(eventId, MAX_TASKS_PER_EVENT, fakeId);
        unwrap(await closeEvent(db, { guildId: own.guildId, eventId }));

        expect(await newTaskOn(eventId, fakeId(), fakeId())).toMatchObject({
          ok: false,
          error: { category: "parent_unavailable" },
        });
      });
    });
  });

  describe("reminder claims", () => {
    const newKey = async (own: GuildFixture = guild) => ({
      taskId: await insertTask(pg, own, await insertEvent(pg, own)),
      kind: "due_day" as const,
      dueDate: DUE,
    });

    const age = (taskId: string) =>
      pg.query(
        `UPDATE public.reminder_log SET claimed_at = now() - interval '2 hours' WHERE task_id = $1`,
        [taskId],
      );

    const hourAgo = () => new Date(Date.now() - 3_600_000);

    const logState = async (taskId: string) => {
      const { rows } = await pg.query<{ state: string }>(
        `SELECT state FROM public.reminder_log WHERE task_id = $1`,
        [taskId],
      );
      return rows[0]?.state;
    };

    const staleTaskIds = async () =>
      unwrap(await listStaleClaims(db, { claimedBefore: hourAgo() })).rows.map(
        (row) => row.task_id,
      );

    it("claims once and marks sent with the right token only", async () => {
      const key = await newKey();
      const token = unwrap(await claimReminder(db, key));
      expect(token).toEqual(expect.any(String));
      expect(unwrap(await claimReminder(db, key))).toBeNull();

      const messageId = fakeId();
      expect(
        unwrap(
          await markReminderSent(db, {
            ...key,
            claimToken: UNKNOWN_ID,
            messageId,
          }),
        ),
      ).toBe(false);
      expect(
        unwrap(
          await markReminderSent(db, {
            ...key,
            claimToken: token ?? "",
            messageId,
          }),
        ),
      ).toBe(true);
    });

    it("lets only one of two simultaneous claims win", async () => {
      const key = await newKey();
      const tokens = (
        await Promise.all([claimReminder(db, key), claimReminder(db, key)])
      ).map(unwrap);
      expect(tokens.filter((token) => token !== null)).toHaveLength(1);
    });

    it("skips a claim", async () => {
      const key = await newKey();
      const token = unwrap(await claimReminder(db, key));
      expect(
        unwrap(
          await markReminderSkipped(db, { ...key, claimToken: token ?? "" }),
        ),
      ).toBe(true);
    });

    it("stops claiming once reminders are turned off during a run", async () => {
      const own = await insertGuild(pg);
      const first = await newKey(own);
      const second = await newKey(own);
      expect(unwrap(await claimReminder(db, first))).not.toBeNull();
      unwrap(
        await applyConfigChange(db, {
          guildId: own.guildId,
          actorId: fakeId(),
          expectedVersion: 2,
          remindersEnabled: false,
          addChannelIds: [],
          removeChannelIds: [],
          timezone: null,
        }),
      );
      expect(unwrap(await claimReminder(db, second))).toBeNull();
    });

    it("lists a claim older than the cutoff, and takes it over", async () => {
      const key = await newKey();
      const token = unwrap(await claimReminder(db, key));
      await age(key.taskId);

      const stale = unwrap(
        await listStaleClaims(db, { claimedBefore: hourAgo() }),
      );
      expect(
        stale.rows.find((row) => row.task_id === key.taskId),
      ).toMatchObject({
        kind: "due_day",
        due_date: DUE,
        claim_token: token,
        attempts: 1,
      });

      const newToken = unwrap(
        await reclaimReminder(db, { ...key, claimToken: token ?? "" }),
      );
      expect(newToken).toEqual(expect.any(String));
      expect(newToken).not.toBe(token);
      expect(
        unwrap(await reclaimReminder(db, { ...key, claimToken: token ?? "" })),
      ).toBeNull();
    });

    it("leaves a fresh claim off the stale list", async () => {
      const key = await newKey();
      unwrap(await claimReminder(db, key));
      expect(await staleTaskIds()).not.toContain(key.taskId);
    });

    it("leaves a finished claim off the stale list, however old", async () => {
      const key = await newKey();
      const token = unwrap(await claimReminder(db, key));
      unwrap(
        await markReminderSent(db, {
          ...key,
          claimToken: token ?? "",
          messageId: fakeId(),
        }),
      );
      await age(key.taskId);
      expect(await staleTaskIds()).not.toContain(key.taskId);
    });

    describe("resolving a stale claim", () => {
      const staleClaim = async (own: GuildFixture = guild) => {
        const key = await newKey(own);
        const claimToken = unwrap(await claimReminder(db, key)) ?? "";
        await age(key.taskId);
        return { ...key, claimToken };
      };

      it("takes over a claim on a task that is still due", async () => {
        const claim = await staleClaim();
        const result = unwrap(await resolveStaleClaim(db, claim));
        expect(result.outcome).toBe("reclaimed");
        expect(await logState(claim.taskId)).toBe("claimed");
      });

      it("closes a claim on a finished task, which leaves the stale list", async () => {
        const claim = await staleClaim();
        unwrap(
          await markTaskDoneAsOfficer(db, {
            guildId: guild.guildId,
            taskId: claim.taskId,
            now: NOW,
          }),
        );
        expect(await staleTaskIds()).toContain(claim.taskId);
        expect(unwrap(await resolveStaleClaim(db, claim))).toEqual({
          outcome: "closed",
        });
        expect(await logState(claim.taskId)).toBe("skipped");
        expect(await staleTaskIds()).not.toContain(claim.taskId);
      });

      it("closes a claim on a deleted task, or one whose date moved", async () => {
        const deleted = await staleClaim();
        const moved = await staleClaim();
        unwrap(
          await softDeleteTask(db, {
            guildId: guild.guildId,
            taskId: deleted.taskId,
            now: NOW,
          }),
        );
        unwrap(
          await setTaskDueDate(db, {
            guildId: guild.guildId,
            taskId: moved.taskId,
            expectedUpdatedAt: await versionOf(guild.guildId, moved.taskId),
            dueDate: date("2031-01-01"),
          }),
        );
        for (const claim of [deleted, moved]) {
          expect(unwrap(await resolveStaleClaim(db, claim))).toEqual({
            outcome: "closed",
          });
        }
      });

      it("leaves a claim alone while reminders are off, so it can resume", async () => {
        const own = await insertGuild(pg);
        const claim = await staleClaim(own);
        const setReminders = async (
          remindersEnabled: boolean,
          expectedVersion: number,
        ) =>
          unwrap(
            await applyConfigChange(db, {
              guildId: own.guildId,
              actorId: fakeId(),
              expectedVersion,
              remindersEnabled,
              addChannelIds: [],
              removeChannelIds: [],
              timezone: null,
            }),
          );
        await setReminders(false, 2);
        expect(unwrap(await resolveStaleClaim(db, claim))).toEqual({
          outcome: "left",
        });
        expect(await logState(claim.taskId)).toBe("claimed");

        await setReminders(true, 3);
        expect(unwrap(await resolveStaleClaim(db, claim)).outcome).toBe(
          "reclaimed",
        );
      });

      it("closes only the named claim when the task has others", async () => {
        const own = await insertGuild(pg);
        const eventId = await insertEvent(pg, own);
        const taskId = await insertTask(pg, own, eventId);
        // Claimed first, so a read that ignored kind would find this one.
        const other = { taskId, kind: "one_day" as const, dueDate: DUE };
        unwrap(await claimReminder(db, other));
        const key = { taskId, kind: "due_day" as const, dueDate: DUE };
        const claimToken = unwrap(await claimReminder(db, key)) ?? "";
        await age(taskId);
        unwrap(
          await markTaskDoneAsOfficer(db, {
            guildId: own.guildId,
            taskId,
            now: NOW,
          }),
        );

        expect(
          unwrap(await resolveStaleClaim(db, { ...key, claimToken })),
        ).toEqual({ outcome: "closed" });

        const { rows } = await pg.query<{ kind: string; state: string }>(
          `SELECT kind, state FROM public.reminder_log WHERE task_id = $1 ORDER BY kind`,
          [taskId],
        );
        expect(rows).toEqual([
          { kind: "one_day", state: "claimed" },
          { kind: "due_day", state: "skipped" },
        ]);
      });

      it("reads the claim for the named due date, not one from an earlier date", async () => {
        const own = await insertGuild(pg);
        const taskId = await insertTask(pg, own, await insertEvent(pg, own));
        unwrap(
          await claimReminder(db, { taskId, kind: "due_day", dueDate: DUE }),
        );
        const moved = date("2030-01-11");
        unwrap(
          await setTaskDueDate(db, {
            guildId: own.guildId,
            taskId,
            expectedUpdatedAt: await versionOf(own.guildId, taskId),
            dueDate: moved,
          }),
        );
        const key = { taskId, kind: "due_day" as const, dueDate: moved };
        const claimToken = unwrap(await claimReminder(db, key)) ?? "";
        await age(taskId);
        unwrap(
          await markTaskDoneAsOfficer(db, {
            guildId: own.guildId,
            taskId,
            now: NOW,
          }),
        );
        expect(
          unwrap(await resolveStaleClaim(db, { ...key, claimToken })),
        ).toEqual({ outcome: "closed" });
      });

      it("leaves a claim someone else has already taken over", async () => {
        const claim = await staleClaim();
        unwrap(await reclaimReminder(db, claim));
        expect(unwrap(await resolveStaleClaim(db, claim))).toEqual({
          outcome: "left",
        });
        expect(await logState(claim.taskId)).toBe("claimed");
      });
    });
  });

  describe("the daily sweep", () => {
    it("lists active forums across guilds and leaves out the rest", async () => {
      const one = await insertGuild(pg);
      const two = await insertGuild(pg);
      const gone = await insertGuild(pg);
      unwrap(
        await markChannelUnavailable(db, {
          guildId: gone.guildId,
          channelId: gone.channelId,
        }),
      );

      const { rows } = unwrap(await listActiveManagedChannels(db));

      const ids = rows.map((row) => row.channel_id);
      expect(ids).toEqual(
        expect.arrayContaining([one.channelId, two.channelId]),
      );
      expect(ids).not.toContain(gone.channelId);
    });

    it("expires only interaction claims older than a day", async () => {
      const old = fakeId();
      const fresh = fakeId();
      const claim = (interactionId: string) =>
        claimInteraction(db, { interactionId });
      expect(unwrap(await claim(old))).toBe(true);
      expect(unwrap(await claim(fresh))).toBe(true);
      await pg.query(
        `UPDATE public.interaction_claims SET claimed_at = now() - interval '25 hours'
         WHERE interaction_id = $1`,
        [old],
      );

      expect(unwrap(await expireInteractionClaims(db))).toBe(1);

      expect(unwrap(await claim(old))).toBe(true);
      expect(unwrap(await claim(fresh))).toBe(false);
    });
  });

  describe("job runs", () => {
    const startRun = async (jobName: "reminders" | "health_check") => {
      const id = unwrap(
        await beginJobRun(db, { jobName, staleAfterSeconds: 120 }),
      );
      if (id === null) {
        throw new Error("expected a run to start");
      }
      return id;
    };

    beforeEach(async () => {
      await pg.query("DELETE FROM public.job_runs");
    });

    it("starts and finishes a run once", async () => {
      const id = await startRun("health_check");
      expect(
        unwrap(await getLatestJobRun(db, { jobName: "health_check" })),
      ).toMatchObject({
        id,
        job_name: "health_check",
        status: "running",
        finished_at: null,
        results: {},
        error: null,
      });

      const end = new Date("2031-01-01T00:00:00.000Z");
      expect(
        unwrap(
          await finishJobRun(db, {
            id,
            now: end,
            results: { checked: 3 },
            error: null,
          }),
        ),
      ).toMatchObject({ status: "succeeded", results: { checked: 3 } });

      expect(
        await finishJobRun(db, {
          id,
          now: end,
          results: {},
          error: { category: "unexpected", code: null },
        }),
      ).toEqual(NOT_FOUND);
    });

    it("finishes only the named run", async () => {
      const target = await startRun("health_check");
      const neighbour = await startRun("reminders");

      unwrap(
        await finishJobRun(db, {
          id: target,
          now: new Date("2031-06-01T00:00:00.000Z"),
          results: {},
          error: null,
        }),
      );

      const status = async (id: string) => {
        const { rows } = await pg.query<{ status: string }>(
          `SELECT status FROM public.job_runs WHERE id = $1`,
          [id],
        );
        return rows[0]?.status;
      };
      expect(await status(target)).toBe("succeeded");
      expect(await status(neighbour)).toBe("running");
    });

    it("holds a job to one running row, whatever writes it", async () => {
      await startRun("reminders");
      expect(
        await errorCodeOf(
          pg.query(
            `INSERT INTO public.job_runs (job_name) VALUES ('reminders')`,
          ),
        ),
      ).toBe("23505");
    });

    it("reads the latest run of the named job, not of another", async () => {
      const run = await startRun("reminders");
      await pg.query(
        `UPDATE public.job_runs SET started_at = now() - interval '2 days' WHERE id = $1`,
        [run],
      );
      const other = await startRun("health_check");
      await pg.query(
        `UPDATE public.job_runs SET started_at = now() - interval '1 day' WHERE id = $1`,
        [other],
      );
      expect(
        unwrap(await getLatestJobRun(db, { jobName: "reminders" }))?.id,
      ).toBe(run);
    });

    it("reads the latest succeeded run, not the latest run", async () => {
      expect(
        unwrap(await getLatestSucceededJobRun(db, { jobName: "reminders" })),
      ).toBeNull();

      const succeeded = await startRun("reminders");
      unwrap(
        await finishJobRun(db, {
          id: succeeded,
          now: new Date(),
          results: {},
          error: null,
        }),
      );
      await pg.query(
        `UPDATE public.job_runs SET started_at = now() - interval '25 hours' WHERE id = $1`,
        [succeeded],
      );
      unwrap(
        await finishJobRun(db, {
          id: await startRun("reminders"),
          now: new Date(),
          results: {},
          error: { category: "unexpected", code: null },
        }),
      );

      expect(
        unwrap(await getLatestSucceededJobRun(db, { jobName: "reminders" }))
          ?.id,
      ).toBe(succeeded);
    });

    it("records a failure as a category and code", async () => {
      const own = await insertGuild(pg);
      const failing = await applyConfigChange(db, {
        guildId: own.guildId,
        actorId: fakeId(),
        expectedVersion: 2,
        remindersEnabled: null,
        addChannelIds: [],
        removeChannelIds: [],
        timezone: "america/new_york",
      });
      if (failing.ok) throw new Error("expected a failure");

      const run = await startRun("reminders");
      const finished = unwrap(
        await finishJobRun(db, {
          id: run,
          now: new Date(),
          results: {},
          error: failing.error,
        }),
      );
      expect(finished.status).toBe("failed");
      expect(finished.error).toBe("constraint:22023");
    });
  });

  it("lists open tasks first at the cap, whatever their dates", async () => {
    const own = await insertGuild(pg);
    const eventId = await insertEvent(pg, own);
    // Quotas now stop this many, so these stand for rows older than them.
    await pg.exec("SET session_replication_role = replica");
    await pg.query(
      `INSERT INTO public.tasks
         (event_id, guild_id, assignee_id, description, due_date, created_by, status,
          completed_at)
       SELECT $1::uuid, $2::text, $3::text, 'Done ' || n, date '2030-01-01', $3::text,
              'done', now()
       FROM generate_series(1, 101) AS n`,
      [eventId, own.guildId, fakeId()],
    );
    const open = await insertTask(pg, own, eventId);
    await pg.exec("RESET session_replication_role");

    const { rows, truncated } = unwrap(
      await listEventTasks(db, { guildId: own.guildId, eventId }),
    );

    expect(rows[0]?.id).toBe(open);
    expect(truncated).toBe(true);
  });

  describe("countOpenTasksInChannel", () => {
    const count = async (fixture: GuildFixture) =>
      unwrap(
        await countOpenTasksInChannel(db, {
          guildId: fixture.guildId,
          channelId: fixture.channelId,
        }),
      );

    it("counts open tasks across a forum's events, and nothing else", async () => {
      const own = await insertGuild(pg);
      const other = await insertGuild(pg);
      const first = await insertEvent(pg, own);
      const second = await insertEvent(pg, own);
      const foreign = await insertEvent(pg, other);
      const deletedEvent = await insertEvent(pg, own);
      await insertTask(pg, own, first);
      await insertTask(pg, own, second);
      await insertTask(pg, other, foreign);
      await insertTask(pg, own, deletedEvent);
      const done = await insertTask(pg, own, first);
      const deleted = await insertTask(pg, own, first);
      unwrap(
        await markTaskDoneAsOfficer(db, {
          guildId: own.guildId,
          taskId: done,
          now: NOW,
        }),
      );
      unwrap(
        await softDeleteTask(db, {
          guildId: own.guildId,
          taskId: deleted,
          now: NOW,
        }),
      );
      unwrap(
        await softDeleteEvent(db, {
          guildId: own.guildId,
          eventId: deletedEvent,
        }),
      );

      expect(await count(own)).toEqual({ count: 2, truncated: false });
    });

    it("finds nothing for a forum with no tasks", async () => {
      expect(await count(await insertGuild(pg))).toEqual({
        count: 0,
        truncated: false,
      });
    });
  });

  describe("another guild's rows", () => {
    /** One guild with an event in a post, a task and a step assignee, and one other. */
    const world = async () => {
      const own = await insertGuild(pg);
      const other = await insertGuild(pg);
      const eventId = await insertEvent(pg, own);
      const threadId = await linkThread(own.guildId, eventId);
      const assigneeId = fakeId();
      const taskId = await insertTask(pg, own, eventId, assigneeId);
      unwrap(
        await assignEventStep(db, {
          guildId: own.guildId,
          eventId,
          kind: "budget_sheet",
          userId: assigneeId,
          actorId: fakeId(),
        }),
      );
      return { own, other, eventId, threadId, assigneeId, taskId };
    };
    type World = Awaited<ReturnType<typeof world>>;

    const reads: [string, (w: World, guildId: string) => Promise<unknown>][] = [
      ["getTask", (w, guildId) => getTask(db, { guildId, taskId: w.taskId })],
      [
        "getEvent",
        (w, guildId) => getEvent(db, { guildId, eventId: w.eventId }),
      ],
      [
        "getEventWorkflow",
        (w, guildId) => getEventWorkflow(db, { guildId, eventId: w.eventId }),
      ],
      [
        "listEventWorkflows",
        (w, guildId) =>
          listEventWorkflows(db, { guildId, eventIds: [w.eventId] }),
      ],
      [
        "listEventTasks",
        (w, guildId) => listEventTasks(db, { guildId, eventId: w.eventId }),
      ],
      [
        "listOpenTasksForAssignee",
        (w, guildId) =>
          listOpenTasksForAssignee(db, { guildId, assigneeId: w.assigneeId }),
      ],
      [
        "listOpenStepsForUser",
        (w, guildId) =>
          listOpenStepsForUser(db, {
            guildId,
            userId: w.assigneeId,
            today: date("2029-12-01"),
          }),
      ],
      ["listEvents", (_w, guildId) => listEvents(db, { guildId })],
      [
        "listEventsNamed",
        (w, guildId) =>
          listEventsNamed(db, {
            guildId,
            channelId: w.own.channelId,
            name: "General meeting",
            eventDate: date("2030-01-15"),
          }),
      ],
      [
        "listRecentEventsInChannel",
        (w, guildId) =>
          listRecentEventsInChannel(db, {
            guildId,
            channelId: w.own.channelId,
            limit: 5,
          }),
      ],
      [
        "findEventByThread",
        (w, guildId) =>
          findEventByThread(db, { guildId, threadId: w.threadId }),
      ],
      [
        "findEventEverOnThread",
        (w, guildId) =>
          findEventEverOnThread(db, { guildId, threadId: w.threadId }),
      ],
      [
        "searchEvents",
        (_w, guildId) => searchEvents(db, { guildId, term: "General" }),
      ],
      [
        "searchOpenEvents",
        (_w, guildId) => searchOpenEvents(db, { guildId, term: "General" }),
      ],
      [
        "searchOpenEventsByIdPrefix",
        (w, guildId) =>
          searchOpenEventsByIdPrefix(db, {
            guildId,
            prefix: w.eventId.slice(0, 8),
          }),
      ],
      [
        "searchOpenTasks",
        (_w, guildId) => searchOpenTasks(db, { guildId, term: "Book" }),
      ],
      [
        "searchLiveTasks",
        (_w, guildId) => searchLiveTasks(db, { guildId, term: "Book" }),
      ],
      [
        "searchOwnOpenTasks",
        (w, guildId) =>
          searchOwnOpenTasks(db, {
            guildId,
            assigneeId: w.assigneeId,
            term: "Book",
          }),
      ],
      [
        "searchOpenTasksByIdPrefix",
        (w, guildId) =>
          searchOpenTasksByIdPrefix(db, {
            guildId,
            prefix: w.taskId.slice(0, 8),
          }),
      ],
      [
        "searchLiveTasksByIdPrefix",
        (w, guildId) =>
          searchLiveTasksByIdPrefix(db, {
            guildId,
            prefix: w.taskId.slice(0, 8),
          }),
      ],
      [
        "searchOwnOpenTasksByIdPrefix",
        (w, guildId) =>
          searchOwnOpenTasksByIdPrefix(db, {
            guildId,
            assigneeId: w.assigneeId,
            prefix: w.taskId.slice(0, 8),
          }),
      ],
      [
        "getManagedChannel",
        (w, guildId) =>
          getManagedChannel(db, { guildId, channelId: w.own.channelId }),
      ],
      [
        "listManagedChannelsByIds",
        (w, guildId) =>
          listManagedChannelsByIds(db, {
            guildId,
            channelIds: [w.own.channelId],
          }),
      ],
      [
        "listManagedChannels",
        (_w, guildId) => listManagedChannels(db, { guildId }),
      ],
      ["getGuildConfig", (_w, guildId) => getGuildConfig(db, { guildId })],
      [
        "listRecentConfigChanges",
        (_w, guildId) => listRecentConfigChanges(db, { guildId }),
      ],
    ];

    it.each(reads)(
      "%s finds the guild's own rows and none of another's",
      async (_name, read) => {
        const w = await world();
        const ownIds = [
          w.own.guildId,
          w.own.channelId,
          w.own.officerRoleId,
          w.eventId,
          w.taskId,
        ];

        const own = JSON.stringify(
          unwrap((await read(w, w.own.guildId)) as DbResult<unknown>),
        );
        const other = JSON.stringify(
          unwrap((await read(w, w.other.guildId)) as DbResult<unknown>),
        );

        expect(ownIds.some((id) => own.includes(id))).toBe(true);
        for (const id of ownIds) {
          expect(other).not.toContain(id);
        }
      },
    );

    it("answers a malformed ID with a failure or no row, not a throw", async () => {
      const w = await world();

      expect(
        await getEventWorkflow(db, {
          guildId: w.own.guildId,
          eventId: "not-a-uuid",
        }),
      ).toEqual({
        ok: false,
        error: { category: "constraint", code: "22P02" },
      });
      expect(
        unwrap(await listManagedChannels(db, { guildId: "x' or '1'='1" })).rows,
      ).toEqual([]);
    });

    it("counts no task of another guild's forum", async () => {
      const w = await world();

      expect(
        unwrap(
          await countOpenTasksInChannel(db, {
            guildId: w.other.guildId,
            channelId: w.own.channelId,
          }),
        ),
      ).toEqual({ count: 0, truncated: false });
    });
  });
});

describe("the event workflow against the real schema", () => {
  let backend: Backend;
  let pg: Connection;
  let db: DbClient;
  let guild: GuildFixture;

  beforeAll(async () => {
    backend = await openBackend();
    pg = backend.connection;
    db = backend.db;
    guild = await insertGuild(pg);
  });

  afterAll(async () => {
    await backend.close();
  });

  const key = (eventId: string) => ({ guildId: guild.guildId, eventId });
  const assign = (
    eventId: string,
    kind: "budget_sheet" | "engage_post" | "food_pickup",
    userId: string = fakeId(),
  ) =>
    assignEventStep(db, {
      ...key(eventId),
      kind,
      userId,
      actorId: guild.officerRoleId,
    });
  const approve = (eventId: string) =>
    completeEventStep(db, {
      ...key(eventId),
      kind: "budget_approved",
      actorId: fakeId(),
    });

  /** An event dated far ahead, on a date of its own, so other runs' rows cannot crowd it out. */
  const datedEvent = async (eventDate: string): Promise<string> => {
    const rows = await queryAs<{ id: string }>(
      pg,
      "bot_app",
      `INSERT INTO public.events (guild_id, channel_id, name, event_date, created_by)
       VALUES ($1, $2, 'Workflow', $3, $4) RETURNING id`,
      [guild.guildId, guild.channelId, eventDate, fakeId()],
    );
    return (rows[0] as { id: string }).id;
  };
  /**
   * Today in the fixture guild's zone. A step reminder can be claimed only for today or
   * yesterday there, so an event dated today is the latest one a test can claim on.
   */
  const guildToday = (): DateOnly =>
    todayInZone(new Date(), "America/New_York");
  const farDate = (offsetDays = 0): DateOnly => {
    const base = Date.UTC(3000 + Math.floor(Math.random() * 5000), 5, 15);
    return date(
      new Date(base + offsetDays * 86_400_000).toISOString().slice(0, 10),
    );
  };

  it("gives every new event its four steps, all open, with no one on them", async () => {
    const eventId = await insertEvent(pg, guild);
    expect(unwrap(await getEventWorkflow(db, key(eventId)))).toEqual({
      event_id: eventId,
      pickup_time: null,
      steps: [
        "budget_sheet",
        "engage_post",
        "budget_approved",
        "food_pickup",
      ].map((kind) => ({
        event_id: eventId,
        kind,
        status: "open",
        completed_at: null,
        completed_by: null,
        handoff_claimed_at: null,
        handoff_sent_at: null,
      })),
      assignees: [],
    });
  });

  it("reads several events at once, leaving out deleted ones and other guilds'", async () => {
    const first = await insertEvent(pg, guild);
    const second = await insertEvent(pg, guild);
    const deleted = await insertEvent(pg, guild);
    unwrap(await softDeleteEvent(db, key(deleted)));
    const other = await insertGuild(pg);
    const foreign = await insertEvent(pg, other);
    const user = fakeId();
    unwrap(await assign(first, "engage_post", user));

    const list = unwrap(
      await listEventWorkflows(db, {
        guildId: guild.guildId,
        eventIds: [first, second, deleted, foreign, UNKNOWN_ID],
      }),
    );
    expect(list.map((row) => row.event_id).sort()).toEqual(
      [first, second].sort(),
    );
    expect(list.find((row) => row.event_id === first)?.assignees).toMatchObject(
      [{ kind: "engage_post", user_id: user }],
    );
    expect(unwrap(await getEventWorkflow(db, key(foreign)))).toBeNull();
  });

  describe("assignments", () => {
    it("adds a person once, and takes them off again without losing the row", async () => {
      const eventId = await insertEvent(pg, guild);
      const user = fakeId();
      expect(await assign(eventId, "budget_sheet", user)).toEqual({
        ok: true,
        value: true,
      });
      expect(await assign(eventId, "budget_sheet", user)).toEqual({
        ok: true,
        value: false,
      });
      const input = {
        ...key(eventId),
        kind: "budget_sheet" as const,
        userId: user,
        actorId: guild.adminRoleId,
      };
      expect(await unassignEventStep(db, input)).toEqual({
        ok: true,
        value: true,
      });
      expect(await unassignEventStep(db, input)).toEqual({
        ok: true,
        value: false,
      });
      expect(
        unwrap(await getEventWorkflow(db, key(eventId)))?.assignees,
      ).toEqual([]);
      const { rows } = await pg.query(
        `SELECT removed_by, removed_at IS NOT NULL AS removed
         FROM public.event_step_assignees WHERE event_id = $1`,
        [eventId],
      );
      expect(rows).toEqual([{ removed_by: guild.adminRoleId, removed: true }]);

      // A removed person can be put back on.
      expect(await assign(eventId, "budget_sheet", user)).toEqual({
        ok: true,
        value: true,
      });
    });

    it(`stops at ${String(MAX_ASSIGNEES_PER_STEP)} people on a step`, async () => {
      const eventId = await insertEvent(pg, guild);
      for (let index = 0; index < MAX_ASSIGNEES_PER_STEP; index += 1) {
        unwrap(await assign(eventId, "engage_post"));
      }
      expect(await assign(eventId, "engage_post")).toEqual({
        ok: false,
        error: { category: "step_assignee_limit", code: "CF431" },
      });
      // Another step has its own limit.
      expect(await assign(eventId, "budget_sheet")).toEqual({
        ok: true,
        value: true,
      });
    });

    it(`allows ${String(MAX_FOOD_PICKUP_ASSIGNEES)} on Food pickup, whether or not the budget is approved`, async () => {
      const eventId = await insertEvent(pg, guild);
      for (let index = 0; index < MAX_FOOD_PICKUP_ASSIGNEES; index += 1) {
        unwrap(await assign(eventId, "food_pickup"));
      }
      expect(await assign(eventId, "food_pickup")).toEqual({
        ok: false,
        error: { category: "step_assignee_limit", code: "CF431" },
      });
    });

    it("refuses a closed event, and treats a deleted or foreign one as unknown", async () => {
      const closed = await insertEvent(pg, guild);
      unwrap(await closeEvent(db, key(closed)));
      expect(await assign(closed, "budget_sheet")).toEqual({
        ok: false,
        error: { category: "parent_unavailable", code: "CF410" },
      });

      const deleted = await insertEvent(pg, guild);
      unwrap(await softDeleteEvent(db, key(deleted)));
      expect(await assign(deleted, "budget_sheet")).toEqual(NOT_FOUND);

      const foreign = await insertEvent(pg, await insertGuild(pg));
      expect(await assign(foreign, "budget_sheet")).toEqual(NOT_FOUND);
      expect(await assign(UNKNOWN_ID, "budget_sheet")).toEqual(NOT_FOUND);
    });
  });

  describe("completing steps and hand-offs", () => {
    it("completes a step once, and hands it off exactly once", async () => {
      const eventId = await insertEvent(pg, guild);
      const handoff = { ...key(eventId), kind: "budget_sheet" as const };
      expect(await claimStepHandoff(db, handoff)).toEqual({
        ok: true,
        value: false,
      });

      const actor = fakeId();
      const complete = () =>
        completeEventStep(db, { ...handoff, actorId: actor });
      expect(await complete()).toEqual({ ok: true, value: true });
      expect(await complete()).toEqual({ ok: true, value: false });
      const step = unwrap(await getEventWorkflow(db, key(eventId)))?.steps[0];
      expect(step).toMatchObject({ status: "done", completed_by: actor });

      expect(await markStepHandoffSent(db, handoff)).toEqual({
        ok: true,
        value: false,
      });
      const claims = await Promise.all(
        Array.from({ length: 5 }, () => claimStepHandoff(db, handoff)),
      );
      expect(claims.filter((claim) => claim.ok && claim.value)).toHaveLength(1);
      expect(await markStepHandoffSent(db, handoff)).toEqual({
        ok: true,
        value: true,
      });
      expect(await markStepHandoffSent(db, handoff)).toEqual({
        ok: true,
        value: false,
      });
      expect(await claimStepHandoff(db, handoff)).toEqual({
        ok: true,
        value: false,
      });
    });

    it("keeps each step's hand-off apart", async () => {
      const eventId = await insertEvent(pg, guild);
      for (const kind of [
        "budget_sheet",
        "engage_post",
        "budget_approved",
      ] as const) {
        unwrap(
          await completeEventStep(db, {
            ...key(eventId),
            kind,
            actorId: fakeId(),
          }),
        );
        expect(await claimStepHandoff(db, { ...key(eventId), kind })).toEqual({
          ok: true,
          value: true,
        });
      }
    });

    it("refuses a closed event and an unknown one", async () => {
      const eventId = await insertEvent(pg, guild);
      unwrap(await closeEvent(db, key(eventId)));
      const input = { kind: "engage_post" as const, actorId: fakeId() };
      expect(
        await completeEventStep(db, { ...key(eventId), ...input }),
      ).toEqual({
        ok: false,
        error: { category: "parent_unavailable", code: "CF410" },
      });
      expect(
        await completeEventStep(db, { ...key(UNKNOWN_ID), ...input }),
      ).toEqual(NOT_FOUND);
    });
  });

  describe("food pickup", () => {
    it("is done once it has a time and a person, and reopens with no one on it", async () => {
      const eventId = await insertEvent(pg, guild);
      const actor = fakeId();
      const setTime = (pickupTime: string) =>
        setEventPickupTime(db, { ...key(eventId), pickupTime, actorId: actor });
      // The budget need not be approved first.
      expect(await setTime("17:30")).toEqual({ ok: true, value: false });
      const user = fakeId();
      unwrap(await assign(eventId, "food_pickup", user));
      let workflow = unwrap(await getEventWorkflow(db, key(eventId)));
      expect(workflow?.pickup_time).toBe("17:30");
      expect(workflow?.steps[3]).toMatchObject({
        kind: "food_pickup",
        status: "done",
        completed_by: guild.officerRoleId,
      });

      expect(await setTime("09:05")).toEqual({ ok: true, value: true });
      unwrap(
        await unassignEventStep(db, {
          ...key(eventId),
          kind: "food_pickup",
          userId: user,
          actorId: actor,
        }),
      );
      workflow = unwrap(await getEventWorkflow(db, key(eventId)));
      expect(workflow?.pickup_time).toBe("09:05");
      expect(workflow?.steps[3]).toMatchObject({
        status: "open",
        completed_at: null,
        completed_by: null,
      });
    });

    it("refuses an unknown event", async () => {
      expect(
        await setEventPickupTime(db, {
          ...key(UNKNOWN_ID),
          pickupTime: "12:00",
          actorId: fakeId(),
        }),
      ).toEqual(NOT_FOUND);
    });
  });

  it("lists a member's open steps and upcoming pickups for /mytasks", async () => {
    const user = fakeId();
    const today = date("2030-01-10");
    const upcoming = await insertEvent(pg, guild);
    const past = await datedEvent("2030-01-05");
    const closed = await insertEvent(pg, guild);
    unwrap(await assign(upcoming, "budget_sheet", user));
    unwrap(await assign(upcoming, "engage_post", user));
    unwrap(
      await completeEventStep(db, {
        ...key(upcoming),
        kind: "engage_post",
        actorId: user,
      }),
    );
    unwrap(await approve(upcoming));
    unwrap(await assign(upcoming, "food_pickup", user));
    unwrap(await approve(past));
    unwrap(await assign(past, "food_pickup", user));
    unwrap(await assign(past, "budget_sheet", user));
    unwrap(await assign(closed, "budget_sheet", user));
    unwrap(await closeEvent(db, key(closed)));

    const list = unwrap(
      await listOpenStepsForUser(db, {
        guildId: guild.guildId,
        userId: user,
        today,
      }),
    );
    expect(
      list.rows.map((row) => [row.event_id, row.kind, row.step_status]),
    ).toEqual([
      [upcoming, "budget_sheet", "open"],
      [upcoming, "food_pickup", "open"],
      [past, "budget_sheet", "open"],
    ]);
    expect(list.rows[2]?.event_name).toBe("Workflow");
  });

  it("keeps the soonest upcoming steps for /mytasks when a member has too many", async () => {
    const user = fakeId();
    const today = date("2030-01-10");
    // Older assignments on past events, more than the list holds, then two upcoming.
    for (let index = 0; index < 101; index++) {
      const past = await datedEvent("2029-12-01");
      unwrap(await assign(past, "budget_sheet", user));
    }
    const done = await datedEvent("2030-01-11");
    unwrap(await assign(done, "engage_post", user));
    unwrap(
      await completeEventStep(db, {
        ...key(done),
        kind: "engage_post",
        actorId: user,
      }),
    );
    const later = await datedEvent("2030-02-01");
    unwrap(await assign(later, "food_pickup", user));
    const sooner = await datedEvent("2030-01-12");
    unwrap(await assign(sooner, "budget_sheet", user));

    const list = unwrap(
      await listOpenStepsForUser(db, {
        guildId: guild.guildId,
        userId: user,
        today,
      }),
    );

    expect(list.truncated).toBe(true);
    expect(list.rows).toHaveLength(100);
    expect(list.rows.map((row) => row.event_id)).not.toContain(done);
    expect(
      list.rows.slice(0, 2).map((row) => [row.event_id, row.kind]),
    ).toEqual([
      [sooner, "budget_sheet"],
      [later, "food_pickup"],
    ]);
  });

  describe("event reminders", () => {
    it("lists a live event with its steps, live people and recent log", async () => {
      const eventDate = guildToday();
      const eventId = await datedEvent(eventDate);
      const user = fakeId();
      unwrap(await assign(eventId, "budget_sheet", user));
      const gone = fakeId();
      unwrap(await assign(eventId, "engage_post", gone));
      unwrap(
        await unassignEventStep(db, {
          ...key(eventId),
          kind: "engage_post",
          userId: gone,
          actorId: user,
        }),
      );
      const token = unwrap(
        await claimEventReminder(db, {
          eventId,
          kind: "daily_steps",
          reminderDate: eventDate,
        }),
      );
      expect(token).not.toBeNull();

      const list = unwrap(
        await listEventReminderCandidates(db, { fromDate: eventDate }),
      );
      const candidate = list.rows.find((row) => row.id === eventId);
      expect(candidate).toMatchObject({
        guild_id: guild.guildId,
        event_date: eventDate,
        timezone: "America/New_York",
        events_director_role_id: guild.officerRoleId,
        pickup_time: null,
        assignees: [{ kind: "budget_sheet", user_id: user }],
        log: [
          { kind: "daily_steps", reminder_date: eventDate, state: "claimed" },
        ],
      });
      expect(candidate?.steps).toHaveLength(4);

      // A later start leaves the event out, and a closed event is never listed.
      const later = unwrap(
        await listEventReminderCandidates(db, {
          fromDate: date(
            new Date(Date.parse(eventDate) + 86_400_000)
              .toISOString()
              .slice(0, 10),
          ),
        }),
      );
      expect(later.rows.some((row) => row.id === eventId)).toBe(false);
      unwrap(await closeEvent(db, key(eventId)));
      const afterClose = unwrap(
        await listEventReminderCandidates(db, { fromDate: eventDate }),
      );
      expect(afterClose.rows.some((row) => row.id === eventId)).toBe(false);
    });

    it("claims once, refuses a date after the event, and marks sent or skipped by token", async () => {
      const eventDate = guildToday();
      const eventId = await datedEvent(eventDate);
      const daily = {
        eventId,
        kind: "daily_steps" as const,
        reminderDate: eventDate,
      };
      const token = unwrap(await claimEventReminder(db, daily));
      expect(token).not.toBeNull();
      expect(await claimEventReminder(db, daily)).toEqual({
        ok: true,
        value: null,
      });
      expect(
        await claimEventReminder(db, {
          ...daily,
          reminderDate: date(
            new Date(Date.parse(eventDate) + 86_400_000)
              .toISOString()
              .slice(0, 10),
          ),
        }),
      ).toEqual({ ok: true, value: null });

      const messageId = fakeId();
      expect(
        await markEventReminderSent(db, {
          ...daily,
          claimToken: UNKNOWN_ID,
          messageId,
        }),
      ).toEqual({ ok: true, value: false });
      expect(
        await markEventReminderSent(db, {
          ...daily,
          claimToken: token ?? "",
          messageId,
        }),
      ).toEqual({ ok: true, value: true });

      const yesterday = date(
        new Date(Date.parse(eventDate) - 86_400_000).toISOString().slice(0, 10),
      );
      const skip = { ...daily, reminderDate: yesterday };
      const skipToken = unwrap(await claimEventReminder(db, skip));
      expect(
        await markEventReminderSkipped(db, {
          ...skip,
          claimToken: skipToken ?? "",
        }),
      ).toEqual({ ok: true, value: true });
    });

    it("sends pickup reminders only once Food pickup is set up, on their own dates", async () => {
      const eventDate = farDate();
      const eventId = await datedEvent(eventDate);
      const twoDaysBefore = date(
        new Date(Date.parse(eventDate) - 2 * 86_400_000)
          .toISOString()
          .slice(0, 10),
      );
      const pickupDay = {
        eventId,
        kind: "pickup_day" as const,
        reminderDate: eventDate,
      };
      const twoDays = {
        eventId,
        kind: "pickup_two_days" as const,
        reminderDate: twoDaysBefore,
      };
      expect(await claimEventReminder(db, pickupDay)).toEqual({
        ok: true,
        value: null,
      });

      unwrap(await approve(eventId));
      unwrap(
        await setEventPickupTime(db, {
          ...key(eventId),
          pickupTime: "11:00",
          actorId: fakeId(),
        }),
      );
      unwrap(await assign(eventId, "food_pickup"));

      expect(
        await claimEventReminder(db, {
          ...pickupDay,
          reminderDate: twoDaysBefore,
        }),
      ).toEqual({ ok: true, value: null });
      expect(
        await claimEventReminder(db, { ...twoDays, reminderDate: eventDate }),
      ).toEqual({ ok: true, value: null });
      expect(unwrap(await claimEventReminder(db, pickupDay))).not.toBeNull();
      expect(unwrap(await claimEventReminder(db, twoDays))).not.toBeNull();
    });

    it("takes over a claim left for over an hour, once", async () => {
      const eventDate = guildToday();
      const eventId = await datedEvent(eventDate);
      const daily = {
        eventId,
        kind: "daily_steps" as const,
        reminderDate: eventDate,
      };
      const token = unwrap(await claimEventReminder(db, daily)) ?? "";
      expect(
        await reclaimEventReminder(db, { ...daily, claimToken: token }),
      ).toEqual({
        ok: true,
        value: null,
      });

      await queryAs(
        pg,
        MIGRATION_OWNER,
        `UPDATE public.event_reminder_log SET claimed_at = now() - interval '2 hours'
         WHERE event_id = $1`,
        [eventId],
      );
      const stale = unwrap(
        await listStaleEventReminderClaims(db, {
          claimedBefore: new Date(Date.now() - 3_600_000),
        }),
      );
      expect(
        stale.rows.filter((row) => row.event_id === eventId),
      ).toMatchObject([
        {
          kind: "daily_steps",
          reminder_date: eventDate,
          claim_token: token,
          attempts: 1,
        },
      ]);

      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          reclaimEventReminder(db, { ...daily, claimToken: token }),
        ),
      );
      const fresh = results.flatMap((result) =>
        result.ok && result.value !== null ? [result.value] : [],
      );
      expect(fresh).toHaveLength(1);
      expect(
        await markEventReminderSent(db, {
          ...daily,
          claimToken: token,
          messageId: fakeId(),
        }),
      ).toEqual({ ok: true, value: false });
      expect(
        await markEventReminderSent(db, {
          ...daily,
          claimToken: fresh[0] ?? "",
          messageId: fakeId(),
        }),
      ).toEqual({ ok: true, value: true });
    });
  });

  describe("setup drafts", () => {
    const roles = () => ({
      officerRoleId: fakeId(),
      adminRoleId: fakeId(),
      eboardRoleId: fakeId(),
      eventsCommitteeRoleId: fakeId(),
      treasuryRoleId: fakeId(),
      marketingRoleId: fakeId(),
    });

    it("keeps one draft per guild, readable for an hour by the member who made it", async () => {
      const guildId = fakeId();
      const actorId = fakeId();
      const first = roles();
      const second = roles();
      const firstPrint = unwrap(
        await saveSetupDraft(db, { guildId, actorId, roles: first }),
      );
      const secondPrint = unwrap(
        await saveSetupDraft(db, { guildId, actorId, roles: second }),
      );
      const now = new Date();
      const read = (fingerprint: string, by = actorId, at = now) =>
        getSetupDraft(db, { guildId, actorId: by, fingerprint, now: at });

      expect(unwrap(await read(firstPrint))).toBeNull();
      expect(unwrap(await read(secondPrint))).toMatchObject({
        guild_id: guildId,
        actor_id: actorId,
        treasury_role_id: second.treasuryRoleId,
        fingerprint: secondPrint,
      });
      expect(unwrap(await read(secondPrint, fakeId()))).toBeNull();
      expect(
        unwrap(
          await read(
            secondPrint,
            actorId,
            new Date(now.getTime() + 2 * 3_600_000),
          ),
        ),
      ).toBeNull();
      const { rows } = await pg.query(
        `SELECT count(*)::int AS count FROM public.setup_drafts WHERE guild_id = $1`,
        [guildId],
      );
      expect(rows).toEqual([{ count: 1 }]);
    });
  });
});
