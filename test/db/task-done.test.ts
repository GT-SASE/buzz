/**
 * /task done, the Mark done button, /mytasks and the task picker from the router down to
 * the real schema. Every rule that depends on a row, a filter or a trigger is proved here
 * and not on a mock.
 */

import { describe, expect, it } from "vitest";
import type { DiscordClient } from "../../src/discord/client.ts";
import { channelMessage } from "../../src/discord/outbound.ts";
import { safe } from "../../src/discord/safe-text.ts";
import { closeEvent, softDeleteEvent } from "../../src/db/events.ts";
import { editTask, getTask, softDeleteTask } from "../../src/db/tasks.ts";
import { markDoneButton, markDoneRow } from "../../src/tasks/done.ts";
import {
  commandPayload,
  componentPayload,
  dependenciesFor,
  GUILD_ID,
  run,
} from "../support/interactions.ts";
import { fakeId } from "../support/ids.ts";
import { insertEvent, withoutQuotas } from "./fixtures.ts";
import { queryAs } from "./harness.ts";
import {
  admin,
  DEFERRED_MESSAGE,
  EPHEMERAL,
  FAR_DUE,
  fakeClient,
  FIXED_REFUSAL,
  officer,
  pickerPayload,
  plainMember,
  refusedWith,
  stringOptions,
  subcommand,
  SUPPRESS_EMBEDS,
  UNKNOWN_ID,
  unwrap,
  useTaskWorld,
  type Notice,
} from "./task-world.ts";

