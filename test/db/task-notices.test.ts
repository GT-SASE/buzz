/**
 * What an officer is told after a task change: whether the person was mentioned, whether
 * they can reach the post, and whether the post itself is still right.
 */

import { PermissionFlagsBits } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { DiscordClientError } from "../../src/discord/client.ts";
import type {
  DiscordClient,
  DiscordFailure,
  GuildRole,
  PermissionOverwrite,
} from "../../src/discord/client.ts";
import { setEventThread } from "../../src/db/events.ts";
import { createRouter } from "../../src/handlers/router.ts";
import { handler } from "../../src/handlers/task.ts";
import {
  componentPayload,
  dependenciesFor,
  GUILD_ID,
  run,
} from "../support/interactions.ts";
import { testSnowflake } from "../support/mock-postgrest.ts";
import { insertEvent } from "./fixtures.ts";
import { queryAs } from "./harness.ts";
import {
  EPHEMERAL,
  FAR_DUE,
  fakeClient,
  FIXED_REFUSAL,
  OPTION,
  officer,
  pickerPayload,
  plainMember,
  stringOptions,
  subcommand,
  SUPPRESS_EMBEDS,
  UNKNOWN_ID,
  unwrap,
  useTaskWorld,
} from "./task-world.ts";

function resolvedHuman(person: string) {
  return { users: { [person]: { id: person } }, members: { [person]: {} } };
}

function assignPayload(
  person: string,
  fields: Record<string, unknown>,
  event?: string,
) {
  return subcommand(
    "assign",
    [
      { name: "person", type: OPTION.user, value: person },
      ...stringOptions({
        description: "Book the room",
        due: FAR_DUE,
        ...(event === undefined ? {} : { event }),
      }),
    ],
    fields,
    resolvedHuman(person),
  );
}

