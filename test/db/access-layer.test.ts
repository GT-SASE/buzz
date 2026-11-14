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
  searchOpenEvents,
  searchOpenEventsByIdPrefix,
} from "../../src/db/task-events.ts";
import {
  finishJobRun,
  getLatestJobRun,
  beginJobRun,
} from "../../src/db/job-runs.ts";
import {
  getManagedChannel,
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
  createTask,
  editTask,
  searchOpenTasksByIdPrefix,
  searchOwnOpenTasksByIdPrefix,
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
import {
  parseIsoDate,
  todayInZone,
  type DateOnly,
} from "../../src/lib/dates.ts";
import { slotStart } from "../../src/reminders/plan.ts";
import { openBackend, type Backend } from "./backend.ts";
import {
  insertEvent,
  insertGuild,
  insertTask,
  withoutQuotas,
  type GuildFixture,
} from "./fixtures.ts";
import {
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

/** The limits the database's triggers enforce. */
const EVENT_TASK_LIMIT = 100;
const OFFICER_DAILY_LIMIT = 50;

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
  });

  describe("managed channels", () => {
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

    describe("the post attempt", () => {
      const attemptAgo = (eventId: string, seconds: number) =>
        pg.query(
          `UPDATE public.events
           SET post_attempt_at = now() - make_interval(secs => $2)
           WHERE id = $1`,
          [eventId, seconds],
        );

      it("goes to one caller, and stays held however long ago it began", async () => {
        const event = unwrap(await newEvent("Attempted"));
        const key = { guildId: guild.guildId, eventId: event.id };

        expect(unwrap(await claimEventPostAttempt(db, key))).toBe(true);
        expect(unwrap(await claimEventPostAttempt(db, key))).toBe(false);

        await attemptAgo(event.id, 61);
        expect(unwrap(await claimEventPostAttempt(db, key))).toBe(false);

        await attemptAgo(event.id, 86_400);
        expect(unwrap(await claimEventPostAttempt(db, key))).toBe(false);
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

    it("changes nothing for another guild's event, a deleted one or an unknown one", async () => {
      const key0 = { guildId: guild.guildId };
      const other = await insertGuild(pg);
      const foreign = await insertEvent(pg, other);
      const unknown = await getEvent(db, {
        guildId: guild.guildId,
        eventId: UNKNOWN_ID,
      });
      expect(
        await getEvent(db, { guildId: guild.guildId, eventId: foreign }),
      ).toEqual(unknown);

      const deleted = await insertEvent(pg, guild);
      await linkThread(guild.guildId, deleted);
      unwrap(
        await softDeleteEvent(db, { guildId: guild.guildId, eventId: deleted }),
      );
      const before = [await eventState(foreign), await eventState(deleted)];
      const writes = (eventId: string) => {
        const key = { guildId: guild.guildId, eventId };
        return Promise.all([
          closeEvent(db, key),
          softDeleteEvent(db, key),
          setEventThread(db, { ...key, threadId: fakeId() }),
          markEventThreadMissing(db, key),
          setEventOverviewMessage(db, { ...key, messageId: fakeId() }),
          attachEventPost(db, {
            ...key,
            threadId: fakeId(),
            overviewMessageId: fakeId(),
          }),
        ]);
      };
      for (const eventId of [foreign, deleted, UNKNOWN_ID]) {
        expect(await writes(eventId)).toEqual(Array(6).fill(NOT_FOUND));
        expect(
          unwrap(await claimEventPostAttempt(db, { ...key0, eventId })),
        ).toBe(false);
      }
      expect([await eventState(foreign), await eventState(deleted)]).toEqual(
        before,
      );
      expect(
        unwrap(await getEvent(db, { guildId: other.guildId, eventId: foreign }))
          ?.status,
      ).toBe("active");
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

    it.each([
      ["SPRING", ["Spring social"]],
      ["%", ["Budget 100%"]],
      ["_", ["snake_case meeting"]],
      ["\\", ["Back\\slash"]],
      ["*", []],
      ["S*g", []],
      [",", ['Quoted "name", (with) dots.']],
      [")", ['Quoted "name", (with) dots.']],
      [".", ['Quoted "name", (with) dots.']],
      ['"', ['Quoted "name", (with) dots.']],
      ['"name", (with', ['Quoted "name", (with) dots.']],
      ["x,deleted_at.not.is.null", []],
      ["x)&deleted_at=not.is.null", []],
    ])("finds %j as plain text, ignoring case", async (term, names) => {
      expect(await namesFor(term)).toEqual(names);
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

    it("answers the same for another guild's task as for an unknown one", async () => {
      const other = await insertGuild(pg);
      const foreign = await insertTask(pg, other, await insertEvent(pg, other));
      const before = await taskState(foreign);
      const version = await versionOf(other.guildId, foreign);
      const assigneeId = before?.assignee_id ?? "";
      const call = (taskId: string) => {
        const key = { guildId: guild.guildId, taskId };
        const edit = { ...key, expectedUpdatedAt: version };
        return Promise.all([
          getTask(db, key),
          markTaskDoneAsOfficer(db, { ...key, now: NOW }),
          markOwnTaskDone(db, { ...key, assigneeId, now: NOW }),
          softDeleteTask(db, { ...key, now: NOW }),
          setTaskDescription(db, { ...edit, description: "taken" }),
          setTaskDueDate(db, { ...edit, dueDate: date("2031-01-01") }),
          reassignTask(db, { ...edit, assigneeId: fakeId() }),
        ]);
      };
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
  });

  describe("reminder candidates", () => {
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

    const configChange = (
      own: GuildFixture,
      change: { remindersEnabled?: boolean; removeChannelIds?: string[] },
    ) =>
      applyConfigChange(db, {
        guildId: own.guildId,
        actorId: fakeId(),
        expectedVersion: 2,
        remindersEnabled: change.remindersEnabled ?? null,
        addChannelIds: [],
        removeChannelIds: change.removeChannelIds ?? [],
        timezone: null,
      });

    type Made = Awaited<ReturnType<typeof setUp>>;
    it.each<[string, (made: Made) => Promise<unknown>]>([
      [
        "due after the last date",
        async ({ own, taskId }) =>
          setTaskDueDate(db, {
            guildId: own.guildId,
            taskId,
            expectedUpdatedAt: await versionOf(own.guildId, taskId),
            dueDate: date("2030-01-11"),
          }),
      ],
      [
        "done",
        ({ own, taskId }) =>
          markTaskDoneAsOfficer(db, { guildId: own.guildId, taskId, now: NOW }),
      ],
      [
        "deleted",
        ({ own, taskId }) =>
          softDeleteTask(db, { guildId: own.guildId, taskId, now: NOW }),
      ],
      [
        "in a guild with reminders off",
        ({ own }) => configChange(own, { remindersEnabled: false }),
      ],
      [
        "in a removed channel",
        ({ own }) => configChange(own, { removeChannelIds: [own.channelId] }),
      ],
      [
        "in an unavailable channel",
        ({ own }) =>
          markChannelUnavailable(db, {
            guildId: own.guildId,
            channelId: own.channelId,
          }),
      ],
      [
        "under a closed event",
        ({ own, eventId }) => closeEvent(db, { guildId: own.guildId, eventId }),
      ],
      [
        "under a deleted event",
        ({ own, eventId }) =>
          softDeleteEvent(db, { guildId: own.guildId, eventId }),
      ],
      [
        "live under an event that alone was deleted",
        async ({ eventId }) => {
          await deleteEventOnly(eventId);
          return { ok: true, value: null };
        },
      ],
    ])("leaves out a task %s", async (_name, stop) => {
      const made = await setUp();
      unwrap((await stop(made)) as DbResult<unknown>);
      expect(await candidateIds()).not.toContain(made.taskId);
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

      it(`refuses task ${String(EVENT_TASK_LIMIT + 1)} on one event, until one is deleted`, async () => {
        const eventId = await insertEvent(pg, own);
        await fill(eventId, EVENT_TASK_LIMIT, fakeId);

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

      it(`refuses an officer's task ${String(OFFICER_DAILY_LIMIT + 1)} in a day, counting deleted ones`, async () => {
        const actorId = fakeId();
        const eventId = await insertEvent(pg, own);
        const secondEvent = await insertEvent(pg, own);
        await fill(eventId, OFFICER_DAILY_LIMIT, () => actorId);

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
        for (let i = 1; i < OFFICER_DAILY_LIMIT; i += 1) {
          unwrap(await reassign());
        }

        expect(await reassign()).toEqual(actorLimit);
        expect(await newTaskOn(eventId, fakeId(), actorId)).toEqual(actorLimit);
        unwrap(await newTaskOn(eventId, fakeId(), fakeId()));
      });

      it("counts per guild, so another guild's officer limit is its own", async () => {
        const other = await insertGuild(pg);
        const actorId = fakeId();
        const eventId = await insertEvent(pg, own);
        const otherEvent = await insertEvent(pg, other);
        await fill(eventId, OFFICER_DAILY_LIMIT, () => actorId);

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
        await fill(eventId, EVENT_TASK_LIMIT, fakeId);
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

    it("skips a claim", async () => {
      const key = await newKey();
      const token = unwrap(await claimReminder(db, key));
      expect(
        unwrap(
          await markReminderSkipped(db, { ...key, claimToken: token ?? "" }),
        ),
      ).toBe(true);
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

    it("leaves a fresh claim, and a finished one however old, off the stale list", async () => {
      const fresh = await newKey();
      unwrap(await claimReminder(db, fresh));
      expect(await staleTaskIds()).not.toContain(fresh.taskId);

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
        await beginJobRun(db, {
          jobName,
          staleAfterSeconds: 120,
          slotStart: new Date(slotStart(new Date())),
        }),
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
  it("gives every new event its four steps, all open, with no one on them", async () => {
    const eventId = await insertEvent(pg, guild);
    expect(unwrap(await getEventWorkflow(db, key(eventId)))).toEqual({
      event_id: eventId,
      // insertEvent dates the event 2030-01-15, in a guild in New York.
      event_date: "2030-01-15",
      pickup_time: null,
      timezone: "America/New_York",
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

    it("sends pickup reminders only once Food pickup is set up", async () => {
      const eventDate = guildToday();
      const eventId = await datedEvent(eventDate);
      const pickupDay = {
        eventId,
        kind: "pickup_day" as const,
        reminderDate: eventDate,
      };
      const twoDays = {
        eventId,
        kind: "pickup_before" as const,
        reminderDate: eventDate,
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

      expect(unwrap(await claimEventReminder(db, pickupDay))).not.toBeNull();
      expect(unwrap(await claimEventReminder(db, twoDays))).not.toBeNull();
    });

    it("takes over a stale claim, once", async () => {
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