describe("marking tasks done and reading them, on the real schema", () => {
  const world = useTaskWorld();
  const { refreshOverview, eventWithPost, newTask, row } = world;

  describe("/task done and the button", () => {
    const publicMessage = () => ({
      message: { id: fakeId(), flags: SUPPRESS_EMBEDS },
    });

    function doneCommand(taskId: string, fields: Record<string, unknown>) {
      return subcommand("done", stringOptions({ task: taskId }), fields);
    }

    function click(taskId: string, fields: Record<string, unknown>) {
      return componentPayload(`task.done:${taskId}`, {
        ...publicMessage(),
        ...fields,
      });
    }

    it("builds a button holding only the validated task ID", () => {
      const body = channelMessage({
        content: safe`Task`,
        mentionUserIds: [],
        components: [markDoneRow(UNKNOWN_ID)],
      }).payload as Notice;
      expect(body.components[0]?.components[0]).toMatchObject({
        custom_id: `task.done:${UNKNOWN_ID}`,
        label: "\u2705 Mark done",
      });
      expect(() => markDoneButton("x:y")).toThrow(RangeError);
      expect(() => markDoneButton("__proto__")).toThrow(RangeError);
      expect(() => markDoneButton("")).toThrow(RangeError);
    });

    it("lets the assignee finish by command", async () => {
      const { eventId } = await eventWithPost();
      const assignee = fakeId();
      const task = await newTask(eventId, assignee);
      const { client, edits } = fakeClient();

      await run(
        world.router,
        doneCommand(task.id, { member: plainMember(assignee) }),
        dependenciesFor(world.db(), client),
      );

      expect((await row(task.id))?.status).toBe("done");
      expect(edits[0]?.content).toContain("Marked done");
      expect(refreshOverview).toHaveBeenCalledTimes(1);
    });

    it("lets the assignee click on a public message, answering privately in a new reply", async () => {
      const { eventId } = await eventWithPost();
      const assignee = fakeId();
      const task = await newTask(eventId, assignee);
      const { client, edits, notices } = fakeClient();

      const ran = await run(
        world.router,
        click(task.id, { member: plainMember(assignee) }),
        dependenciesFor(world.db(), client),
      );

      expect(ran.reply).toEqual({
        type: DEFERRED_MESSAGE,
        data: { flags: EPHEMERAL },
      });
      expect((await row(task.id))?.status).toBe("done");
      expect(edits[0]?.content).toContain("Marked done");
      expect(notices).toEqual([]);
    });

    it.each([
      ["an officer", officer],
      ["an admin", admin],
    ])("lets %s finish someone else's task", async (_name, build) => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, fakeId());
      const { client } = fakeClient();

      await run(
        world.router,
        click(task.id, { member: build() }),
        dependenciesFor(world.db(), client),
      );

      expect((await row(task.id))?.status).toBe("done");
    });

    it("refuses a non-assignee who clicks, privately and with no change", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, fakeId());
      const { client, edits } = fakeClient();

      const ran = await run(
        world.router,
        click(task.id, { member: plainMember() }),
        dependenciesFor(world.db(), client),
      );

      expect(ran.reply).toEqual({
        type: DEFERRED_MESSAGE,
        data: { flags: EPHEMERAL },
      });
      expect(edits[0]?.content).toBe(FIXED_REFUSAL);
      expect((await row(task.id))?.status).toBe("open");
    });

    it("refuses a non-assignee by command too", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, fakeId());
      const { client, edits } = fakeClient();

      const ran = await run(
        world.router,
        doneCommand(task.id, { member: plainMember() }),
        dependenciesFor(world.db(), client),
      );

      expect(refusedWith(ran, edits)).toBe(FIXED_REFUSAL);
      expect((await row(task.id))?.status).toBe("open");
    });

    it("makes marking twice a friendly no-op, for button and command", async () => {
      const { eventId } = await eventWithPost();
      const assignee = fakeId();
      const task = await newTask(eventId, assignee);
      const { client, edits } = fakeClient();
      const dependencies = dependenciesFor(world.db(), client);
      const clicker = plainMember(assignee);

      await run(
        world.router,
        click(task.id, { member: clicker }),
        dependencies,
      );
      await run(
        world.router,
        click(task.id, { member: clicker }),
        dependencies,
      );
      await run(
        world.router,
        doneCommand(task.id, { member: clicker }),
        dependencies,
      );

      expect(edits[1]?.content).toContain("already done");
      expect(edits[2]?.content).toContain("already done");
      expect(refreshOverview).toHaveBeenCalledTimes(1);
    });

    it("gives a replayed click one change and one reply", async () => {
      const { eventId } = await eventWithPost();
      const assignee = fakeId();
      const task = await newTask(eventId, assignee);
      const { client, edits } = fakeClient();
      const dependencies = dependenciesFor(world.db(), client);
      const payload = click(task.id, { member: plainMember(assignee) });

      await run(world.router, payload, dependencies);
      await run(world.router, payload, dependencies);

      expect(edits).toHaveLength(1);
    });

    it.each([
      ["no ID", "task.done"],
      ["an empty ID", "task.done:"],
      ["a short ID", "task.done:abc12345"],
      ["an extra field", `task.done:${UNKNOWN_ID}:${UNKNOWN_ID}`],
      ["uppercase hex", "task.done:ABCDEF12-3456-4789-8ABC-DEF123456789"],
      ["a property name", "task.done:__proto__"],
      ["a filter", "task.done:x,status.eq.done"],
      ["a Discord ID in place of a task", `task.done:${fakeId()}`],
      ["100 characters", `task.done:${"a".repeat(90)}`],
      ["over the limit", `task.done:${"a".repeat(200)}`],
      ["another route's prefix", `TASK.DONE:${UNKNOWN_ID}`],
    ])("refuses a crafted custom_id with %s", async (_name, customId) => {
      const { client, edits } = fakeClient();

      const ran = await run(
        world.router,
        componentPayload(customId, {
          member: officer(),
          ...publicMessage(),
        }),
        dependenciesFor(world.db(), client),
      );

      expect(ran.deferred).toBe(false);
      expect(ran.reply.data?.content).toBe(FIXED_REFUSAL);
      expect(edits).toEqual([]);
    });

    it("refuses a custom_id of the right shape that names no task", async () => {
      const { client, edits } = fakeClient();

      const ran = await run(
        world.router,
        click(UNKNOWN_ID, { member: officer() }),
        dependenciesFor(world.db(), client),
      );

      expect(refusedWith(ran, edits)).toBe(FIXED_REFUSAL);
    });

    it("gives another guild's task the same refusal as an unknown ID", async () => {
      const assignee = fakeId();
      const rows = await queryAs<{ id: string }>(
        world.backend.connection,
        "bot_app",
        `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
         VALUES ($1, $2, $3, 'Foreign', '2040-01-01', $3) RETURNING id`,
        [world.foreignEventId, world.foreign.guildId, assignee],
      );
      const { client, edits } = fakeClient();

      const ran = await run(
        world.router,
        click(rows[0]?.id ?? "", { member: officer(assignee) }),
        dependenciesFor(world.db(), client),
      );

      expect(refusedWith(ran, edits)).toBe(FIXED_REFUSAL);
      expect((await row(rows[0]?.id ?? ""))?.status).toBe("open");
    });

    it("refuses a deleted task, even for its assignee", async () => {
      const { eventId } = await eventWithPost();
      const assignee = fakeId();
      const task = await newTask(eventId, assignee);
      unwrap(
        await softDeleteTask(world.db(), {
          guildId: GUILD_ID,
          taskId: task.id,
          now: new Date(),
        }),
      );
      const { client, edits } = fakeClient();

      const ran = await run(
        world.router,
        click(task.id, { member: plainMember(assignee) }),
        dependenciesFor(world.db(), client),
      );

      expect(refusedWith(ran, edits)).toBe(FIXED_REFUSAL);
    });

    it("refuses a task on a closed event, with a reason, for those allowed", async () => {
      const { eventId } = await eventWithPost();
      const assignee = fakeId();
      const task = await newTask(eventId, assignee);
      unwrap(await closeEvent(world.db(), { guildId: GUILD_ID, eventId }));
      const { client, edits } = fakeClient();

      await run(
        world.router,
        click(task.id, { member: plainMember(assignee) }),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content).toContain("closed or deleted");
      expect((await row(task.id))?.status).toBe("open");
    });

    it("stops a click when the task is reassigned between the read and the write", async () => {
      const { eventId } = await eventWithPost();
      const assignee = fakeId();
      const replacement = fakeId();
      const task = await newTask(eventId, assignee);
      const { client, edits } = fakeClient();

      await run(
        world.router,
        click(task.id, { member: plainMember(assignee) }),
        world.racing(client, "update", async () => {
          unwrap(
            await editTask(world.db(), {
              actorId: fakeId(),
              guildId: GUILD_ID,
              taskId: task.id,
              expectedUpdatedAt: task.updated_at,
              description: task.description,
              dueDate: task.due_date,
              assigneeId: replacement,
            }),
          );
        }),
      );

      expect(await row(task.id)).toMatchObject({
        status: "open",
        assignee_id: replacement,
      });
      expect(edits[0]?.content).toContain("reassigned or deleted");
    });

    it("says the event is closed when it closes between the read and the write", async () => {
      const { eventId } = await eventWithPost();
      const assignee = fakeId();
      const task = await newTask(eventId, assignee);
      const { client, edits } = fakeClient();

      await run(
        world.router,
        click(task.id, { member: plainMember(assignee) }),
        world.racing(client, "update", async () => {
          unwrap(await closeEvent(world.db(), { guildId: GUILD_ID, eventId }));
        }),
      );

      expect(edits[0]?.content).toContain("closed or deleted");
      expect((await row(task.id))?.status).toBe("open");
      expect(refreshOverview).not.toHaveBeenCalled();
    });

    it("calls it a no-op when someone else finishes it between the read and the write", async () => {
      const { eventId } = await eventWithPost();
      const assignee = fakeId();
      const task = await newTask(eventId, assignee);
      const { client, edits } = fakeClient();

      await run(
        world.router,
        click(task.id, { member: plainMember(assignee) }),
        world.racing(client, "update", async () => {
          await world.backend.connection.query(
            `UPDATE public.tasks SET status = 'done', completed_at = now() WHERE id = $1`,
            [task.id],
          );
        }),
      );

      expect(edits[0]?.content).toContain("already done");
    });
  });

  describe("/mytasks", () => {
    function mytasks(fields: Record<string, unknown>, data = {}) {
      return commandPayload("mytasks", fields, data);
    }

    it("lists only the caller's open tasks on open events, from the signed member", async () => {
      const me = fakeId();
      const other = fakeId();
      const open = await eventWithPost();
      const closed = await eventWithPost();
      const removed = await eventWithPost();
      const mine = await newTask(open.eventId, me, "Mine and open");
      const theirs = await newTask(open.eventId, other, "Someone else's");
      const finished = await newTask(open.eventId, me, "Mine and finished");
      const gone = await newTask(open.eventId, me, "Mine and deleted");
      await newTask(closed.eventId, me, "On a closed event");
      await newTask(removed.eventId, me, "On a deleted event");
      await queryAs(
        world.backend.connection,
        "bot_app",
        `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
         VALUES ($1, $2, $3, 'In another guild', '2040-01-01', $3)`,
        [world.foreignEventId, world.foreign.guildId, me],
      );
      await world.backend.connection.query(
        `UPDATE public.tasks SET status = 'done', completed_at = now() WHERE id = $1`,
        [finished.id],
      );
      unwrap(
        await softDeleteTask(world.db(), {
          guildId: GUILD_ID,
          taskId: gone.id,
          now: new Date(),
        }),
      );
      unwrap(
        await closeEvent(world.db(), {
          guildId: GUILD_ID,
          eventId: closed.eventId,
        }),
      );
      unwrap(
        await softDeleteEvent(world.db(), {
          guildId: GUILD_ID,
          eventId: removed.eventId,
        }),
      );
      const { client, edits } = fakeClient();

      const ran = await run(
        world.router,
        // No option is registered, and these must not change whose list it is.
        mytasks(
          { member: plainMember(me) },
          { options: stringOptions({ person: other, assignee_id: other }) },
        ),
        dependenciesFor(world.db(), client),
      );

      expect(ran.reply).toEqual({
        type: DEFERRED_MESSAGE,
        data: { flags: EPHEMERAL },
      });
      const content = edits[0]?.content ?? "";
      expect(content).toContain("Mine and open");
      expect(content).toContain(mine.id.slice(0, 8));
      expect(content).toContain("2040\\-06\\-15");
      for (const absent of [
        "Someone else's",
        "finished",
        "deleted",
        "closed",
        "another guild",
        theirs.id.slice(0, 8),
      ]) {
        expect(content).not.toContain(absent);
      }
      expect(edits[0]?.flags).toBe(SUPPRESS_EMBEDS);
    });

    it("works in a channel the bot does not manage, with nothing public", async () => {
      const me = fakeId();
      const { eventId } = await eventWithPost();
      await newTask(eventId, me, "Anywhere");
      const { client, edits, notices } = fakeClient();

      await run(
        world.router,
        mytasks({
          member: plainMember(me),
          channel: { id: fakeId(), type: 0 },
        }),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content).toContain("Anywhere");
      expect(notices).toEqual([]);
    });

    it("renders hostile task and event text inert", async () => {
      const me = fakeId();
      const eventId = await insertEvent(
        world.backend.connection,
        world.fixture,
      );
      await world.backend.connection.query(
        `UPDATE public.events SET name = $1 WHERE id = $2`,
        [`@everyone <@&${fakeId()}> [login](https://evil.example)`, eventId],
      );
      await newTask(eventId, me, "# fake\n@here ||x|| \u202Eabc");
      const { client, edits } = fakeClient();

      await run(
        world.router,
        mytasks({ member: plainMember(me) }),
        dependenciesFor(world.db(), client),
      );

      const live = (edits[0]?.content ?? "").replace(/\\[\s\S]/gu, "");
      expect(live).not.toMatch(/@everyone|@here|<@|\[login\]\(|\|\||\u202E/u);
      expect((edits[0]?.content ?? "").split("\n")).toHaveLength(2);
      expect(edits[0]).toMatchObject({
        allowed_mentions: { parse: [], users: [] },
      });
    });

    it("says how many are hidden when they don't fit one message", async () => {
      const me = fakeId();
      const { eventId } = await eventWithPost();
      for (let index = 0; index < 30; index += 1) {
        await newTask(eventId, me, "*".repeat(200));
      }
      const { client, edits } = fakeClient();

      await run(
        world.router,
        mytasks({ member: plainMember(me) }),
        dependenciesFor(world.db(), client),
      );

      const content = edits[0]?.content ?? "";
      expect(content.length).toBeLessThanOrEqual(2000);
      const shown = content.split("\n").filter((line) => line.startsWith("- "));
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.length).toBeLessThan(30);
      expect(content).toContain(`...and ${String(30 - shown.length)} more.`);
    });

    it("says at least, when there are more than can even be read", async () => {
      const me = fakeId();
      const first = await insertEvent(world.backend.connection, world.fixture);
      const second = await insertEvent(world.backend.connection, world.fixture);
      for (const eventId of [first, second]) {
        await world.backend.connection.query(
          `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
           SELECT $1::uuid, $2::text, $3::text, 'Volume', date '2040-01-01', ($4::bigint + n)::text
           FROM generate_series(1, 60) AS n`,
          [eventId, GUILD_ID, me, fakeId()],
        );
      }
      const { client, edits } = fakeClient();

      await run(
        world.router,
        mytasks({ member: plainMember(me) }),
        dependenciesFor(world.db(), client),
      );

      const content = edits[0]?.content ?? "";
      const shown = content.split("\n").filter((line) => line.startsWith("- "));
      expect(content).toContain(
        `...and at least ${String(100 - shown.length)} more.`,
      );
    });

    it("says so when there is nothing to do", async () => {
      const { client, edits } = fakeClient();

      await run(
        world.router,
        mytasks({ member: plainMember() }),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content).toBe("You have no open tasks.");
    });

    it("gives a replayer no content in the HTTP reply", async () => {
      const me = fakeId();
      const { eventId } = await eventWithPost();
      await newTask(eventId, me, "Private work");
      const { client } = fakeClient();

      const ran = await run(
        world.router,
        mytasks({ member: plainMember(me) }),
        dependenciesFor(world.db(), client),
      );

      expect(JSON.stringify(ran.reply)).not.toContain("Private work");
    });
  });

  describe("autocomplete", () => {
    async function choices(
      name: "edit" | "delete" | "assign" | "done",
      typed: unknown,
      fields: Record<string, unknown>,
    ) {
      const { client } = fakeClient();
      const ran = await run(
        world.router,
        pickerPayload(name, typed, fields),
        dependenciesFor(world.db(), client),
      );
      return (ran.reply.data?.choices ?? []) as {
        name: string;
        value: string;
      }[];
    }

    it("limits task.done to a member's own tasks, and shows an officer all", async () => {
      const me = fakeId();
      const { eventId } = await eventWithPost();
      const mine = await newTask(eventId, me, "Pickertest mine");
      const theirs = await newTask(eventId, fakeId(), "Pickertest theirs");

      const asMember = await choices("done", "Pickertest", {
        member: plainMember(me),
      });
      const asOfficer = await choices("done", "Pickertest", {
        member: officer(),
      });

      expect(asMember.map((choice) => choice.value)).toEqual([mine.id]);
      expect(asOfficer.map((choice) => choice.value)).toEqual(
        expect.arrayContaining([mine.id, theirs.id]),
      );
    });

    it("shows a short ID and the due date", async () => {
      const me = fakeId();
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, me, "Labeltest print signs");

      const [choice] = await choices("done", "Labeltest", {
        member: plainMember(me),
      });

      expect(choice?.name).toBe(
        `${task.id.slice(0, 8)} due ${FAR_DUE} Labeltest print signs`,
      );
      expect(choice?.value).toBe(task.id);
    });

    it("cleans hostile text out of a label and keeps it valid", async () => {
      const me = fakeId();
      const { eventId } = await eventWithPost();
      const symbols = await newTask(eventId, me, "Hostiletest ***");
      const onlySymbols = await newTask(eventId, me, "***");
      const long = await newTask(eventId, me, `Hostiletest ${"x".repeat(900)}`);
      const astral = await newTask(
        eventId,
        me,
        `Hostiletest ${"\u{1F389}".repeat(400)}`,
      );
      const hostile = await newTask(
        eventId,
        me,
        "Hostiletest <@&1> @everyone https://evil.example\n# x",
      );

      const found = await choices("done", "", { member: plainMember(me) });

      expect(found.map((choice) => choice.value).sort()).toEqual(
        [symbols.id, onlySymbols.id, long.id, astral.id, hostile.id].sort(),
      );
      for (const { name } of found) {
        expect(name.length).toBeLessThanOrEqual(100);
        expect(name).not.toMatch(/[<@:/#\n]/u);
      }
      expect(found.find((c) => c.value === onlySymbols.id)?.name).toBe(
        `${onlySymbols.id.slice(0, 8)} due ${FAR_DUE}`,
      );
    });

    it("leaves out deleted tasks, finished tasks, closed events and other guilds", async () => {
      const me = fakeId();
      const open = await eventWithPost();
      const closed = await eventWithPost();
      const kept = await newTask(open.eventId, me, "Scopetest kept");
      const finished = await newTask(open.eventId, me, "Scopetest finished");
      const removed = await newTask(open.eventId, me, "Scopetest deleted");
      await newTask(closed.eventId, me, "Scopetest closed");
      await queryAs(
        world.backend.connection,
        "bot_app",
        `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
         VALUES ($1, $2, $3, 'Scopetest foreign', '2040-01-01', $3)`,
        [world.foreignEventId, world.foreign.guildId, me],
      );
      await world.backend.connection.query(
        `UPDATE public.tasks SET status = 'done', completed_at = now() WHERE id = $1`,
        [finished.id],
      );
      unwrap(
        await softDeleteTask(world.db(), {
          guildId: GUILD_ID,
          taskId: removed.id,
          now: new Date(),
        }),
      );
      unwrap(
        await closeEvent(world.db(), {
          guildId: GUILD_ID,
          eventId: closed.eventId,
        }),
      );

      const found = await choices("done", "Scopetest", { member: officer() });

      expect(found.map((choice) => choice.value)).toEqual([kept.id]);
    });

    describe("by the start of an ID", () => {
      it("finds a task by its short ID, first, and only within the caller's rows", async () => {
        const me = fakeId();
        const { eventId } = await eventWithPost();
        const mine = await newTask(eventId, me, "Idsearch mine");
        const theirs = await newTask(eventId, fakeId(), "Idsearch theirs");

        const asMember = await choices("done", mine.id.slice(0, 8), {
          member: plainMember(me),
        });
        const oneDigit = await choices("done", mine.id.slice(0, 1), {
          member: plainMember(me),
        });
        const notMine = await choices("done", theirs.id.slice(0, 8), {
          member: plainMember(me),
        });
        const asOfficer = await choices("done", theirs.id.slice(0, 8), {
          member: officer(),
        });

        expect(asMember[0]?.value).toBe(mine.id);
        expect(oneDigit.map((choice) => choice.value)).toContain(mine.id);
        expect(notMine.map((choice) => choice.value)).not.toContain(theirs.id);
        expect(asOfficer[0]?.value).toBe(theirs.id);
      });

      it("lists a row once when both its ID and its text match", async () => {
        const me = fakeId();
        const { eventId } = await eventWithPost();
        const task = await newTask(eventId, me, "placeholder");
        const start = task.id.slice(0, 8);
        await world.backend.connection.query(
          `UPDATE public.tasks SET description = $1 WHERE id = $2`,
          [`Note ${start}`, task.id],
        );

        const found = await choices("done", start, {
          member: plainMember(me),
        });

        expect(found.map((choice) => choice.value)).toEqual([task.id]);
      });

      it("treats longer hex, and capitals, as text alone", async () => {
        const me = fakeId();
        const { eventId } = await eventWithPost();
        // An all-digit prefix has no capitals, so it would still be a valid prefix.
        let task = await newTask(eventId, me, "Plain text");
        while (!/[a-f]/.test(task.id.slice(0, 8))) {
          task = await newTask(eventId, me, "Plain text");
        }

        for (const term of [
          `${task.id.slice(0, 8)}0`,
          task.id.slice(0, 8).toUpperCase(),
        ]) {
          expect(
            (await choices("done", term, { member: plainMember(me) })).map(
              (choice) => choice.value,
            ),
          ).not.toContain(task.id);
        }
      });
    });

    it("never offers more than 25", async () => {
      const me = fakeId();
      const { eventId } = await eventWithPost();
      for (let index = 0; index < 30; index += 1) {
        await newTask(eventId, me, "Capped row");
      }

      const found = await choices("done", "Capped", {
        member: plainMember(me),
      });

      expect(found).toHaveLength(25);
    });

    it.each([
      ["a comma filter", "x,deleted_at.not.is.null"],
      ["a closing paren", "x)"],
      ["a dot", "a.b"],
      ["a quote", 'x","y'],
      ["a percent", "%"],
      ["an underscore", "_"],
      ["NUL", "x\u0000y"],
      ["a lone surrogate", "x\ud800y"],
      ["over the limit", "x".repeat(101)],
      ["not a string", 5],
    ])("stays inside the caller's rows for %s", async (_name, typed) => {
      const me = fakeId();
      const { eventId } = await eventWithPost();
      const mine = await newTask(eventId, me, "Hostileterm row");
      await newTask(eventId, fakeId(), "Hostileterm other");

      const found = await choices("done", typed, { member: plainMember(me) });

      for (const { value } of found) {
        expect(value).toBe(mine.id);
      }
    });

    describe("what a keystroke costs", () => {
      function countingWorld(typed: unknown, member: Record<string, unknown>) {
        const counted = { statements: 0 };
        const db = world.backend.dbWith(() => {
          counted.statements += 1;
          return Promise.resolve();
        });
        const discordCalls: string[] = [];
        const refuse = new Proxy(
          {},
          {
            get: (_target, name) => () => {
              discordCalls.push(String(name));
              return Promise.reject(new Error("no Discord call allowed"));
            },
          },
        ) as DiscordClient;
        return {
          counted,
          discordCalls,
          ran: run(
            world.router,
            pickerPayload("done", typed, { member }),
            dependenciesFor(db, refuse),
          ),
        };
      }

      it("sends two statements and calls Discord never", async () => {
        const { ran, counted, discordCalls } = countingWorld(
          "room",
          plainMember(),
        );

        await ran;

        expect(counted.statements).toBe(2);
        expect(discordCalls).toEqual([]);
      });

      it("adds one statement for text that could start an ID", async () => {
        const { ran, counted } = countingWorld("abc", plainMember());

        await ran;

        expect(counted.statements).toBe(3);
      });

      it.each([
        ["NUL", "x\u0000y"],
        ["a lone surrogate", "x\ud800y"],
      ])("reads no task for %s", async (_name, typed) => {
        const { ran, counted } = countingWorld(typed, plainMember());

        const { reply } = await ran;

        expect(reply.data?.choices).toEqual([]);
        expect(counted.statements).toBe(1);
      });

      it("stays inside the budget on a large table with a pathological term", async () => {
        const seededEvent = await insertEvent(
          world.backend.connection,
          world.fixture,
        );
        await withoutQuotas(world.backend.connection, () =>
          world.backend.connection.query(
            `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
             SELECT $1::uuid, $2::text, $3::text, 'Volume %_ row', date '2050-01-01' + (n % 700), $3::text
             FROM generate_series(1, 5000) AS n`,
            [seededEvent, GUILD_ID, fakeId()],
          ),
        );
        await world.backend.connection.exec("ANALYZE public.tasks;");

        const started = Date.now();
        await choices("done", "%_\\*".repeat(25), { member: officer() });
        const elapsed = Date.now() - started;

        await world.backend.connection.query(
          `UPDATE public.tasks SET deleted_at = now() WHERE event_id = $1`,
          [seededEvent],
        );
        expect(elapsed).toBeLessThan(2500);
      });
    });
  });

  it("re-reads a task submitted from a list that has since gone stale", async () => {
    const { eventId } = await eventWithPost();
    const assignee = fakeId();
    const task = await newTask(eventId, assignee);
    unwrap(
      await editTask(world.db(), {
        actorId: fakeId(),
        guildId: GUILD_ID,
        taskId: task.id,
        expectedUpdatedAt: task.updated_at,
        description: task.description,
        dueDate: task.due_date,
        assigneeId: fakeId(),
      }),
    );
    const { client, edits } = fakeClient();

    const ran = await run(
      world.router,
      subcommand("done", stringOptions({ task: task.id }), {
        member: plainMember(assignee),
      }),
      dependenciesFor(world.db(), client),
    );

    expect(refusedWith(ran, edits)).toBe(FIXED_REFUSAL);
    expect(
      unwrap(await getTask(world.db(), { guildId: GUILD_ID, taskId: task.id }))
        ?.status,
    ).toBe("open");
  });
});
