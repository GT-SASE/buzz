/**
 * /task assign, edit and delete from the router down to the real schema. Every rule that
 * depends on a row, a filter or a trigger is proved here and not on a mock.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { versionFingerprint } from "../../src/tasks/shared.ts";
import { closeEvent, softDeleteEvent } from "../../src/db/events.ts";
import { createTask, editTask } from "../../src/db/tasks.ts";
import {
  componentPayload,
  dependenciesFor,
  GUILD_ID,
  run,
} from "../support/interactions.ts";
import { fakeId } from "../support/ids.ts";
import { vercelConfig } from "../support/json.ts";
import { insertEvent } from "./fixtures.ts";
import {
  date,
  DEFERRED_MESSAGE,
  DEFERRED_UPDATE,
  EPHEMERAL,
  FAR_DUE,
  fakeClient,
  FIXED_REFUSAL,
  officer,
  OPTION,
  pickerPayload,
  plainMember,
  refusedWith,
  stringOptions,
  subcommand,
  SUPPRESS_EMBEDS,
  unwrap,
  useTaskWorld,
  type OptionValues,
} from "./task-world.ts";

/** The limits the database's triggers enforce. */
const EVENT_TASK_LIMIT = 100;
const OFFICER_DAILY_LIMIT = 50;

/** What Discord sends for a chosen person who is in the guild. */
function resolvedHuman(id: string, extra: Record<string, unknown> = {}) {
  return {
    users: { [id]: { id, username: "someone", ...extra } },
    members: { [id]: { nick: null, roles: [] } },
  };
}

function confirmId(task: { id: string; updated_at: string }) {
  return `task.delete-yes:${task.id}:${versionFingerprint(task.updated_at)}`;
}

function personOption(id: string) {
  return { name: "person", type: OPTION.user, value: id };
}