describe("what an officer is told after a task change", () => {
  const world = useTaskWorld();
  const { eventWithPost, inThread } = world;

  describe("when the notice's send fails", () => {
    async function replyAfter(failure: DiscordFailure) {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { threadId } = await eventWithPost();
      const { client, edits } = fakeClient({
        sendMessage: () =>
          Promise.reject(new DiscordClientError("send message", failure)),
      });
      const person = testSnowflake();
      await run(
        world.router,
        assignPayload(person, { member: officer(), ...inThread(threadId) }),
        dependenciesFor(world.db(), client),
      );
      return { reply: edits[0]?.content ?? "", person };
    }

    it.each<[string, DiscordFailure]>([
      ["no answer", { kind: "network" }],
      ["an unreadable success", { kind: "invalid_response", status: 200 }],
      ["a server error", { kind: "api", status: 502, code: undefined }],
    ])("says it may have gone out after %s", async (_label, failure) => {
      const { reply, person } = await replyAfter(failure);

      expect(reply).toContain(`<@${person}> may not have been mentioned`);
      expect(reply).not.toContain("was not mentioned");
    });

    it.each<[string, DiscordFailure]>([
      ["a refusal", { kind: "api", status: 400, code: 160005 }],
      ["a removed forum", { kind: "unmanaged_target", channelId: "1" }],
      [
        "a rate limit",
        { kind: "rate_limited", retryAfterMs: 1, attempts: 3, scope: "user" },
      ],
    ])("says it did not go out after %s", async (_label, failure) => {
      const { reply, person } = await replyAfter(failure);

      expect(reply).toContain(`<@${person}> was not mentioned`);
    });
  });

  describe("the person's access to the forum", () => {
    const VIEW = PermissionFlagsBits.ViewChannel;
    const MEMBER_ROLE = testSnowflake();

    /** A forum closed to @everyone and open to one role. */
    function privateForum(
      overrides: Partial<DiscordClient> = {},
      memberRoleIds: readonly string[] = [],
      extra: readonly PermissionOverwrite[] = [],
    ) {
      const roles: GuildRole[] = [
        {
          id: GUILD_ID,
          name: "everyone",
          permissions: VIEW,
          position: 0,
          managed: false,
        },
        {
          id: MEMBER_ROLE,
          name: "crew",
          permissions: 0n,
          position: 1,
          managed: false,
        },
      ];
      return fakeClient({
        getGuildRoles: () => Promise.resolve(roles),
        getGuildChannels: () =>
          Promise.resolve([
            {
              id: world.fixture.channelId,
              name: "forum",
              type: 15,
              overwrites: [
                { id: GUILD_ID, type: 0, allow: 0n, deny: VIEW },
                { id: MEMBER_ROLE, type: 0, allow: VIEW, deny: 0n },
                ...extra,
              ],
            },
          ]),
        getGuildMemberRoleIds: () => Promise.resolve(memberRoleIds),
        ...overrides,
      });
    }

    async function assigned(client: DiscordClient, person: string) {
      const { threadId } = await eventWithPost();
      await run(
        world.router,
        assignPayload(person, { member: officer(), ...inThread(threadId) }),
        dependenciesFor(world.db(), client),
      );
    }

    it("warns the officer on assign, and still saves and posts", async () => {
      const person = testSnowflake();
      const { client, edits, notices } = privateForum();

      await assigned(client, person);

      const reply = edits[0]?.content ?? "";
      expect(reply).toContain(`<@${person}> was mentioned`);
      expect(reply).toContain(`<@${person}> can't view this event's forum`);
      expect(reply).toContain("/mytasks");
      expect(notices).toHaveLength(1);
    });

    it("warns the officer on a reassignment", async () => {
      const after = testSnowflake();
      const { eventId } = await eventWithPost();
      const task = await world.newTask(eventId, testSnowflake());
      const { client, edits } = privateForum();

      await run(
        world.router,
        subcommand(
          "edit",
          [
            ...stringOptions({ task: task.id }),
            { name: "person", type: OPTION.user, value: after },
          ],
          { member: officer() },
          resolvedHuman(after),
        ),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content).toContain(
        `<@${after}> can't view this event's forum`,
      );
    });

    it("does not read Discord when the person doesn't change", async () => {
      const { eventId } = await eventWithPost();
      const task = await world.newTask(eventId, testSnowflake());
      const getGuildRoles = vi.fn<DiscordClient["getGuildRoles"]>(() =>
        Promise.resolve([]),
      );
      const { client } = fakeClient({ getGuildRoles });

      await run(
        world.router,
        subcommand(
          "edit",
          stringOptions({ task: task.id, description: "Book the hall" }),
          { member: officer() },
        ),
        dependenciesFor(world.db(), client),
      );

      expect(getGuildRoles).not.toHaveBeenCalled();
    });

    it("stays quiet for someone a role lets in", async () => {
      const { client, edits } = privateForum({}, [MEMBER_ROLE]);

      await assigned(client, testSnowflake());

      expect(edits[0]?.content).toContain("was mentioned");
      expect(edits[0]?.content).not.toContain("can't view");
    });

    it("stays quiet for someone their own overwrite lets in", async () => {
      const person = testSnowflake();
      const { client, edits } = privateForum(
        {},
        [],
        [{ id: person, type: 1, allow: VIEW, deny: 0n }],
      );

      await assigned(client, person);

      expect(edits[0]?.content).not.toContain("can't view");
    });

    it("keeps the reply and quotes nothing when the check fails", async () => {
      const logged = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const { client, edits } = privateForum({
        getGuildChannels: () => Promise.reject(new Error("canary failure")),
      });

      await assigned(client, testSnowflake());

      expect(edits[0]?.content).toContain("was mentioned");
      expect(edits[0]?.content).not.toContain("can't view");
      expect(JSON.stringify(logged.mock.calls)).not.toContain("canary");
    });
  });

  describe("under a removed forum", () => {
    it("keeps the task and says reminders are off until the forum is back", async () => {
      const removedForum = testSnowflake();
      const version = async () => {
        const rows = await queryAs<{ version: number }>(
          world.backend.connection,
          "service_role",
          `SELECT version FROM public.guild_config WHERE guild_id = $1`,
          [GUILD_ID],
        );
        return rows[0]?.version ?? 0;
      };
      await queryAs(
        world.backend.connection,
        "service_role",
        `SELECT public.apply_config_change($1, $2, $3, NULL, ARRAY[$4]::text[])`,
        [GUILD_ID, await version(), testSnowflake(), removedForum],
      );
      const eventId = await insertEvent(world.backend.connection, {
        ...world.fixture,
        channelId: removedForum,
      });
      unwrap(
        await setEventThread(world.db(), {
          guildId: GUILD_ID,
          eventId,
          threadId: testSnowflake(),
        }),
      );
      await queryAs(
        world.backend.connection,
        "service_role",
        `SELECT public.apply_config_change($1, $2, $3, NULL, NULL, ARRAY[$4]::text[])`,
        [GUILD_ID, await version(), testSnowflake(), removedForum],
      );
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const person = testSnowflake();
      const { client, edits } = fakeClient({
        sendMessage: () =>
          Promise.reject(
            new DiscordClientError("send message", {
              kind: "unmanaged_target",
              channelId: removedForum,
            }),
          ),
      });

      await run(
        world.router,
        assignPayload(person, { member: officer() }, eventId),
        dependenciesFor(world.db(), client),
      );

      expect(await world.tasksOn(eventId)).toHaveLength(1);
      const reply = edits[0]?.content ?? "";
      expect(reply).toContain(`<@${person}> was not mentioned`);
      expect(reply).toContain("no longer managed");
      expect(reply).toContain("reminders for this task are off");
      expect(reply).toContain("/config");
    });

    it("gives no such warning under an active forum", async () => {
      const { threadId } = await eventWithPost();
      const { client, edits } = fakeClient();

      await run(
        world.router,
        assignPayload(testSnowflake(), {
          member: officer(),
          ...inThread(threadId),
        }),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content).not.toContain("no longer managed");
    });
  });

  describe("when the overview can't be updated", () => {
    const NOT_UPDATED = "couldn't update the task list in the event's post";

    function refused() {
      world.refreshOverview.mockResolvedValue(false);
    }

    it("says so after /task done", async () => {
      refused();
      const { eventId } = await eventWithPost();
      const task = await world.newTask(eventId, testSnowflake());
      const { client, edits } = fakeClient();

      await run(
        world.router,
        subcommand("done", stringOptions({ task: task.id }), {
          member: officer(),
        }),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content).toContain("Marked done");
      expect(edits[0]?.content).toContain(NOT_UPDATED);
      expect((await world.row(task.id))?.status).toBe("done");
    });

    it("says so through the live command, whose refresh really fails", async () => {
      const { eventId } = await eventWithPost();
      const task = await world.newTask(eventId, testSnowflake());
      const { client, edits } = fakeClient({
        sendMessage: () => Promise.reject(new Error("post refused")),
      });
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await run(
        createRouter([handler]),
        subcommand("done", stringOptions({ task: task.id }), {
          member: officer(),
        }),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content).toContain("Marked done");
      expect(edits[0]?.content).toContain(NOT_UPDATED);
    });

    it("says so after the Mark done button", async () => {
      refused();
      const { eventId } = await eventWithPost();
      const assignee = testSnowflake();
      const task = await world.newTask(eventId, assignee);
      const { client, edits } = fakeClient();

      await run(
        world.router,
        componentPayload(`task.done:${task.id}`, {
          member: plainMember(assignee),
          message: { id: testSnowflake(), flags: SUPPRESS_EMBEDS },
        }),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content).toContain("Marked done");
      expect(edits[0]?.content).toContain(NOT_UPDATED);
    });

    it("says so after /task edit", async () => {
      refused();
      const { eventId } = await eventWithPost();
      const task = await world.newTask(eventId, testSnowflake());
      const { client, edits } = fakeClient();

      await run(
        world.router,
        subcommand(
          "edit",
          stringOptions({ task: task.id, description: "Book the hall" }),
          { member: officer() },
        ),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content).toContain("Saved task");
      expect(edits[0]?.content).toContain(NOT_UPDATED);
    });

    it("says so after /task assign, and when the refresh throws", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      world.refreshOverview.mockRejectedValue(new Error("canary overview"));
      const { threadId } = await eventWithPost();
      const { client, edits } = fakeClient();

      await run(
        world.router,
        assignPayload(testSnowflake(), {
          member: officer(),
          ...inThread(threadId),
        }),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content).toContain("Assigned task");
      expect(edits[0]?.content).toContain(NOT_UPDATED);
      expect(edits[0]?.content).not.toContain("canary");
    });

    it("says nothing when it was updated", async () => {
      const { eventId } = await eventWithPost();
      const task = await world.newTask(eventId, testSnowflake());
      const { client, edits } = fakeClient();

      await run(
        world.router,
        subcommand("done", stringOptions({ task: task.id }), {
          member: officer(),
        }),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content).not.toContain(NOT_UPDATED);
    });

    it("says nothing extra when the event has no post to update", async () => {
      refused();
      const eventId = await insertEvent(
        world.backend.connection,
        world.fixture,
      );
      const task = await world.newTask(eventId, testSnowflake());
      const { client, edits } = fakeClient();

      await run(
        world.router,
        subcommand("done", stringOptions({ task: task.id }), {
          member: officer(),
        }),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content).toContain("Marked done");
      expect(edits[0]?.content).not.toContain(NOT_UPDATED);
    });
  });

  describe("text typed instead of a picker choice", () => {
    const PICK = "Pick a choice from the list";

    function shortId(id: string) {
      return id.slice(0, 8);
    }

    async function doneTyped(
      typed: string,
      member: Record<string, unknown>,
    ): Promise<string | undefined> {
      const { client, edits } = fakeClient();
      await run(
        world.router,
        subcommand("done", stringOptions({ task: typed }), { member }),
        dependenciesFor(world.db(), client),
      );
      return edits[0]?.content;
    }

    it("takes an assignee's whole short ID for their own task", async () => {
      const assignee = testSnowflake();
      const { eventId } = await eventWithPost();
      const task = await world.newTask(eventId, assignee);

      const reply = await doneTyped(shortId(task.id), plainMember(assignee));

      expect(reply).toContain("Marked done");
      expect((await world.row(task.id))?.status).toBe("done");
    });

    it("does not reach someone else's task, or say it exists", async () => {
      const { eventId } = await eventWithPost();
      const task = await world.newTask(eventId, testSnowflake());

      const reply = await doneTyped(shortId(task.id), plainMember());

      expect(reply).toContain(PICK);
      expect((await world.row(task.id))?.status).toBe("open");
    });

    it("takes an officer's short ID for anyone's task", async () => {
      const { eventId } = await eventWithPost();
      const task = await world.newTask(eventId, testSnowflake());

      const reply = await doneTyped(shortId(task.id), officer());

      expect(reply).toContain("Marked done");
    });

    it.each([
      ["a name", "Book the room"],
      ["the start of an ID", "ab12"],
      ["an ID that finds nothing", "00000000"],
    ])("asks for a choice after %s", async (_label, typed) => {
      expect(await doneTyped(typed, officer())).toContain(PICK);
    });

    it("won't act on the real start of a short ID", async () => {
      const { eventId } = await eventWithPost();
      const task = await world.newTask(eventId, testSnowflake());

      const reply = await doneTyped(task.id.slice(0, 4), officer());

      expect(reply).toContain(PICK);
      expect((await world.row(task.id))?.status).toBe("open");
    });

    it("won't guess between two tasks sharing a short ID", async () => {
      const { eventId } = await eventWithPost();
      const shared = "abcd1234";
      const ids = [
        `${shared}-0000-4000-8000-000000000001`,
        `${shared}-0000-4000-8000-000000000002`,
      ];
      for (const id of ids) {
        // The bot's role can't choose a task's ID, so the owner connection sets these up.
        await world.backend.connection.query(
          `INSERT INTO public.tasks (id, event_id, guild_id, assignee_id, description, due_date, created_by)
           VALUES ($1, $2, $3, $4, 'Book the room', $5, $6)`,
          [id, eventId, GUILD_ID, testSnowflake(), FAR_DUE, testSnowflake()],
        );
      }

      const reply = await doneTyped(shared, officer());

      expect(reply).toContain(PICK);
      for (const id of ids) {
        expect((await world.row(id))?.status).toBe("open");
      }
    });

    it("keeps the fixed refusal for a real ID that isn't usable", async () => {
      const reply = await doneTyped(UNKNOWN_ID, officer());

      expect(reply).toBe(FIXED_REFUSAL);
    });

    it("takes a short ID in /task edit, without touching other rows", async () => {
      const { eventId } = await eventWithPost();
      const task = await world.newTask(eventId, testSnowflake());
      const { client, edits } = fakeClient();

      await run(
        world.router,
        subcommand(
          "edit",
          stringOptions({
            task: shortId(task.id),
            description: "Book the hall",
          }),
          { member: officer() },
        ),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content).toContain("Saved task");
      expect((await world.row(task.id))?.description).toBe("Book the hall");
    });

    it("asks for a choice in /task delete", async () => {
      const { client, edits } = fakeClient();

      await run(
        world.router,
        subcommand("delete", stringOptions({ task: "Book the room" }), {
          member: officer(),
        }),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content ?? "").toContain(PICK);
    });

    it("takes a short ID for the event in /task assign", async () => {
      const { eventId } = await eventWithPost();
      const { client, edits } = fakeClient();

      await run(
        world.router,
        assignPayload(testSnowflake(), { member: officer() }, shortId(eventId)),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content).toContain("Assigned task");
      expect(await world.tasksOn(eventId)).toHaveLength(1);
    });

    it("asks for a choice when /task assign names an event in words", async () => {
      const { client, edits, notices } = fakeClient();

      await run(
        world.router,
        assignPayload(testSnowflake(), { member: officer() }, "Fall Social"),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content).toContain(PICK);
      expect(notices).toEqual([]);
    });
  });

  describe("deleting a done task", () => {
    function pick(typed: string) {
      const { client } = fakeClient();
      return run(
        world.router,
        pickerPayload("delete", typed, { member: officer() }),
        dependenciesFor(world.db(), client),
      ).then(
        (ran) =>
          (ran.reply.data?.choices ?? []) as { name: string; value: string }[],
      );
    }

    async function doneTask(description: string) {
      const { eventId } = await eventWithPost();
      const task = await world.newTask(eventId, testSnowflake(), description);
      const { client } = fakeClient();
      await run(
        world.router,
        subcommand("done", stringOptions({ task: task.id }), {
          member: officer(),
        }),
        dependenciesFor(world.db(), client),
      );
      return task;
    }

    it("offers it in the picker, marked done and after open ones", async () => {
      const done = await doneTask("Deletetest finished");
      const { eventId } = await eventWithPost();
      const open = await world.newTask(
        eventId,
        testSnowflake(),
        "Deletetest waiting",
      );

      const found = await pick("Deletetest");

      expect(found.map((choice) => choice.value)).toEqual([open.id, done.id]);
      expect(found[1]?.name).toContain("done, due");
      expect(found[0]?.name).not.toContain("done,");
    });

    it("finds it by its short ID", async () => {
      const done = await doneTask("Book the room");

      const found = await pick(done.id.slice(0, 8));

      expect(found.map((choice) => choice.value)).toEqual([done.id]);
    });

    it("still leaves it out of the /task done and edit pickers", async () => {
      const done = await doneTask("Pickerskip finished");
      const { client } = fakeClient();

      for (const name of ["done", "edit"] as const) {
        const ran = await run(
          world.router,
          pickerPayload(name, "Pickerskip", { member: officer() }),
          dependenciesFor(world.db(), client),
        );
        expect(
          ((ran.reply.data?.choices ?? []) as { value: string }[]).map(
            (choice) => choice.value,
          ),
        ).not.toContain(done.id);
      }
    });

    it("deletes it from a typed short ID, through the same Confirm", async () => {
      const done = await doneTask("Book the room");
      const { client, edits } = fakeClient();
      const by = officer();

      await run(
        world.router,
        subcommand("delete", stringOptions({ task: done.id.slice(0, 8) }), {
          member: by,
        }),
        dependenciesFor(world.db(), client),
      );

      const confirm = (
        edits[0]?.components as
          { components: { custom_id: string }[] }[] | undefined
      )?.[0]?.components[0]?.custom_id;
      expect(confirm).toBeDefined();
      await run(
        world.router,
        componentPayload(confirm ?? "", {
          member: by,
          message: { id: testSnowflake(), flags: EPHEMERAL },
        }),
        dependenciesFor(world.db(), client),
      );

      expect((await world.row(done.id))?.deleted).toBe(true);
    });

    it("says so when the post wasn't updated after a delete", async () => {
      world.refreshOverview.mockResolvedValue(false);
      const done = await doneTask("Book the room");
      const { client, edits } = fakeClient();
      const by = officer();
      await run(
        world.router,
        subcommand("delete", stringOptions({ task: done.id }), { member: by }),
        dependenciesFor(world.db(), client),
      );
      const confirm = (
        edits[0]?.components as { components: { custom_id: string }[] }[]
      )[0]?.components[0]?.custom_id;

      await run(
        world.router,
        componentPayload(confirm ?? "", {
          member: by,
          message: { id: testSnowflake(), flags: EPHEMERAL },
        }),
        dependenciesFor(world.db(), client),
      );

      const reply = edits.at(-1)?.content ?? "";
      expect(reply).toContain("Deleted");
      expect(reply).toContain("couldn't update the task list");
    });
  });

  describe("the /task assign event picker", () => {
    async function namedEvent(name: string, date: string) {
      const rows = await queryAs<{ id: string }>(
        world.backend.connection,
        "service_role",
        `INSERT INTO public.events (guild_id, channel_id, name, event_date, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [GUILD_ID, world.fixture.channelId, name, date, testSnowflake()],
      );
      return rows[0]?.id ?? "";
    }

    async function pick(typed: string) {
      const { client } = fakeClient();
      const ran = await run(
        world.router,
        pickerPayload("assign", typed, { member: officer() }),
        dependenciesFor(world.db(), client),
      );
      return (ran.reply.data?.choices ?? []) as {
        name: string;
        value: string;
      }[];
    }

    it("lists an upcoming event ahead of many past ones", async () => {
      for (let day = 10; day < 40; day += 1) {
        const month = String(Math.floor(day / 30) + 1).padStart(2, "0");
        const date = String((day % 28) + 1).padStart(2, "0");
        await namedEvent(
          `Sortcheck past ${String(day)}`,
          `2020-${month}-${date}`,
        );
      }
      const upcoming = await namedEvent("Sortcheck upcoming", "2099-01-15");

      const found = await pick("Sortcheck");

      expect(found).toHaveLength(25);
      expect(found[0]?.value).toBe(upcoming);
    });

    it("finds a tidied name from what was first typed", async () => {
      const event = await namedEvent("Tidycheck js 101", "2099-02-01");

      const found = await pick("Tidycheck.js 101");

      expect(found.map((choice) => choice.value)).toEqual([event]);
    });

    it("still finds a name typed as it is stored", async () => {
      const event = await namedEvent("Storedcheck night", "2099-03-01");

      const found = await pick("Storedcheck night");

      expect(found.map((choice) => choice.value)).toEqual([event]);
    });

    it("finds nothing from text with nothing usable in it", async () => {
      expect(await pick("@#:/")).toEqual([]);
    });

    it("still finds an event by the start of its ID", async () => {
      const event = await namedEvent("Idcheck", "2099-04-01");

      const found = await pick(event.slice(0, 8));

      expect(found.map((choice) => choice.value)).toContain(event);
    });
  });
});
