import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
  listOpenStepsForUser,
  markEventReminderSent,
  markStepHandoffSent,
  MAX_ASSIGNEES_PER_STEP,
  MAX_FOOD_PICKUP_ASSIGNEES,
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
} from "../../src/db/task-events.ts";
import {
  finishJobRun,
  getLatestJobRun,
  beginJobRun,
} from "../../src/db/job-runs.ts";
import {
  getManagedChannel,
  listManagedChannels,
  markChannelUnavailable,
} from "../../src/db/managed-channels.ts";
import {
  claimReminder,
  listReminderCandidates,
  listStaleClaims,
  markReminderSent,
  reclaimReminder,
  resolveStaleClaim,
} from "../../src/db/reminders.ts";
import {
  countOpenTasksInChannel,
  createTask,
  editTask,
  getTask,
  listOpenTasksForAssignee,
  markOwnTaskDone,
  markTaskDoneAsOfficer,
  searchOpenTasks,
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

/** Awaits a database call and returns its value, failing the test on an error. */
async function ok<T>(call: Promise<DbResult<T>>): Promise<T> {
  return unwrap(await call);
}

const NOW = new Date("2030-01-01T12:00:00.000Z");
const LATER = new Date("2031-01-01T00:00:00.000Z");
const DUE = date("2030-01-10");
const UNKNOWN_ID = "99999999-9999-4999-8999-999999999999";
const NOT_FOUND = {
  ok: false,
  error: { category: "not_found", code: null },
} as const;
const CONFLICT = {
  ok: false,
  error: { category: "conflict", code: "23505" },
} as const;
const UNAVAILABLE = {
  ok: false,
  error: { category: "parent_unavailable", code: "CF410" },
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
    const { rows } = await pg.query(
      `SELECT thread_status, overview_message_id, deleted_at IS NOT NULL AS deleted
       FROM public.events WHERE id = $1`,
      [eventId],
    );
    return rows[0];
  };

  /** The version an edit must name: the updated_at the caller last read. */
  const versionOf = async (guildId: string, taskId: string) => {
    const row = await ok(getTask(db, { guildId, taskId }));
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

  const linkThread = async (guildId: string, eventId: string) => {
    const threadId = fakeId();
    await ok(setEventThread(db, { guildId, eventId, threadId }));
    return threadId;
  };

  const configChange = (
    own: GuildFixture,
    change: {
      expectedVersion?: number;
      remindersEnabled?: boolean;
      removeChannelIds?: string[];
      timezone?: string;
    },
  ) =>
    applyConfigChange(db, {
      guildId: own.guildId,
      actorId: fakeId(),
      expectedVersion: change.expectedVersion ?? 2,
      remindersEnabled: change.remindersEnabled ?? null,
      addChannelIds: [],
      removeChannelIds: change.removeChannelIds ?? [],
      timezone: change.timezone ?? null,
    });

  describe("config", () => {
    it("sets up a guild, reads it back and refuses a stale version", async () => {
      const guildId = fakeId();
      const officerRoleId = fakeId();
      const adminRoleId = fakeId();
      const treasuryRoleId = fakeId();
      const bindings = {
        guildId,
        actorId: fakeId(),
        expectedVersion: 0,
        officerRoleId,
        adminRoleId,
        eboardRoleId: null,
        eventsCommitteeRoleId: null,
        treasuryRoleId,
        marketingRoleId: null,
      };

      expect(await ok(getGuildConfig(db, { guildId }))).toBeNull();
      expect(await ok(applyRoleBindings(db, bindings))).toBe(1);
      expect(await ok(getGuildConfig(db, { guildId }))).toEqual({
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

    it("applies a change with audit rows, newest first and capped at five", async () => {
      const own = await insertGuild(pg);
      const actorId = fakeId();
      const change = applyConfigChange(db, {
        guildId: own.guildId,
        actorId,
        expectedVersion: 2,
        remindersEnabled: false,
        addChannelIds: [fakeId()],
        removeChannelIds: [],
        timezone: "Europe/London",
      });
      expect(await ok(change)).toBe(3);
      expect(
        await ok(getGuildConfig(db, { guildId: own.guildId })),
      ).toMatchObject({ reminders_enabled: false, timezone: "Europe/London" });

      const audit = () => ok(listRecentConfigChanges(db, own));
      const first = await audit();
      expect(first.truncated).toBe(false);
      expect(first.rows.map((row) => row.version_after)).toEqual([3, 2, 1]);
      expect(first.rows[0]).toMatchObject({
        actor_id: actorId,
        action: "settings",
      });
      expect(first.rows[2]?.old_values).toBeNull();

      for (let version = 3; version < 8; version += 1) {
        await ok(
          configChange(own, {
            expectedVersion: version,
            remindersEnabled: version % 2 === 0,
          }),
        );
      }
      const { rows, truncated } = await audit();
      expect(rows.map((row) => row.version_after)).toEqual([8, 7, 6, 5, 4]);
      expect(truncated).toBe(true);
    });
  });

  it("marks a managed channel unavailable once", async () => {
    const own = await insertGuild(pg);
    const key = { guildId: own.guildId, channelId: own.channelId };
    expect(await ok(markChannelUnavailable(db, key))).toBe(true);
    expect(await ok(markChannelUnavailable(db, key))).toBe(false);
    expect((await ok(getManagedChannel(db, key)))?.status).toBe("unavailable");
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
    const post = (eventId: string) =>
      attachEventPost(db, {
        guildId: guild.guildId,
        eventId,
        threadId: fakeId(),
        overviewMessageId: fakeId(),
      });

    it("creates a pending event, refusing a second by the same officer until it has a post", async () => {
      const create = (actorId: string) =>
        createEvent(db, {
          guildId: guild.guildId,
          channelId: guild.channelId,
          actorId,
          name: "Retried",
          eventDate: DUE,
        });
      const officer = fakeId();
      const first = await ok(create(officer));
      expect(first).toMatchObject({
        name: "Retried",
        event_date: DUE,
        status: "active",
        thread_status: "pending",
        thread_id: null,
      });
      expect(await ok(getEvent(db, { ...guild, eventId: first.id }))).toEqual(
        first,
      );
      expect(await create(officer)).toEqual(CONFLICT);

      expect(await ok(post(first.id))).toMatchObject({
        thread_status: "active",
      });
      expect(await post(first.id)).toEqual(NOT_FOUND);
      expect((await create(officer)).ok).toBe(true);
    });

    it("gives the post attempt to one caller until given back, and none once posted", async () => {
      const event = await ok(newEvent("Attempted"));
      const key = { guildId: guild.guildId, eventId: event.id };
      const claim = () => ok(claimEventPostAttempt(db, key));

      expect(await claim()).toBe(true);
      expect(await claim()).toBe(false);
      await pg.query(
        `UPDATE public.events SET post_attempt_at = now() - interval '1 day' WHERE id = $1`,
        [event.id],
      );
      expect(await claim()).toBe(false);
      expect(await ok(releaseEventPostAttempt(db, key))).toBe(true);
      expect(await claim()).toBe(true);

      await linkThread(guild.guildId, event.id);
      expect(await claim()).toBe(false);
      expect(await ok(releaseEventPostAttempt(db, key))).toBe(false);
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
      const live = await ok(newEvent("Live", own));

      const { rows, truncated } = await ok(listEvents(db, own));
      expect(rows[0]?.id).toBe(live.id);
      expect(rows).toHaveLength(100);
      expect(truncated).toBe(true);
      const found = await ok(searchEvents(db, { ...own, term: "" }));
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
      const first = await ok(linked());
      expect(first).toMatchObject({
        thread_id: threadId,
        thread_status: "active",
        overview_message_id: null,
      });
      expect(await linked()).toEqual(CONFLICT);

      await ok(softDeleteEvent(db, { ...guild, eventId: first.id }));
      expect((await ok(linked())).thread_id).toBe(threadId);
    });

    it("refuses an event on a removed channel", async () => {
      const own = await insertGuild(pg);
      await queryAs(
        pg,
        MIGRATION_OWNER,
        `UPDATE public.managed_channels SET status = 'removed' WHERE guild_id = $1`,
        [own.guildId],
      );
      expect(await newEvent("Social", own)).toEqual(UNAVAILABLE);
    });

    it("hides a deleted event, and changes nothing for it, another guild's or an unknown one", async () => {
      const other = await insertGuild(pg);
      const foreign = await insertEvent(pg, other);
      expect(await getEvent(db, { ...guild, eventId: foreign })).toEqual(
        await getEvent(db, { ...guild, eventId: UNKNOWN_ID }),
      );

      const deleted = await insertEvent(pg, guild);
      await linkThread(guild.guildId, deleted);
      await insertTask(pg, guild, deleted);
      // The count is of the tasks deleted with it.
      expect(
        await ok(softDeleteEvent(db, { ...guild, eventId: deleted })),
      ).toBe(1);
      expect(await ok(getEvent(db, { ...guild, eventId: deleted }))).toBeNull();
      const { rows } = await ok(listEvents(db, guild));
      expect(rows.map((row) => row.id)).not.toContain(deleted);
      const before = [await eventState(foreign), await eventState(deleted)];
      const writes = (eventId: string) => {
        const key = { guildId: guild.guildId, eventId };
        return Promise.all([
          closeEvent(db, key),
          softDeleteEvent(db, key),
          setEventThread(db, { ...key, threadId: fakeId() }),
          markEventThreadMissing(db, key),
          setEventOverviewMessage(db, { ...key, messageId: fakeId() }),
          post(eventId),
          claimEventPostAttempt(db, key),
        ]);
      };
      for (const eventId of [foreign, deleted, UNKNOWN_ID]) {
        expect<unknown[]>(await writes(eventId)).toEqual([
          ...Array<unknown>(6).fill(NOT_FOUND),
          { ok: true, value: false },
        ]);
      }
      expect([await eventState(foreign), await eventState(deleted)]).toEqual(
        before,
      );
      const theirs = await ok(getEvent(db, { ...other, eventId: foreign }));
      expect(theirs?.status).toBe("active");
    });

    it("links a thread, marks it missing, links again, sets the overview and closes once", async () => {
      const key = { ...guild, eventId: (await ok(newEvent())).id };
      expect(await markEventThreadMissing(db, key)).toEqual(NOT_FOUND);

      const threadId = fakeId();
      expect(await ok(setEventThread(db, { ...key, threadId }))).toMatchObject({
        thread_id: threadId,
        thread_status: "active",
      });
      expect(await setEventThread(db, { ...key, threadId })).toEqual(NOT_FOUND);
      // Another live event cannot take the same thread.
      const second = { ...guild, eventId: (await ok(newEvent())).id };
      expect(await setEventThread(db, { ...second, threadId })).toEqual(
        CONFLICT,
      );

      const missing = await ok(markEventThreadMissing(db, key));
      expect(missing.thread_status).toBe("missing");
      const relinked = await ok(
        setEventThread(db, { ...key, threadId: fakeId() }),
      );
      expect(relinked.thread_status).toBe("active");

      const messageId = fakeId();
      const overview = await ok(
        setEventOverviewMessage(db, { ...key, messageId }),
      );
      expect(overview.overview_message_id).toBe(messageId);
      expect((await ok(closeEvent(db, key))).status).toBe("closed");
      expect(await closeEvent(db, key)).toEqual(NOT_FOUND);
    });
  });

  describe("autocomplete", () => {
    let own: GuildFixture;

    const named = async (name: string, where: GuildFixture = own) =>
      (
        await ok(
          createEvent(db, {
            guildId: where.guildId,
            channelId: where.channelId,
            actorId: fakeId(),
            name,
            eventDate: DUE,
          }),
        )
      ).id;

    const namesFor = async (term: string) =>
      (await ok(searchEvents(db, { guildId: own.guildId, term }))).map(
        (row) => row.name,
      );

    beforeAll(async () => {
      own = await insertGuild(pg);
      await named("Spring social");
      await named("Budget 100%");
    });

    it.each([
      ["SPRING", ["Spring social"]],
      ["%", ["Budget 100%"]],
      ["x,deleted_at.not.is.null", []],
    ])("finds %j as plain text, ignoring case", async (term, names) => {
      expect(await namesFor(term)).toEqual(names);
    });

    it("leaves out deleted events and other guilds", async () => {
      const id = await named("Hidden event");
      await named("Hidden event", await insertGuild(pg));
      expect(await namesFor("Hidden")).toEqual(["Hidden event"]);
      await ok(softDeleteEvent(db, { guildId: own.guildId, eventId: id }));
      expect(await namesFor("Hidden")).toEqual([]);
    });
  });

  describe("tasks", () => {
    let eventId: string;

    beforeAll(async () => {
      eventId = await insertEvent(pg, guild);
    });

    const newTask = async (assigneeId: string = fakeId()) => {
      const task = await ok(
        createTask(db, {
          guildId: guild.guildId,
          eventId,
          assigneeId,
          actorId: fakeId(),
          description: "Book the room",
          dueDate: DUE,
        }),
      );
      return { assigneeId, taskId: task.id };
    };

    it("stores text with every hostile character intact", async () => {
      const { taskId } = await newTask();
      const description = `a,b).c"*%_\\ ' ; DROP TABLE tasks; -- \u{1F389}`;
      const edited = await ok(
        setTaskDescription(db, {
          guildId: guild.guildId,
          taskId,
          expectedUpdatedAt: await versionOf(guild.guildId, taskId),
          description,
        }),
      );
      expect(edited.description).toBe(description);
    });

    it("lets the assignee mark their task done, and no one else", async () => {
      const { taskId, assigneeId } = await newTask();
      const key = { guildId: guild.guildId, taskId, now: NOW };
      expect(
        await markOwnTaskDone(db, { ...key, assigneeId: fakeId() }),
      ).toEqual(NOT_FOUND);
      expect((await taskState(taskId))?.status).toBe("open");

      const done = await ok(markOwnTaskDone(db, { ...key, assigneeId }));
      expect(done.status).toBe("done");
      expect(new Date(done.completed_at ?? "").toISOString()).toBe(
        NOW.toISOString(),
      );
    });

    it("refuses an edit based on an old version, keeping the later one", async () => {
      const { taskId } = await newTask();
      const key = { guildId: guild.guildId, taskId };
      const stale = {
        ...key,
        expectedUpdatedAt: await versionOf(key.guildId, taskId),
      };

      await ok(setTaskDescription(db, { ...stale, description: "First" }));
      expect<unknown[]>(
        await Promise.all([
          setTaskDescription(db, { ...stale, description: "Second" }),
          setTaskDueDate(db, { ...stale, dueDate: date("2031-01-01") }),
          reassignTask(db, { ...stale, assigneeId: fakeId() }),
        ]),
      ).toEqual(Array(3).fill(NOT_FOUND));
      expect(await taskState(taskId)).toMatchObject({
        description: "First",
        due_date: DUE,
      });
    });

    it("finishes and soft-deletes a task once each, keeping the first time", async () => {
      const { taskId } = await newTask();
      const key = { guildId: guild.guildId, taskId };
      const first = await ok(markTaskDoneAsOfficer(db, { ...key, now: NOW }));
      expect(await markTaskDoneAsOfficer(db, { ...key, now: LATER })).toEqual(
        NOT_FOUND,
      );
      expect((await ok(getTask(db, key)))?.completed_at).toBe(
        first.completed_at,
      );

      const stamped = async () =>
        (
          await pg.query<{ deleted_at: Date }>(
            `SELECT deleted_at FROM public.tasks WHERE id = $1`,
            [taskId],
          )
        ).rows[0]?.deleted_at;
      await ok(softDeleteTask(db, { ...key, now: NOW }));
      const deletedAt = await stamped();
      expect(await softDeleteTask(db, { ...key, now: LATER })).toEqual(
        NOT_FOUND,
      );
      expect(await stamped()).toEqual(deletedAt);
      expect(await ok(getTask(db, key))).toBeNull();
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
      const created = await createTask(db, {
        guildId: guild.guildId,
        eventId: await insertEvent(pg, other),
        assigneeId: fakeId(),
        actorId: fakeId(),
        description: "Sneak in",
        dueDate: DUE,
      });
      expect(created).toEqual({
        ok: false,
        error: { category: "constraint", code: "23503" },
      });
    });

    it("keeps a task under a deleted event deleted through every write", async () => {
      const ownEvent = await insertEvent(pg, guild);
      const assigneeId = fakeId();
      const taskId = await insertTask(pg, guild, ownEvent, assigneeId);
      const expectedUpdatedAt = await versionOf(guild.guildId, taskId);
      await ok(softDeleteEvent(db, { ...guild, eventId: ownEvent }));
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
      expect<unknown[]>(writes).toEqual(Array(6).fill(NOT_FOUND));
      expect(await taskState(taskId)).toEqual({
        status: "open",
        assignee_id: assigneeId,
        deleted: true,
        description: "Book the room",
        due_date: DUE,
      });
      expect(await ok(getTask(db, key))).toBeNull();
    });

    it("lists a member's open tasks soonest first, with the event's name", async () => {
      const assigneeId = fakeId();
      const later = await newTask(assigneeId);
      const sooner = await newTask(assigneeId);
      await ok(
        setTaskDueDate(db, {
          guildId: guild.guildId,
          taskId: sooner.taskId,
          expectedUpdatedAt: await versionOf(guild.guildId, sooner.taskId),
          dueDate: date("2030-01-05"),
        }),
      );
      const { rows, truncated } = await ok(
        listOpenTasksForAssignee(db, { guildId: guild.guildId, assigneeId }),
      );
      expect(truncated).toBe(false);
      expect(rows.map((row) => row.id)).toEqual([sooner.taskId, later.taskId]);
      expect(rows[0]?.event_name).toBe("General meeting");
      expect<string>(rows[0]?.due_date ?? "").toBe("2030-01-05");
    });

    it("counts open tasks across a forum's events, and nothing else", async () => {
      const own = await insertGuild(pg);
      const other = await insertGuild(pg);
      const first = await insertEvent(pg, own);
      const deletedEvent = await insertEvent(pg, own);
      await insertTask(pg, own, first);
      await insertTask(pg, own, await insertEvent(pg, own));
      await insertTask(pg, other, await insertEvent(pg, other));
      await insertTask(pg, own, deletedEvent);
      const done = await insertTask(pg, own, first);
      const deleted = await insertTask(pg, own, first);
      const key = (taskId: string) => ({ ...own, taskId, now: NOW });
      await ok(markTaskDoneAsOfficer(db, key(done)));
      await ok(softDeleteTask(db, key(deleted)));
      await ok(softDeleteEvent(db, { ...own, eventId: deletedEvent }));

      const count = (guildId: string) =>
        ok(countOpenTasksInChannel(db, { guildId, channelId: own.channelId }));
      expect(await count(own.guildId)).toEqual({ count: 2, truncated: false });
      expect(await count(other.guildId)).toEqual({
        count: 0,
        truncated: false,
      });
    });
  });

  describe("reminder candidates", () => {
    const candidateIds = async () =>
      (await ok(listReminderCandidates(db, { lastDueDate: DUE }))).rows.map(
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
      const { rows } = await ok(
        listReminderCandidates(db, { lastDueDate: DUE }),
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

    type Made = Awaited<ReturnType<typeof setUp>>;
    it.each<[string, (made: Made) => Promise<unknown>]>([
      [
        "done",
        ({ own, taskId }) =>
          markTaskDoneAsOfficer(db, { ...own, taskId, now: NOW }),
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
        "live under an event that alone was deleted",
        async ({ eventId }) => {
          await queryAs(
            pg,
            MIGRATION_OWNER,
            `UPDATE public.events SET deleted_at = now() WHERE id = $1`,
            [eventId],
          );
          return { ok: true, value: null };
        },
      ],
    ])("leaves out a task %s", async (_name, stop) => {
      const made = await setUp();
      unwrap((await stop(made)) as DbResult<unknown>);
      expect(await candidateIds()).not.toContain(made.taskId);
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
      const threadId = await linkThread(own.guildId, eventId);
      const find = (guildId: string) =>
        ok(findEventByThread(db, { guildId, threadId }));

      expect((await find(own.guildId))?.id).toBe(eventId);
      expect(await find(other.guildId)).toBeNull();
      await ok(closeEvent(db, { ...own, eventId }));
      expect((await find(own.guildId))?.status).toBe("closed");
      await ok(softDeleteEvent(db, { ...own, eventId }));
      expect(await find(own.guildId)).toBeNull();
    });

    it("offers only open events of this guild in the event picker", async () => {
      const open = await insertEvent(pg, own);
      const closed = await insertEvent(pg, own);
      const foreign = await insertEvent(pg, await insertGuild(pg));
      await ok(closeEvent(db, { ...own, eventId: closed }));

      const found = await ok(searchOpenEvents(db, { ...own, term: "meeting" }));
      const ids = found.map((row) => row.id);
      expect(ids).toContain(open);
      expect(ids).not.toContain(closed);
      expect(ids).not.toContain(foreign);
    });

    it("refuses every change of work on a closed event's task, but lets it be deleted", async () => {
      const eventId = await insertEvent(pg, own);
      const task = await ok(newTaskOn(eventId, fakeId(), fakeId()));
      await ok(closeEvent(db, { ...own, eventId }));
      const key = { guildId: own.guildId, taskId: task.id };

      const edited = await editTask(db, {
        actorId: fakeId(),
        ...key,
        expectedUpdatedAt: task.updated_at,
        description: "Changed",
        dueDate: DUE,
        assigneeId: task.assignee_id,
      });
      expect(edited).toEqual(UNAVAILABLE);
      expect(await markTaskDoneAsOfficer(db, { ...key, now: NOW })).toEqual(
        UNAVAILABLE,
      );
      expect(
        await markOwnTaskDone(db, {
          ...key,
          assigneeId: task.assignee_id,
          now: NOW,
        }),
      ).toEqual(UNAVAILABLE);
      expect((await taskState(task.id))?.status).toBe("open");

      await ok(softDeleteTask(db, { ...key, now: NOW }));
      expect((await taskState(task.id))?.deleted).toBe(true);
      expect(await ok(softDeleteEvent(db, { ...own, eventId }))).toBe(0);
    });

    it("edits all three fields in one write", async () => {
      const eventId = await insertEvent(pg, own);
      const task = await ok(newTaskOn(eventId, fakeId(), fakeId()));
      const assigneeId = fakeId();
      const edit = {
        actorId: fakeId(),
        guildId: own.guildId,
        taskId: task.id,
        description: "Print the banner",
        dueDate: date("2030-02-02"),
        assigneeId,
      };

      const edited = await ok(
        editTask(db, { ...edit, expectedUpdatedAt: task.updated_at }),
      );
      expect(edited).toMatchObject({
        description: "Print the banner",
        due_date: "2030-02-02",
        assignee_id: assigneeId,
      });
    });

    describe("task quotas", () => {
      const actorLimit = {
        ok: false,
        error: { category: "actor_task_limit", code: "CF430" },
      } as const;

      async function fill(
        eventId: string,
        count: number,
        actorId: () => string,
      ) {
        for (let index = 0; index < count; index += 1) {
          await ok(newTaskOn(eventId, fakeId(), actorId()));
        }
      }

      it(`refuses task ${String(EVENT_TASK_LIMIT + 1)} on one event, until one is deleted`, async () => {
        const eventId = await insertEvent(pg, own);
        await fill(eventId, EVENT_TASK_LIMIT, fakeId);
        expect(await newTaskOn(eventId, fakeId(), fakeId())).toEqual({
          ok: false,
          error: { category: "event_task_limit", code: "CF429" },
        });

        const { rows } = await pg.query<{ id: string }>(
          `SELECT id FROM public.tasks WHERE event_id = $1 LIMIT 1`,
          [eventId],
        );
        const taskId = rows[0]?.id ?? "";
        await ok(softDeleteTask(db, { ...own, taskId, now: NOW }));
        await ok(newTaskOn(eventId, fakeId(), fakeId()));
      });

      it(`refuses an officer's task ${String(OFFICER_DAILY_LIMIT + 1)} in a day, counting deleted ones, per guild`, async () => {
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
        await ok(newTaskOn(secondEvent, fakeId(), fakeId()));

        const other = await insertGuild(pg);
        const elsewhere = createTask(db, {
          guildId: other.guildId,
          eventId: await insertEvent(pg, other),
          assigneeId: fakeId(),
          actorId,
          description: "Print the signs",
          dueDate: DUE,
        });
        expect((await elsewhere).ok).toBe(true);
      });

      it("counts reassignments and new tasks together", async () => {
        const actorId = fakeId();
        const eventId = await insertEvent(pg, own);
        const task = await ok(newTaskOn(eventId, fakeId(), actorId));
        const reassign = () =>
          reassignAs(db, { guildId: own.guildId, actorId, taskId: task.id });
        for (let i = 1; i < OFFICER_DAILY_LIMIT; i += 1) {
          await ok(reassign());
        }
        expect(await reassign()).toEqual(actorLimit);
        expect(await newTaskOn(eventId, fakeId(), actorId)).toEqual(actorLimit);
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

    const logState = async (taskId: string) => {
      const { rows } = await pg.query<{ state: string }>(
        `SELECT state FROM public.reminder_log WHERE task_id = $1`,
        [taskId],
      );
      return rows[0]?.state;
    };

    const staleClaims = async () => {
      const claimedBefore = new Date(Date.now() - 3_600_000);
      return (await ok(listStaleClaims(db, { claimedBefore }))).rows;
    };
    const staleTaskIds = async () =>
      (await staleClaims()).map((row) => row.task_id);

    it("claims once, and marks sent with the right token only", async () => {
      const key = await newKey();
      const token = await ok(claimReminder(db, key));
      expect(typeof token).toBe("string");
      expect(await ok(claimReminder(db, key))).toBeNull();

      const send = (claimToken: string) =>
        ok(markReminderSent(db, { ...key, claimToken, messageId: fakeId() }));
      expect(await send(UNKNOWN_ID)).toBe(false);
      expect(await send(token ?? "")).toBe(true);
      // A finished claim never goes stale, however old.
      await age(key.taskId);
      expect(await staleTaskIds()).not.toContain(key.taskId);
    });

    it("lists only an old unfinished claim as stale, and takes it over once", async () => {
      const key = await newKey();
      const token = (await ok(claimReminder(db, key))) ?? "";
      expect(await staleTaskIds()).not.toContain(key.taskId);
      await age(key.taskId);

      expect(
        (await staleClaims()).find((row) => row.task_id === key.taskId),
      ).toMatchObject({
        kind: "due_day",
        due_date: DUE,
        claim_token: token,
        attempts: 1,
      });

      const reclaim = () =>
        ok(reclaimReminder(db, { ...key, claimToken: token }));
      const newToken = await reclaim();
      expect(typeof newToken).toBe("string");
      expect(newToken).not.toBe(token);
      expect(await reclaim()).toBeNull();
    });

    describe("resolving a stale claim", () => {
      const staleClaim = async (own: GuildFixture = guild) => {
        const key = await newKey(own);
        const claimToken = (await ok(claimReminder(db, key))) ?? "";
        await age(key.taskId);
        return { ...key, claimToken };
      };

      it("closes a claim on a finished or deleted task, which leaves the stale list", async () => {
        const done = await staleClaim();
        const deleted = await staleClaim();
        const key = (taskId: string) => ({ ...guild, taskId, now: NOW });
        await ok(markTaskDoneAsOfficer(db, key(done.taskId)));
        await ok(softDeleteTask(db, key(deleted.taskId)));
        for (const claim of [done, deleted]) {
          expect(await staleTaskIds()).toContain(claim.taskId);
          expect(await ok(resolveStaleClaim(db, claim))).toEqual({
            outcome: "closed",
          });
          expect(await logState(claim.taskId)).toBe("skipped");
          expect(await staleTaskIds()).not.toContain(claim.taskId);
        }
      });

      it("leaves a claim alone while reminders are off, so it can resume", async () => {
        const own = await insertGuild(pg);
        const claim = await staleClaim(own);
        await ok(configChange(own, { remindersEnabled: false }));
        expect(await ok(resolveStaleClaim(db, claim))).toEqual({
          outcome: "left",
        });
        expect(await logState(claim.taskId)).toBe("claimed");

        await ok(
          configChange(own, { expectedVersion: 3, remindersEnabled: true }),
        );
        const resumed = await ok(resolveStaleClaim(db, claim));
        expect(resumed.outcome).toBe("reclaimed");
      });
    });
  });

  it("expires only interaction claims older than a day", async () => {
    const old = fakeId();
    const fresh = fakeId();
    const claim = (interactionId: string) =>
      ok(claimInteraction(db, { interactionId }));
    expect(await claim(old)).toBe(true);
    expect(await claim(fresh)).toBe(true);
    await pg.query(
      `UPDATE public.interaction_claims SET claimed_at = now() - interval '25 hours'
       WHERE interaction_id = $1`,
      [old],
    );

    expect(await ok(expireInteractionClaims(db))).toBe(1);
    expect(await claim(old)).toBe(true);
    expect(await claim(fresh)).toBe(false);
  });

  it("starts a job run, and records its failure once as a category and code", async () => {
    const failing = await configChange(await insertGuild(pg), {
      timezone: "america/new_york",
    });
    expect(failing).toEqual({
      ok: false,
      error: { category: "constraint", code: "22023" },
    });
    if (failing.ok) throw new Error("expected a failure");

    const id = await ok(
      beginJobRun(db, {
        jobName: "reminders",
        staleAfterSeconds: 120,
        slotStart: new Date(slotStart(new Date())),
      }),
    );
    if (id === null) throw new Error("expected a run to start");
    expect(
      await ok(getLatestJobRun(db, { jobName: "reminders" })),
    ).toMatchObject({ id, status: "running", finished_at: null, error: null });

    const finish = () =>
      finishJobRun(db, { id, now: LATER, results: {}, error: failing.error });
    const finished = await ok(finish());
    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("constraint:22023");
    expect(await finish()).toEqual(NOT_FOUND);
  });

  describe("another guild's rows", () => {
    /** One guild with an event, a task and a step assignee, and one other. */
    const world = async () => {
      const own = await insertGuild(pg);
      const other = await insertGuild(pg);
      const eventId = await insertEvent(pg, own);
      const assigneeId = fakeId();
      const taskId = await insertTask(pg, own, eventId, assigneeId);
      await ok(
        assignEventStep(db, {
          guildId: own.guildId,
          eventId,
          kind: "budget_sheet",
          userId: assigneeId,
          actorId: fakeId(),
        }),
      );
      return { own, other, eventId, assigneeId, taskId };
    };
    type World = Awaited<ReturnType<typeof world>>;

    it.each<[string, (w: World, guildId: string) => Promise<unknown>]>([
      [
        "listOpenStepsForUser",
        (w, guildId) =>
          listOpenStepsForUser(db, {
            guildId,
            userId: w.assigneeId,
            today: date("2029-12-01"),
          }),
      ],
      [
        "searchOpenTasks",
        (_w, guildId) => searchOpenTasks(db, { guildId, term: "Book" }),
      ],
      [
        "listManagedChannels",
        (_w, guildId) => listManagedChannels(db, { guildId }),
      ],
      [
        "listRecentConfigChanges",
        (_w, guildId) => listRecentConfigChanges(db, { guildId }),
      ],
    ])(
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
        const result = async (guildId: string) =>
          JSON.stringify(unwrap((await read(w, guildId)) as DbResult<unknown>));
        const own = await result(w.own.guildId);
        const other = await result(w.other.guildId);

        expect(ownIds.some((id) => own.includes(id))).toBe(true);
        for (const id of ownIds) {
          expect(other).not.toContain(id);
        }
      },
    );
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

  type AssignableStep = "budget_sheet" | "engage_post" | "food_pickup";
  const key = (eventId: string) => ({ guildId: guild.guildId, eventId });
  const assign = (
    eventId: string,
    kind: AssignableStep,
    userId: string = fakeId(),
  ) =>
    assignEventStep(db, {
      ...key(eventId),
      kind,
      userId,
      actorId: guild.officerRoleId,
    });
  const unassign = (
    eventId: string,
    kind: AssignableStep,
    userId: string,
    actorId: string = fakeId(),
  ) => unassignEventStep(db, { ...key(eventId), kind, userId, actorId });
  const complete = (
    eventId: string,
    kind: "budget_sheet" | "engage_post" | "budget_approved",
    actorId: string = fakeId(),
  ) => completeEventStep(db, { ...key(eventId), kind, actorId });
  const workflow = (eventId: string) => ok(getEventWorkflow(db, key(eventId)));

  /** An event on a date of its own, written as the bot would. */
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

  it("gives every new event its four steps, all open, with no one on them", async () => {
    const eventId = await insertEvent(pg, guild);
    expect<object | null>(await workflow(eventId)).toEqual({
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

  describe("assignments", () => {
    it("adds a person once, and takes them off again without losing the row", async () => {
      const eventId = await insertEvent(pg, guild);
      const user = fakeId();
      expect(await ok(assign(eventId, "budget_sheet", user))).toBe(true);
      expect(await ok(assign(eventId, "budget_sheet", user))).toBe(false);
      const remove = () =>
        ok(unassign(eventId, "budget_sheet", user, guild.adminRoleId));
      expect(await remove()).toBe(true);
      expect(await remove()).toBe(false);
      expect((await workflow(eventId))?.assignees).toEqual([]);
      const { rows } = await pg.query(
        `SELECT removed_by, removed_at IS NOT NULL AS removed
         FROM public.event_step_assignees WHERE event_id = $1`,
        [eventId],
      );
      expect(rows).toEqual([{ removed_by: guild.adminRoleId, removed: true }]);

      // A removed person can be put back on.
      expect(await ok(assign(eventId, "budget_sheet", user))).toBe(true);
    });

    it.each([
      ["engage_post", MAX_ASSIGNEES_PER_STEP],
      ["food_pickup", MAX_FOOD_PICKUP_ASSIGNEES],
    ] as const)("stops %s at %i people", async (kind, limit) => {
      const eventId = await insertEvent(pg, guild);
      for (let index = 0; index < limit; index += 1) {
        await ok(assign(eventId, kind));
      }
      expect(await assign(eventId, kind)).toEqual({
        ok: false,
        error: { category: "step_assignee_limit", code: "CF431" },
      });
      // Another step has its own limit.
      expect(await ok(assign(eventId, "budget_sheet"))).toBe(true);
    });

    it("refuses a closed event, and treats a deleted or foreign one as unknown", async () => {
      const closed = await insertEvent(pg, guild);
      await ok(closeEvent(db, key(closed)));
      expect(await assign(closed, "budget_sheet")).toEqual(UNAVAILABLE);
      expect(await complete(closed, "engage_post")).toEqual(UNAVAILABLE);

      const deleted = await insertEvent(pg, guild);
      await ok(softDeleteEvent(db, key(deleted)));
      const foreign = await insertEvent(pg, await insertGuild(pg));
      for (const eventId of [deleted, foreign, UNKNOWN_ID]) {
        expect(await assign(eventId, "budget_sheet")).toEqual(NOT_FOUND);
      }
      expect(await complete(UNKNOWN_ID, "engage_post")).toEqual(NOT_FOUND);
    });
  });

  it("completes a step once, and hands it off exactly once", async () => {
    const eventId = await insertEvent(pg, guild);
    const handoff = { ...key(eventId), kind: "budget_sheet" as const };
    const claim = () => claimStepHandoff(db, handoff);
    const markSent = () => ok(markStepHandoffSent(db, handoff));
    expect(await ok(claim())).toBe(false);

    const actor = fakeId();
    expect(await ok(complete(eventId, "budget_sheet", actor))).toBe(true);
    expect(await ok(complete(eventId, "budget_sheet", actor))).toBe(false);
    expect((await workflow(eventId))?.steps[0]).toMatchObject({
      status: "done",
      completed_by: actor,
    });

    expect(await markSent()).toBe(false);
    const claims = await Promise.all(Array.from({ length: 5 }, claim));
    const won = claims.filter((result) => result.ok && result.value);
    expect(won).toHaveLength(1);
    expect(await markSent()).toBe(true);
    expect(await markSent()).toBe(false);
    expect(await ok(claim())).toBe(false);
  });

  it("marks Food pickup done once it has a time and a person, and reopens it with no one on it", async () => {
    const eventId = await insertEvent(pg, guild);
    const actor = fakeId();
    const setTime = (pickupTime: string) =>
      ok(
        setEventPickupTime(db, { ...key(eventId), pickupTime, actorId: actor }),
      );
    // The budget need not be approved first.
    expect(await setTime("17:30")).toBe(false);
    const user = fakeId();
    await ok(assign(eventId, "food_pickup", user));
    let current = await workflow(eventId);
    expect(current?.pickup_time).toBe("17:30");
    expect(current?.steps[3]).toMatchObject({
      kind: "food_pickup",
      status: "done",
      completed_by: guild.officerRoleId,
    });

    expect(await setTime("09:05")).toBe(true);
    await ok(unassign(eventId, "food_pickup", user, actor));
    current = await workflow(eventId);
    expect(current?.pickup_time).toBe("09:05");
    expect(current?.steps[3]).toMatchObject({
      status: "open",
      completed_at: null,
      completed_by: null,
    });
  });

  it("lists a member's open steps and upcoming pickups for /mytasks", async () => {
    const user = fakeId();
    const upcoming = await insertEvent(pg, guild);
    const past = await datedEvent("2030-01-05");
    const closed = await insertEvent(pg, guild);
    await ok(assign(upcoming, "budget_sheet", user));
    await ok(assign(upcoming, "engage_post", user));
    await ok(complete(upcoming, "engage_post", user));
    await ok(complete(upcoming, "budget_approved"));
    await ok(assign(upcoming, "food_pickup", user));
    await ok(complete(past, "budget_approved"));
    await ok(assign(past, "food_pickup", user));
    await ok(assign(past, "budget_sheet", user));
    await ok(assign(closed, "budget_sheet", user));
    await ok(closeEvent(db, key(closed)));

    const list = await ok(
      listOpenStepsForUser(db, {
        guildId: guild.guildId,
        userId: user,
        today: date("2030-01-10"),
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

  describe("event reminders", () => {
    /**
     * Today in the fixture guild's zone. A step reminder can be claimed only for today or
     * yesterday there, so an event dated today is the latest one a test can claim on.
     */
    const today = (): DateOnly => todayInZone(new Date(), "America/New_York");
    const dayAfter = (day: string): DateOnly =>
      date(new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10));

    it("lists a live event with its steps, live people and recent log", async () => {
      const eventDate = today();
      const eventId = await datedEvent(eventDate);
      const user = fakeId();
      await ok(assign(eventId, "budget_sheet", user));
      const gone = fakeId();
      await ok(assign(eventId, "engage_post", gone));
      await ok(unassign(eventId, "engage_post", gone, user));
      const daily = {
        eventId,
        kind: "daily_steps" as const,
        reminderDate: eventDate,
      };
      expect(await ok(claimEventReminder(db, daily))).not.toBeNull();

      const listed = async (fromDate: DateOnly) =>
        (await ok(listEventReminderCandidates(db, { fromDate }))).rows.find(
          (row) => row.id === eventId,
        );
      const candidate = await listed(eventDate);
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
      expect(await listed(dayAfter(eventDate))).toBeUndefined();
      await ok(closeEvent(db, key(eventId)));
      expect(await listed(eventDate)).toBeUndefined();
    });

    it("claims once, refuses a date after the event, and marks sent by token", async () => {
      const eventDate = today();
      const daily = {
        eventId: await datedEvent(eventDate),
        kind: "daily_steps" as const,
        reminderDate: eventDate,
      };
      const token = await ok(claimEventReminder(db, daily));
      expect(token).not.toBeNull();
      expect(await ok(claimEventReminder(db, daily))).toBeNull();
      const afterEvent = { ...daily, reminderDate: dayAfter(eventDate) };
      expect(await ok(claimEventReminder(db, afterEvent))).toBeNull();

      const send = (claimToken: string) =>
        ok(
          markEventReminderSent(db, {
            ...daily,
            claimToken,
            messageId: fakeId(),
          }),
        );
      expect(await send(UNKNOWN_ID)).toBe(false);
      expect(await send(token ?? "")).toBe(true);
    });

    it("sends pickup reminders only once Food pickup is set up", async () => {
      const eventDate = today();
      const eventId = await datedEvent(eventDate);
      const pickupDay = {
        eventId,
        kind: "pickup_day" as const,
        reminderDate: eventDate,
      };
      expect(await ok(claimEventReminder(db, pickupDay))).toBeNull();

      await ok(complete(eventId, "budget_approved"));
      await ok(
        setEventPickupTime(db, {
          ...key(eventId),
          pickupTime: "11:00",
          actorId: fakeId(),
        }),
      );
      await ok(assign(eventId, "food_pickup"));

      expect(await ok(claimEventReminder(db, pickupDay))).not.toBeNull();
      const before = { ...pickupDay, kind: "pickup_before" as const };
      expect(await ok(claimEventReminder(db, before))).not.toBeNull();
    });
  });

  it("keeps one setup draft per guild, readable for an hour by the member who made it", async () => {
    const roles = () => ({
      officerRoleId: fakeId(),
      adminRoleId: fakeId(),
      eboardRoleId: fakeId(),
      eventsCommitteeRoleId: fakeId(),
      treasuryRoleId: fakeId(),
      marketingRoleId: fakeId(),
    });
    const guildId = fakeId();
    const actorId = fakeId();
    const second = roles();
    const save = (draft: ReturnType<typeof roles>) =>
      ok(saveSetupDraft(db, { guildId, actorId, roles: draft }));
    const firstPrint = await save(roles());
    const secondPrint = await save(second);
    const now = new Date();
    const read = (fingerprint: string, by = actorId, at = now) =>
      ok(getSetupDraft(db, { guildId, actorId: by, fingerprint, now: at }));

    expect(await read(firstPrint)).toBeNull();
    expect(await read(secondPrint)).toMatchObject({
      guild_id: guildId,
      actor_id: actorId,
      treasury_role_id: second.treasuryRoleId,
      fingerprint: secondPrint,
    });
    expect(await read(secondPrint, fakeId())).toBeNull();
    const twoHoursOn = new Date(now.getTime() + 2 * 3_600_000);
    expect(await read(secondPrint, actorId, twoHoursOn)).toBeNull();
    const { rows } = await pg.query(
      `SELECT count(*)::int AS count FROM public.setup_drafts WHERE guild_id = $1`,
      [guildId],
    );
    expect(rows).toEqual([{ count: 1 }]);
  });
});