describe("assigning, editing and deleting tasks, on the real schema", () => {
  const world = useTaskWorld();

  beforeEach(() => {
    // The access check and failed sends log; the replies are what these tests read.
    spyOn(console, "error").mockImplementation(() => undefined);
  });
  const { refreshOverview, eventWithPost, inThread, newTask, row, tasksOn } =
    world;
  const publicMessage = () => ({
    message: { id: fakeId(), flags: SUPPRESS_EMBEDS },
  });

  async function choices(
    name: "edit" | "delete" | "assign",
    typed: unknown,
    fields: Record<string, unknown>,
  ) {
    const { client } = fakeClient();
    const ran = await run(
      world.router,
      pickerPayload(name, typed, fields),
      dependenciesFor(world.db(), client),
    );
    return (ran.reply.data?.choices ?? []) as { name: string; value: string }[];
  }

  function assignPayload(
    {
      person = fakeId(),
      description = "Book the room",
      due = FAR_DUE,
      event,
    }: {
      person?: string;
      description?: string;
      due?: string;
      event?: string;
    },
    fields: Record<string, unknown>,
    resolved: Record<string, unknown> = resolvedHuman(person),
  ) {
    return subcommand(
      "assign",
      [
        personOption(person),
        ...stringOptions({
          description,
          due,
          ...(event === undefined ? {} : { event }),
        }),
      ],
      fields,
      resolved,
    );
  }

  it("sends the interactions function's limit to Vercel, so finish has its time", () => {
    const config = vercelConfig(
      readFileSync(
        join(import.meta.dirname, "..", "..", "vercel.json"),
        "utf8",
      ),
    );
    expect(config.functions["api/interactions.ts"]?.maxDuration).toBe(60);
  });

  describe("/task assign", () => {
    it("takes the event from the post, saves the task, and pings only the assignee", async () => {
      const { eventId, threadId } = await eventWithPost();
      const { client, edits, notices } = fakeClient();
      const person = fakeId();
      const actor = fakeId();

      const ran = await run(
        world.router,
        assignPayload(
          { person },
          { member: officer(actor), ...inThread(threadId) },
        ),
        dependenciesFor(world.db(), client),
      );

      expect(ran.reply).toEqual({
        type: DEFERRED_MESSAGE,
        data: { flags: EPHEMERAL },
      });
      const [task] = await tasksOn(eventId);
      expect(task).toMatchObject({
        assignee_id: person,
        created_by: actor,
        description: "Book the room",
        due_date: FAR_DUE,
      });
      expect(notices).toHaveLength(1);
      const [notice] = notices;
      expect(notice?.channelId).toBe(threadId);
      expect(notice?.allowed_mentions).toEqual({ parse: [], users: [person] });
      expect(notice?.flags).toBe(SUPPRESS_EMBEDS);
      expect(notice?.content).toContain(`<@${person}>`);
      expect(notice?.components[0]?.components[0]?.custom_id).toBe(
        `task.done:${task?.id ?? ""}`,
      );
      expect(edits).toHaveLength(1);
      expect(edits[0]?.content).toContain("was mentioned");
      expect(refreshOverview).toHaveBeenCalledTimes(1);
      expect(refreshOverview.mock.calls[0]?.[0].id).toBe(eventId);
    });

    it("asks an officer to name an event from a thread that is no event's post", async () => {
      const { client, edits, notices } = fakeClient();

      await run(
        world.router,
        assignPayload(
          {},
          {
            member: officer(),
            channel: { id: fakeId(), type: 11, parent_id: null },
          },
        ),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content).toContain("Run this in an event's post");
      expect(notices).toEqual([]);
    });

    it("does not tell a non-officer anything, in or out of a post", async () => {
      const { eventId, threadId } = await eventWithPost();
      const { client, edits, notices } = fakeClient();
      const dependencies = dependenciesFor(world.db(), client);

      const inPost = await run(
        world.router,
        assignPayload({}, { member: plainMember(), ...inThread(threadId) }),
        dependencies,
      );
      const elsewhere = await run(
        world.router,
        assignPayload({}, { member: plainMember() }),
        dependencies,
      );
      const named = await run(
        world.router,
        assignPayload({ event: eventId }, { member: plainMember() }),
        dependencies,
      );

      for (const ran of [inPost, elsewhere, named]) {
        expect(ran.deferred).toBe(false);
        expect(ran.reply.data?.content).toBe(FIXED_REFUSAL);
        expect(ran.reply.data?.flags).toBe(EPHEMERAL | SUPPRESS_EMBEDS);
      }
      expect(await tasksOn(eventId)).toEqual([]);
      expect(edits).toEqual([]);
      expect(notices).toEqual([]);
    });

    describe("the person", () => {
      const cases: [string, (id: string) => Record<string, unknown>, string][] =
        [
          [
            "a bot",
            (id) => resolvedHuman(id, { bot: true }),
            "can't be assigned to bots",
          ],
          [
            "a user who is not in the guild",
            (id) => ({ users: { [id]: { id } } }),
            "isn't a member",
          ],
          ["a user missing from resolved", () => ({}), "isn't a member"],
        ];

      it.each(cases)("refuses %s", async (_name, resolved, expected) => {
        const { eventId, threadId } = await eventWithPost();
        const { client, edits, notices } = fakeClient();
        const person = fakeId();

        await run(
          world.router,
          assignPayload(
            { person },
            { member: officer(), ...inThread(threadId) },
            resolved(person),
          ),
          dependenciesFor(world.db(), client),
        );

        expect(edits[0]?.content).toContain(expected);
        expect(await tasksOn(eventId)).toEqual([]);
        expect(notices).toEqual([]);
      });
    });

    describe("the description", () => {
      const hostile: [string, string][] = [
        [
          "mentions",
          `@everyone @here <@&${fakeId()}> <@${fakeId()}> <#${fakeId()}>`,
        ],
        [
          "markdown, bidi and zero-width characters",
          "# System\n> quoted\n```\n||hidden|| **bold** abc\u202Edef a\u200Bb",
        ],
        ["links", "go to https://evil.example/login or www.evil.example"],
      ];

      it.each(hostile)(
        "stores %s raw and renders it inert",
        async (_n, text) => {
          const { eventId, threadId } = await eventWithPost();
          const { client, edits, notices } = fakeClient();
          const person = fakeId();
          const actor = fakeId();

          await run(
            world.router,
            assignPayload(
              { person, description: text },
              { member: officer(actor), ...inThread(threadId) },
            ),
            dependenciesFor(world.db(), client),
          );

          const [task] = await tasksOn(eventId);
          expect(task?.description).toBe(text.trim());
          const content = notices[0]?.content ?? "";
          // Once escaped pairs are removed, the only live syntax left is the two
          // mentions the bot wrote itself.
          const live = content
            .replace(/\\[\s\S]/gu, "")
            .replaceAll(`<@${person}>`, "")
            .replaceAll(`<@${actor}>`, "");
          expect(live).not.toMatch(
            /@everyone|@here|<@|<#|<\/|:\/\/|www\.|\[.*\]\(|\u202E|\u200B/u,
          );
          expect(live).not.toMatch(/^[#>]|`|\|\||\*\*/mu);
          expect(notices[0]?.allowed_mentions).toEqual({
            parse: [],
            users: [person],
          });
          expect(edits[0]?.content).not.toContain(text);
        },
      );

      const refused: [string, string, string][] = [
        ["a NUL character", "bad\u0000text", "can't be saved"],
        ["only zero-width characters", "\u200B\u200D\u2060", "nothing visible"],
        ["too much text", "x".repeat(1001), "too long"],
        [
          "a masked URL",
          "[Portal login](https://evil.example)",
          "masked links",
        ],
        ["a split invite", "discord.\u200Bgg/abc", "invites"],
      ];

      it.each(refused)(
        "refuses %s with no write",
        async (_n, text, expected) => {
          const { eventId, threadId } = await eventWithPost();
          const { client, edits, notices } = fakeClient();

          await run(
            world.router,
            assignPayload(
              { description: text },
              { member: officer(), ...inThread(threadId) },
            ),
            dependenciesFor(world.db(), client),
          );

          expect(edits[0]?.content).toContain(expected);
          expect(await tasksOn(eventId)).toEqual([]);
          expect(notices).toEqual([]);
        },
      );
    });

    describe("the due date", () => {
      it.each([
        ["a date in the past", "2000-01-01", "in the past"],
        ["words", "tomorrow", "YYYY-MM-DD"],
        ["a date that does not exist", "2040-02-31", "not a real date"],
      ])("refuses %s", async (_name, due, expected) => {
        const { eventId, threadId } = await eventWithPost();
        const { client, edits } = fakeClient();

        await run(
          world.router,
          assignPayload({ due }, { member: officer(), ...inThread(threadId) }),
          dependenciesFor(world.db(), client),
        );

        expect(edits[0]?.content).toContain(expected);
        expect(await tasksOn(eventId)).toEqual([]);
      });
    });

    describe("the event", () => {
      it("refuses a closed event, named or from its post", async () => {
        const { eventId, threadId } = await eventWithPost();
        unwrap(await closeEvent(world.db(), { guildId: GUILD_ID, eventId }));
        const { client, edits, notices } = fakeClient();
        const dependencies = dependenciesFor(world.db(), client);

        await run(
          world.router,
          assignPayload({ event: eventId }, { member: officer() }),
          dependencies,
        );
        await run(
          world.router,
          assignPayload({}, { member: officer(), ...inThread(threadId) }),
          dependencies,
        );

        expect(edits.map((edit) => edit.content)).toEqual([
          expect.stringContaining("closed or deleted") as string,
          expect.stringContaining("closed or deleted") as string,
        ]);
        expect(await tasksOn(eventId)).toEqual([]);
        expect(notices).toEqual([]);
      });

      it.each([
        ["a deleted event", "deleted"],
        ["another guild's event", "foreign"],
      ])("gives %s the one refusal, with no write", async (_name, value) => {
        const { eventId } = await eventWithPost();
        const named = value === "foreign" ? world.foreignEventId : eventId;
        if (value === "deleted") {
          unwrap(
            await softDeleteEvent(world.db(), { guildId: GUILD_ID, eventId }),
          );
        }
        const { client, edits, notices } = fakeClient();

        const ran = await run(
          world.router,
          assignPayload({ event: named }, { member: officer() }),
          dependenciesFor(world.db(), client),
        );

        expect(refusedWith(ran, edits)).toBe(FIXED_REFUSAL);
        expect(notices).toEqual([]);
        expect(await tasksOn(world.foreignEventId)).toEqual([]);
      });
    });

    it("keeps the task and says so when the event has no post", async () => {
      const eventId = await insertEvent(
        world.backend.connection,
        world.fixture,
      );
      const { client, edits, notices } = fakeClient();

      await run(
        world.router,
        assignPayload({ event: eventId }, { member: officer() }),
        dependenciesFor(world.db(), client),
      );

      expect(await tasksOn(eventId)).toHaveLength(1);
      expect(notices).toEqual([]);
      expect(edits[0]?.content).toContain("no post right now");
    });

    describe("quotas", () => {
      it("states the event limit in the refusal", async () => {
        const { eventId, threadId } = await eventWithPost();
        for (let index = 0; index < EVENT_TASK_LIMIT; index += 1) {
          await newTask(eventId, fakeId());
        }
        const { client, edits, notices } = fakeClient();

        await run(
          world.router,
          assignPayload({}, { member: officer(), ...inThread(threadId) }),
          dependenciesFor(world.db(), client),
        );

        expect(edits[0]?.content).toBe(
          "This event already has the most tasks one event can hold. Delete some before adding more.",
        );
        expect(notices).toEqual([]);
        expect(await tasksOn(eventId)).toHaveLength(EVENT_TASK_LIMIT);
      });

      it("says when the officer limit is reached", async () => {
        const { eventId, threadId } = await eventWithPost();
        const actor = fakeId();
        const { client, edits, notices } = fakeClient();
        const dependencies = dependenciesFor(world.db(), client);
        for (let i = 0; i < OFFICER_DAILY_LIMIT; i += 1) {
          unwrap(
            await createTask(world.db(), {
              guildId: GUILD_ID,
              eventId,
              assigneeId: fakeId(),
              actorId: actor,
              description: "Book the room",
              dueDate: date(FAR_DUE),
            }),
          );
        }

        await run(
          world.router,
          assignPayload({}, { member: officer(actor), ...inThread(threadId) }),
          dependencies,
        );

        expect(edits[0]?.content).toBe(
          "You've reached the limit for assigning and reassigning tasks. Please try again later.",
        );
        expect(notices).toEqual([]);
      });
    });
  });

  describe("/task edit", () => {
    function editPayload(
      taskId: string,
      values: OptionValues,
      fields: Record<string, unknown>,
      person?: string,
      resolved?: Record<string, unknown>,
    ) {
      return subcommand(
        "edit",
        [
          ...stringOptions({ task: taskId, ...values }),
          ...(person === undefined ? [] : [personOption(person)]),
        ],
        fields,
        resolved ?? (person === undefined ? undefined : resolvedHuman(person)),
      );
    }

    it("refuses a non-officer, even the assignee", async () => {
      const { eventId } = await eventWithPost();
      const assignee = fakeId();
      const task = await newTask(eventId, assignee);
      const { client, edits } = fakeClient();

      const ran = await run(
        world.router,
        editPayload(
          task.id,
          { description: "Mine now" },
          { member: plainMember(assignee) },
        ),
        dependenciesFor(world.db(), client),
      );

      expect(ran.reply.data?.content).toBe(FIXED_REFUSAL);
      expect(edits).toEqual([]);
      expect((await row(task.id))?.description).toBe("Book the room");
    });

    it("changes the description and says nothing about reminders", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, fakeId());
      const { client, edits, notices } = fakeClient();

      await run(
        world.router,
        editPayload(
          task.id,
          { description: "Print signs" },
          { member: officer() },
        ),
        dependenciesFor(world.db(), client),
      );

      expect(await row(task.id)).toMatchObject({
        description: "Print signs",
        due_date: FAR_DUE,
        assignee_id: task.assignee_id,
      });
      expect(edits[0]?.content).toContain("Saved task");
      expect(edits[0]?.content).not.toContain("reminders");
      expect(notices).toEqual([]);
      expect(refreshOverview).toHaveBeenCalledTimes(1);
    });

    it("says that moving the due date restarts reminders", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, fakeId());
      const { client, edits } = fakeClient();

      await run(
        world.router,
        editPayload(task.id, { due: "2041-01-02" }, { member: officer() }),
        dependenciesFor(world.db(), client),
      );

      expect((await row(task.id))?.due_date).toBe("2041-01-02");
      expect(edits[0]?.content).toContain("starts its reminders again");
    });

    it("pings the new assignee alone, and pings nobody for other edits", async () => {
      const { eventId, threadId } = await eventWithPost();
      const before = fakeId();
      const after = fakeId();
      const task = await newTask(eventId, before);
      const { client, edits, notices } = fakeClient();

      await run(
        world.router,
        editPayload(task.id, {}, { member: officer() }, after),
        dependenciesFor(world.db(), client),
      );

      expect((await row(task.id))?.assignee_id).toBe(after);
      expect(notices).toHaveLength(1);
      expect(notices[0]?.channelId).toBe(threadId);
      expect(notices[0]?.allowed_mentions).toEqual({
        parse: [],
        users: [after],
      });
      expect(notices[0]?.content).not.toContain(`<@${before}>`);
      expect(edits[0]?.content).toContain(`<@${after}> was mentioned`);
    });

    it("stops pinging at the officer's limit, writing nothing and saying why", async () => {
      const { eventId } = await eventWithPost();
      const a = fakeId();
      const b = fakeId();
      const task = await newTask(eventId, a);
      const actor = fakeId();
      const { client, edits, notices } = fakeClient();
      const dependencies = dependenciesFor(world.db(), client);

      for (let i = 0; i < OFFICER_DAILY_LIMIT + 3; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        await run(
          world.router,
          editPayload(
            task.id,
            { description: `Round ${String(i)}` },
            { member: officer(actor) },
            i % 2 === 0 ? b : a,
          ),
          dependencies,
        );
      }

      expect(notices).toHaveLength(OFFICER_DAILY_LIMIT);
      const refusal = edits.at(-1)?.content ?? "";
      expect(refusal).toBe(
        "You've reached the limit for assigning and reassigning tasks, so nothing was saved. Please try again later.",
      );
      // The rounds alternate, so every second one past the limit left the person alone,
      // which pings nobody and still saves. The last, a change of person, saved nothing.
      expect(await row(task.id)).toMatchObject({
        assignee_id: a,
        description: `Round ${String(OFFICER_DAILY_LIMIT + 1)}`,
      });
    });

    it("refuses a stale edit, keeping the other person's change", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, fakeId());
      const { client, edits, notices } = fakeClient();

      await run(
        world.router,
        editPayload(
          task.id,
          { description: "Written later" },
          { member: officer() },
          fakeId(),
        ),
        world.racing(client, "edit", async () => {
          unwrap(
            await editTask(world.db(), {
              actorId: fakeId(),
              guildId: GUILD_ID,
              taskId: task.id,
              expectedUpdatedAt: task.updated_at,
              description: "Written first",
              dueDate: task.due_date,
              assigneeId: task.assignee_id,
            }),
          );
        }),
      );

      expect(await row(task.id)).toMatchObject({
        description: "Written first",
        assignee_id: task.assignee_id,
      });
      expect(edits[0]?.content).toContain("nothing was saved");
      expect(edits[0]?.content).toContain("/task edit");
      expect(notices).toEqual([]);
    });

    it("says so when an edit changes nothing", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, fakeId());
      const { client, edits, notices } = fakeClient();
      const dependencies = dependenciesFor(world.db(), client);

      await run(
        world.router,
        editPayload(
          task.id,
          { description: "Book the room", due: FAR_DUE },
          { member: officer() },
          task.assignee_id,
        ),
        dependencies,
      );

      expect(edits[0]?.content).toContain("changes nothing");
      expect(notices).toEqual([]);
    });

    it("refuses a task that is done, or on a closed event", async () => {
      const done = await eventWithPost();
      const doneTask = await newTask(done.eventId, fakeId());
      const closed = await eventWithPost();
      const closedTask = await newTask(closed.eventId, fakeId());
      await world.backend.connection.query(
        `UPDATE public.tasks SET status = 'done', completed_at = now() WHERE id = $1`,
        [doneTask.id],
      );
      unwrap(
        await closeEvent(world.db(), {
          guildId: GUILD_ID,
          eventId: closed.eventId,
        }),
      );
      const { client, edits } = fakeClient();
      const dependencies = dependenciesFor(world.db(), client);

      await run(
        world.router,
        editPayload(
          doneTask.id,
          { description: "Changed" },
          { member: officer() },
        ),
        dependencies,
      );
      await run(
        world.router,
        editPayload(
          closedTask.id,
          { description: "Changed" },
          { member: officer() },
        ),
        dependencies,
      );

      expect(edits[0]?.content).toContain("is done");
      expect(edits[1]?.content).toContain("closed or deleted");
      expect((await row(doneTask.id))?.description).toBe("Book the room");
      expect((await row(closedTask.id))?.description).toBe("Book the room");
    });
  });

  describe("/task delete", () => {
    function deletePayload(taskId: string, fields: Record<string, unknown>) {
      return subcommand("delete", stringOptions({ task: taskId }), fields);
    }

    async function promptFor(taskId: string) {
      const { client, edits } = fakeClient();
      await run(
        world.router,
        deletePayload(taskId, { member: officer() }),
        dependenciesFor(world.db(), client),
      );
      return edits[0] as (typeof edits)[number] & {
        components: { components: { custom_id: string }[] }[];
      };
    }

    it("deletes only on Confirm, softly, keeping the row", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, fakeId());

      const prompt = await promptFor(task.id);
      expect(prompt.content).toContain("Delete this task?");
      expect((await row(task.id))?.deleted).toBe(false);

      const customId = prompt.components[0]?.components[0]?.custom_id ?? "";
      expect(customId).toBe(confirmId(task));
      expect(customId).toMatch(
        /^task\.delete-yes:[0-9a-f-]{36}:[0-9a-f]{16}$/u,
      );
      const { client, edits } = fakeClient();
      const ran = await run(
        world.router,
        componentPayload(customId, { member: officer() }),
        dependenciesFor(world.db(), client),
      );

      expect(ran.reply).toEqual({ type: DEFERRED_UPDATE });
      expect(edits[0]?.content).toContain("Deleted");
      expect(edits[0]?.components).toEqual([]);
      expect(await row(task.id)).toMatchObject({
        deleted: true,
        description: "Book the room",
      });
      expect(refreshOverview).toHaveBeenCalledTimes(1);
    });

    it("refuses a non-officer at the command, showing nothing", async () => {
      const { eventId } = await eventWithPost();
      const assignee = fakeId();
      const task = await newTask(eventId, assignee);
      const { client, edits } = fakeClient();

      const ran = await run(
        world.router,
        deletePayload(task.id, { member: plainMember(assignee) }),
        dependenciesFor(world.db(), client),
      );

      expect(ran.reply.data?.content).toBe(FIXED_REFUSAL);
      expect(edits).toEqual([]);
    });

    it("refuses a Confirm for a task edited since it was shown, and keeps the task", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, fakeId());
      const stale = confirmId(task);
      await new Promise((resolve) => setTimeout(resolve, 5));
      unwrap(
        await editTask(world.db(), {
          actorId: fakeId(),
          guildId: GUILD_ID,
          taskId: task.id,
          expectedUpdatedAt: task.updated_at,
          description: "Pay the deposit",
          dueDate: task.due_date,
          assigneeId: task.assignee_id,
        }),
      );
      const { client, edits } = fakeClient();

      await run(
        world.router,
        componentPayload(stale, { member: officer() }),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content).toContain("changed after this was shown");
      expect(await row(task.id)).toMatchObject({
        deleted: false,
        description: "Pay the deposit",
      });
    });

    it.each([
      ["a member whose role was removed", false, () => ({})],
      ["the task's own assignee", true, () => ({})],
      [
        "an officer on a message others can see",
        false,
        () => ({ member: officer(), message: { id: fakeId(), flags: 0 } }),
      ],
    ])("refuses a Confirm from %s", async (_name, isAssignee, fields) => {
      const { eventId } = await eventWithPost();
      const assignee = fakeId();
      const task = await newTask(eventId, assignee);
      const { client, edits } = fakeClient();

      const ran = await run(
        world.router,
        componentPayload(confirmId(task), {
          member: plainMember(isAssignee ? assignee : fakeId()),
          ...fields(),
        }),
        dependenciesFor(world.db(), client),
      );

      expect(ran.reply.data?.content).toBe(FIXED_REFUSAL);
      expect(edits).toEqual([]);
      expect((await row(task.id))?.deleted).toBe(false);
    });

    it("gives a second Confirm and a replay the same quiet result", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, fakeId());
      const { client, edits } = fakeClient();
      const dependencies = dependenciesFor(world.db(), client);
      const payload = componentPayload(confirmId(task), {
        member: officer(),
      });

      await run(world.router, payload, dependencies);
      const replay = await run(world.router, payload, dependencies);
      const second = await run(
        world.router,
        componentPayload(confirmId(task), { member: officer() }),
        dependencies,
      );

      // The replay stops at its claim. The second click is refused, as it's gone.
      expect(replay.deferred).toBe(true);
      expect(second.deferred).toBe(true);
      expect(edits.map((edit) => edit.content)).toEqual([
        expect.stringContaining("Deleted") as string,
        FIXED_REFUSAL,
      ]);
    });
  });

  it("works from the button that /task assign posted", async () => {
    const { eventId, threadId } = await eventWithPost();
    const person = fakeId();
    const { client, notices } = fakeClient();
    const dependencies = dependenciesFor(world.db(), client);
    await run(
      world.router,
      assignPayload({ person }, { member: officer(), ...inThread(threadId) }),
      dependencies,
    );
    const customId = notices[0]?.components[0]?.components[0]?.custom_id ?? "";
    expect(notices[0]?.components[0]?.components[0]?.label).toBe(
      "✅ Mark done",
    );

    await run(
      world.router,
      componentPayload(customId, {
        member: plainMember(person),
        ...publicMessage(),
      }),
      dependencies,
    );

    const [task] = await tasksOn(eventId);
    expect((await row(task?.id ?? ""))?.status).toBe("done");
  });

  it.each(["edit", "delete", "assign"] as const)(
    "offers a non-officer nothing for /task %s",
    async (name) => {
      const { eventId } = await eventWithPost();
      const me = fakeId();
      await newTask(eventId, me, "Officeronly thing");

      expect(
        await choices(name, "Officeronly", { member: plainMember(me) }),
      ).toEqual([]);
      expect(await choices(name, "", { member: plainMember(me) })).toEqual([]);
    },
  );

  it("offers an officer tasks to edit and delete, and open events to assign to", async () => {
    const { eventId } = await eventWithPost();
    const closed = await eventWithPost();
    unwrap(
      await closeEvent(world.db(), {
        guildId: GUILD_ID,
        eventId: closed.eventId,
      }),
    );
    const task = await newTask(eventId, fakeId(), "Officerpick thing");

    const forEdit = await choices("edit", "Officerpick", {
      member: officer(),
    });
    const forDelete = await choices("delete", "Officerpick", {
      member: officer(),
    });
    const forAssign = await choices("assign", "General", {
      member: officer(),
    });

    expect(forEdit.map((choice) => choice.value)).toEqual([task.id]);
    expect(forDelete.map((choice) => choice.value)).toEqual([task.id]);
    const events = forAssign.map((choice) => choice.value);
    expect(events.length).toBeGreaterThan(0);
    expect(events).not.toContain(closed.eventId);
    expect(forAssign[0]?.name).toMatch(/^[0-9a-f]{8} on \d{4}-\d{2}-\d{2} /u);
  });
});
