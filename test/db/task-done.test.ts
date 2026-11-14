/**
 * /task done, the Mark done button, /mytasks and the task picker from the router down to
 * the real schema. Every rule that depends on a row, a filter or a trigger is proved here
 * and not on a mock.
 */

import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { closeEvent, softDeleteEvent } from "../../src/db/events.ts";
import { softDeleteTask } from "../../src/db/tasks.ts";
import {
  commandPayload,
  componentPayload,
  dependenciesFor,
  GUILD_ID,
  run,
} from "../support/interactions.ts";
import { fakeId } from "../support/ids.ts";
import { insertEvent } from "./fixtures.ts";
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
} from "./task-world.ts";

describe("marking tasks done and reading them, on the real schema", () => {
  const world = useTaskWorld();

  beforeEach(() => {
    // The access check and failed sends log; the replies are what these tests read.
    spyOn(console, "error").mockImplementation(() => undefined);
  });
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

    it.each([
      ["an extra field", `task.done:${UNKNOWN_ID}:${UNKNOWN_ID}`],
      ["a filter", "task.done:x,status.eq.done"],
      ["a Discord ID in place of a task", `task.done:${fakeId()}`],
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

    it.each(["an unknown", "another guild's", "a deleted"])(
      "gives %s task the one refusal, even for its assignee",
      async (which) => {
        const assignee = fakeId();
        let taskId = UNKNOWN_ID;
        if (which === "a deleted") {
          const { eventId } = await eventWithPost();
          taskId = (await newTask(eventId, assignee)).id;
          unwrap(
            await softDeleteTask(world.db(), {
              guildId: GUILD_ID,
              taskId,
              now: new Date(),
            }),
          );
        } else if (which === "another guild's") {
          const rows = await queryAs<{ id: string }>(
            world.backend.connection,
            "bot_app",
            `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
             VALUES ($1, $2, $3, 'Foreign', '2040-01-01', $3) RETURNING id`,
            [world.foreignEventId, world.foreign.guildId, assignee],
          );
          taskId = rows[0]?.id ?? "";
        }
        const { client, edits } = fakeClient();

        const ran = await run(
          world.router,
          click(taskId, { member: plainMember(assignee) }),
          dependenciesFor(world.db(), client),
        );

        expect(refusedWith(ran, edits)).toBe(FIXED_REFUSAL);
        expect((await row(taskId))?.status ?? "open").toBe("open");
      },
    );

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

    it("says so when there is nothing to do", async () => {
      const { client, edits } = fakeClient();

      await run(
        world.router,
        mytasks({ member: plainMember() }),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content).toBe("You have no open tasks.");
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
        expect.arrayContaining([mine.id, theirs.id]) as string[],
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
      ["a percent", "%"],
      ["NUL", "x\u0000y"],
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
  });
});
