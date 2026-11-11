/**
 * /task assign, edit and delete from the router down to the real schema. Every rule that
 * depends on a row, a filter or a trigger is proved here and not on a mock.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiscordClient,
  DiscordClientError,
} from "../../src/discord/client.ts";
import { versionFingerprint } from "../../src/tasks/shared.ts";
import { managedChannelCheck } from "../../src/handlers/dependencies.ts";
import { COMMANDS, ROUTER } from "../../src/handlers/registry.ts";
import {
  closeEvent,
  setEventThread,
  softDeleteEvent,
} from "../../src/db/events.ts";
import {
  createTask,
  editTask,
  MAX_TASK_ACTIONS_PER_OFFICER_PER_DAY,
  MAX_TASKS_PER_EVENT,
  softDeleteTask,
} from "../../src/db/tasks.ts";
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
  admin,
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
  UNKNOWN_ID,
  unwrap,
  useTaskWorld,
  type OptionValues,
} from "./task-world.ts";

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
  const { refreshOverview, eventWithPost, inThread, newTask, row, tasksOn } =
    world;
  const { today } = world;
  const publicMessage = () => ({
    message: { id: testSnowflake(), flags: SUPPRESS_EMBEDS },
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
      person = testSnowflake(),
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
    const config = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "..", "..", "vercel.json"),
        "utf8",
      ),
    ) as { functions: Record<string, { maxDuration: number }> };
    expect(config.functions["api/interactions.ts"]?.maxDuration).toBe(60);
  });

  it("registers both commands on the real world.router, with a route for each path", () => {
    const names = COMMANDS.map((command) => command.name);
    expect(names).toEqual(expect.arrayContaining(["task", "mytasks"]));
    const keys = ROUTER.routes.map((route) => `${route.surface} ${route.key}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        "command task assign",
        "command task edit",
        "command task delete",
        "command task done",
        "command mytasks",
        "autocomplete task assign",
        "autocomplete task edit",
        "autocomplete task delete",
        "autocomplete task done",
        "component task.done",
        "component task.delete-yes",
      ]),
    );
  });

  describe("/task assign", () => {
    it("takes the event from the post, saves the task, and pings only the assignee", async () => {
      const { eventId, threadId } = await eventWithPost();
      const { client, edits, notices } = fakeClient();
      const person = testSnowflake();
      const actor = testSnowflake();

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

    it("lets the event option win over the post", async () => {
      const here = await eventWithPost();
      const there = await eventWithPost();
      const { client, notices } = fakeClient();

      await run(
        world.router,
        assignPayload(
          { event: there.eventId },
          { member: admin(), ...inThread(here.threadId) },
        ),
        dependenciesFor(world.db(), client),
      );

      expect(await tasksOn(here.eventId)).toHaveLength(0);
      expect(await tasksOn(there.eventId)).toHaveLength(1);
      expect(notices[0]?.channelId).toBe(there.threadId);
    });

    it.each([
      ["a text channel", { channel: { id: "", type: 0 } }],
      ["a thread that is no event's post", { channel: { id: "", type: 11 } }],
    ])("asks an officer to name an event from %s", async (_name, fields) => {
      const { client, edits, notices } = fakeClient();
      const channelId = testSnowflake();

      await run(
        world.router,
        assignPayload(
          {},
          {
            member: officer(),
            channel: { ...fields.channel, id: channelId, parent_id: null },
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
            "Discord's system user",
            (id) => resolvedHuman(id, { system: true }),
            "can't be assigned to bots",
          ],
          [
            "a user who is not in the guild",
            (id) => ({ users: { [id]: { id } } }),
            "isn't a member",
          ],
          ["a user missing from resolved", () => ({}), "isn't a member"],
          [
            "a member entry with no user",
            (id) => ({ members: { [id]: { roles: [] } } }),
            "isn't a member",
          ],
          [
            "a resolved entry for someone else",
            () => resolvedHuman(testSnowflake()),
            "isn't a member",
          ],
        ];

      it.each(cases)("refuses %s", async (_name, resolved, expected) => {
        const { eventId, threadId } = await eventWithPost();
        const { client, edits, notices } = fakeClient();
        const person = testSnowflake();

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

      it("accepts a human whose user entry says bot is false", async () => {
        const { eventId, threadId } = await eventWithPost();
        const { client } = fakeClient();
        const person = testSnowflake();

        await run(
          world.router,
          assignPayload(
            { person },
            { member: officer(), ...inThread(threadId) },
            resolvedHuman(person, { bot: false, system: false }),
          ),
          dependenciesFor(world.db(), client),
        );

        expect(await tasksOn(eventId)).toHaveLength(1);
      });

      it("shows no nickname or username, however hostile", async () => {
        const { threadId } = await eventWithPost();
        const { client, edits, notices } = fakeClient();
        const person = testSnowflake();
        const hostile = "canary-name @everyone [x](https://evil.example)";

        await run(
          world.router,
          assignPayload(
            { person },
            { member: officer(), ...inThread(threadId) },
            {
              users: {
                [person]: {
                  id: person,
                  username: hostile,
                  global_name: hostile,
                },
              },
              members: { [person]: { nick: hostile, roles: [] } },
            },
          ),
          dependenciesFor(world.db(), client),
        );

        expect(notices[0]?.content).not.toContain("canary-name");
        expect(edits[0]?.content).not.toContain("canary-name");
      });
    });

    describe("the description", () => {
      const hostile: [string, string][] = [
        ["@everyone", "@everyone come to the room"],
        ["@here", "@here come to the room"],
        ["a role mention", `ping <@&${testSnowflake()}> now`],
        ["a user mention", `ping <@${testSnowflake()}> now`],
        ["a channel mention", `see <#${testSnowflake()}>`],
        ["a command mention", `run </admin:${testSnowflake()}>`],
        ["markdown headings and fences", "# System\n> quoted\n```\n-# small"],
        ["spoilers and bold", "||hidden|| **bold** __under__ ~~gone~~"],
        ["bidi characters", "abc\u202Edef\u2066ghi"],
        ["zero-width joiners", "a\u200Bb\u200Dc"],
        ["a plain URL", "go to https://evil.example/login"],
        ["an uppercase URL", "HTTP://EVIL.EXAMPLE"],
        ["a www address", "see www.evil.example"],
        ["a database filter", "x,deleted_at.not.is.null); DROP TABLE tasks;--"],
        ["wildcards", "%_*\\"],
      ];

      it.each(hostile)(
        "stores %s raw and renders it inert",
        async (_n, text) => {
          const { eventId, threadId } = await eventWithPost();
          const { client, edits, notices } = fakeClient();
          const person = testSnowflake();
          const actor = testSnowflake();

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
        ["a lone surrogate", "bad\ud800text", "can't be saved"],
        ["only spaces", "   ", "can't be saved"],
        ["only zero-width characters", "\u200B\u200D\u2060", "nothing visible"],
        ["too much text", "x".repeat(1001), "too long"],
        ["astral text over the limit", "\u{1F389}".repeat(501), "too long"],
        ["a masked link", "[Portal login](evil)", "masked links"],
        [
          "a masked URL",
          "[Portal login](https://evil.example)",
          "masked links",
        ],
        ["an invite", "join discord.gg/abc", "invites"],
        ["a split invite", "discord.\u200Bgg/abc", "invites"],
        ["a long invite", "discord.com/invite/abc", "invites"],
        ["another invite host", "dsc.gg/abc", "invites"],
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

      it("takes exactly 1000 characters, and fits the longest escaped text in a message", async () => {
        const { eventId, threadId } = await eventWithPost();
        const { client, notices } = fakeClient();

        await run(
          world.router,
          assignPayload(
            { description: "*".repeat(1000) },
            { member: officer(), ...inThread(threadId) },
          ),
          dependenciesFor(world.db(), client),
        );

        expect(await tasksOn(eventId)).toHaveLength(1);
        expect(notices[0]?.content.length).toBeLessThanOrEqual(2000);
      });
    });

    describe("the due date", () => {
      it.each([
        ["a date in the past", "2000-01-01", "in the past"],
        ["words", "tomorrow", "YYYY-MM-DD"],
        ["a date that does not exist", "2040-02-31", "not a real date"],
        ["a timestamp", "2040-01-01T00:00:00Z", "YYYY-MM-DD"],
        ["infinity", "infinity", "YYYY-MM-DD"],
        ["a very long value", "2".repeat(6000), "YYYY-MM-DD"],
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

      it("accepts today, and reads MM/DD as the next time it comes round", async () => {
        const { eventId, threadId } = await eventWithPost();
        const { client } = fakeClient();
        const dependencies = dependenciesFor(world.db(), client);
        const member = officer();

        await run(
          world.router,
          assignPayload({ due: today() }, { member, ...inThread(threadId) }),
          dependencies,
        );
        const monthDay = `${today().slice(5, 7)}/${today().slice(8)}`;
        await run(
          world.router,
          assignPayload({ due: monthDay }, { member, ...inThread(threadId) }),
          dependencies,
        );

        const dues = (await tasksOn(eventId)).map((task) => task.due_date);
        expect(dues).toEqual([today(), today()]);
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
          expect.stringContaining("closed or deleted"),
          expect.stringContaining("closed or deleted"),
        ]);
        expect(await tasksOn(eventId)).toEqual([]);
        expect(notices).toEqual([]);
      });

      it("refuses when the event closes between the read and the insert", async () => {
        const { eventId, threadId } = await eventWithPost();
        const { client, edits, notices } = fakeClient();

        await run(
          world.router,
          assignPayload({}, { member: officer(), ...inThread(threadId) }),
          world.racing(client, "POST", async () => {
            unwrap(
              await closeEvent(world.db(), { guildId: GUILD_ID, eventId }),
            );
          }),
        );

        expect(edits[0]?.content).toContain("closed or deleted");
        expect(await tasksOn(eventId)).toEqual([]);
        expect(notices).toEqual([]);
      });

      it.each([
        ["a deleted event", "deleted"],
        ["another guild's event", "foreign"],
        ["a value never offered", UNKNOWN_ID],
      ])("gives %s the one refusal, with no write", async (_name, value) => {
        const { eventId } = await eventWithPost();
        const named =
          value === "deleted"
            ? eventId
            : value === "foreign"
              ? world.foreignEventId
              : value;
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

      it.each([
        ["text that is no ID", "not-a-uuid"],
        ["a property name", "__proto__"],
        ["a filter", "x,status.eq.closed"],
        ["a NUL character", "a\u0000b"],
      ])("asks for a choice after %s, with no write", async (_name, value) => {
        const { client, edits, notices } = fakeClient();

        await run(
          world.router,
          assignPayload({ event: value }, { member: officer() }),
          dependenciesFor(world.db(), client),
        );

        expect(edits[0]?.content).toContain("Pick a choice from the list");
        expect(notices).toEqual([]);
        expect(await tasksOn(world.foreignEventId)).toEqual([]);
      });
    });

    it("ignores options named like database parameters", async () => {
      const { eventId, threadId } = await eventWithPost();
      const { client } = fakeClient();
      const person = testSnowflake();
      const actor = testSnowflake();
      const planted = testSnowflake();

      await run(
        world.router,
        subcommand(
          "assign",
          [
            personOption(person),
            ...stringOptions({
              description: "Book the room",
              due: FAR_DUE,
              p_actor_id: planted,
              p_guild_id: world.foreign.guildId,
              guild_id: world.foreign.guildId,
              created_by: planted,
              actor_id: planted,
              assignee_id: planted,
              status: "done",
            }),
          ],
          { member: officer(actor), ...inThread(threadId) },
          resolvedHuman(person),
        ),
        dependenciesFor(world.db(), client),
      );

      const [task] = await tasksOn(eventId);
      expect(task).toMatchObject({ created_by: actor, assignee_id: person });
      expect(await row(task?.id ?? "")).toMatchObject({
        guild_id: GUILD_ID,
        status: "open",
      });
    });

    it("gives a replay one task, one ping and one reply", async () => {
      const { eventId, threadId } = await eventWithPost();
      const { client, edits, notices } = fakeClient();
      const dependencies = dependenciesFor(world.db(), client);
      const payload = assignPayload(
        {},
        { member: officer(), ...inThread(threadId) },
      );

      await run(world.router, payload, dependencies);
      await run(world.router, payload, dependencies);

      expect(await tasksOn(eventId)).toHaveLength(1);
      expect(notices).toHaveLength(1);
      expect(edits).toHaveLength(1);
    });

    it("keeps the task and says so when the post can't be sent to", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { eventId, threadId } = await eventWithPost();
      const { client, edits } = fakeClient({
        sendMessage: () => Promise.reject(new Error("canary discord failure")),
      });
      const person = testSnowflake();

      await run(
        world.router,
        assignPayload({ person }, { member: officer(), ...inThread(threadId) }),
        dependenciesFor(world.db(), client),
      );

      expect(await tasksOn(eventId)).toHaveLength(1);
      const reply = edits[0]?.content ?? "";
      expect(reply).toContain("The task is saved");
      expect(reply).toContain(`<@${person}> was not mentioned`);
      expect(reply).not.toContain("canary");
    });

    it("says the person may not have been mentioned when Discord gives no answer", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { eventId, threadId } = await eventWithPost();
      const { client, edits } = fakeClient({
        sendMessage: () =>
          Promise.reject(
            new DiscordClientError("send message", { kind: "network" }),
          ),
      });
      const person = testSnowflake();

      await run(
        world.router,
        assignPayload({ person }, { member: officer(), ...inThread(threadId) }),
        dependenciesFor(world.db(), client),
      );

      expect(await tasksOn(eventId)).toHaveLength(1);
      expect(edits[0]?.content).toContain(
        `<@${person}> may not have been mentioned`,
      );
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

    it("still answers if the overview can't be redrawn", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      refreshOverview.mockRejectedValue(new Error("canary overview failure"));
      const { eventId, threadId } = await eventWithPost();
      const { client, edits } = fakeClient();

      await run(
        world.router,
        assignPayload({}, { member: officer(), ...inThread(threadId) }),
        dependenciesFor(world.db(), client),
      );

      expect(await tasksOn(eventId)).toHaveLength(1);
      expect(edits[0]?.content).toContain("Assigned task");
    });

    describe("quotas", () => {
      it("states the event limit in the refusal", async () => {
        const { eventId, threadId } = await eventWithPost();
        for (let index = 0; index < MAX_TASKS_PER_EVENT; index += 1) {
          await newTask(eventId, testSnowflake());
        }
        const { client, edits, notices } = fakeClient();

        await run(
          world.router,
          assignPayload({}, { member: officer(), ...inThread(threadId) }),
          dependenciesFor(world.db(), client),
        );

        expect(edits[0]?.content).toContain(String(MAX_TASKS_PER_EVENT));
        expect(edits[0]?.content).toContain("the most one event can hold");
        expect(notices).toEqual([]);
        expect(await tasksOn(eventId)).toHaveLength(MAX_TASKS_PER_EVENT);
      });

      it("states the officer limit in the refusal", async () => {
        const { eventId, threadId } = await eventWithPost();
        const actor = testSnowflake();
        const { client, edits, notices } = fakeClient();
        const dependencies = dependenciesFor(world.db(), client);
        for (let i = 0; i < MAX_TASK_ACTIONS_PER_OFFICER_PER_DAY; i += 1) {
          unwrap(
            await createTask(world.db(), {
              guildId: GUILD_ID,
              eventId,
              assigneeId: testSnowflake(),
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

        expect(edits[0]?.content).toContain(
          String(MAX_TASK_ACTIONS_PER_OFFICER_PER_DAY),
        );
        expect(edits[0]?.content).toContain("the last 24 hours");
        expect(notices).toEqual([]);
      });
    });

    describe("through the real Discord client", () => {
      const ENV = {
        DISCORD_BOT_TOKEN: ["a".repeat(24), "b".repeat(6), "c".repeat(27)].join(
          ".",
        ),
        DISCORD_APP_ID: testSnowflake(),
      };

      function liveWorld(threadId: string, parentId = world.fixture.channelId) {
        const calls: { method: string; path: string; body: unknown }[] = [];
        vi.stubGlobal(
          "fetch",
          (url: string | URL, init?: RequestInit): Promise<Response> => {
            const path = new URL(url).pathname;
            const method = init?.method ?? "GET";
            calls.push({
              method,
              path,
              body:
                typeof init?.body === "string"
                  ? (JSON.parse(init.body) as unknown)
                  : undefined,
            });
            if (method === "GET" && path.endsWith(`/channels/${threadId}`)) {
              return Promise.resolve(
                Response.json({
                  id: threadId,
                  type: 11,
                  guild_id: GUILD_ID,
                  parent_id: parentId,
                }),
              );
            }
            if (method === "GET") {
              return Promise.resolve(
                Response.json({ id: testSnowflake(), flags: EPHEMERAL }),
              );
            }
            return Promise.resolve(Response.json({ id: testSnowflake() }));
          },
        );
        const discord = createDiscordClient({
          check: managedChannelCheck(world.db()),
          env: ENV,
          sleep: () => Promise.resolve(),
        });
        return { calls, dependencies: dependenciesFor(world.db(), discord) };
      }

      afterEach(() => {
        vi.unstubAllGlobals();
      });

      it("posts in a managed forum's thread with a named-user mention only", async () => {
        const { threadId } = await eventWithPost();
        const { calls, dependencies } = liveWorld(threadId);
        const person = testSnowflake();

        await run(
          world.router,
          assignPayload(
            { person, description: "@everyone come" },
            { member: officer(), ...inThread(threadId) },
          ),
          dependencies,
        );

        const post = calls.find((call) => call.method === "POST");
        expect(post?.path).toContain(`/channels/${threadId}/messages`);
        expect(post?.body).toMatchObject({
          allowed_mentions: { parse: [], users: [person] },
          flags: SUPPRESS_EMBEDS,
        });
      });

      it("sends nothing to a forum that has been removed, and keeps the task", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const removedForum = testSnowflake();
        const config = await queryAs<{ version: number }>(
          world.backend.connection,
          "service_role",
          `SELECT version FROM public.guild_config WHERE guild_id = $1`,
          [GUILD_ID],
        );
        const version = config[0]?.version ?? 0;
        await queryAs(
          world.backend.connection,
          "service_role",
          `SELECT public.apply_config_change($1, $2, $3, NULL, ARRAY[$4]::text[])`,
          [GUILD_ID, version, testSnowflake(), removedForum],
        );
        const eventId = await insertEvent(world.backend.connection, {
          ...world.fixture,
          channelId: removedForum,
        });
        const threadId = testSnowflake();
        unwrap(
          await setEventThread(world.db(), {
            guildId: GUILD_ID,
            eventId,
            threadId,
          }),
        );
        await queryAs(
          world.backend.connection,
          "service_role",
          `SELECT public.apply_config_change($1, $2, $3, NULL, NULL, ARRAY[$4]::text[])`,
          [GUILD_ID, version + 1, testSnowflake(), removedForum],
        );
        const { calls, dependencies } = liveWorld(threadId, removedForum);

        await run(
          world.router,
          assignPayload({ event: eventId }, { member: officer() }),
          dependencies,
        );

        expect(calls.filter((call) => call.method === "POST")).toEqual([]);
        expect(await tasksOn(eventId)).toHaveLength(1);
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
      const assignee = testSnowflake();
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
      const task = await newTask(eventId, testSnowflake());
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
      const task = await newTask(eventId, testSnowflake());
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
      const before = testSnowflake();
      const after = testSnowflake();
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

    it("keeps the change and says so when the new assignee can't be told", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, testSnowflake());
      const after = testSnowflake();
      const { client, edits } = fakeClient({
        sendMessage: () => Promise.reject(new Error("canary discord failure")),
      });

      await run(
        world.router,
        editPayload(task.id, {}, { member: officer() }, after),
        dependenciesFor(world.db(), client),
      );

      expect((await row(task.id))?.assignee_id).toBe(after);
      expect(edits[0]?.content).toContain("was not mentioned");
      expect(edits[0]?.content).not.toContain("canary");
    });

    it("stops pinging at the officer's limit, writing nothing and saying why", async () => {
      const { eventId } = await eventWithPost();
      const a = testSnowflake();
      const b = testSnowflake();
      const task = await newTask(eventId, a);
      const actor = testSnowflake();
      const { client, edits, notices } = fakeClient();
      const dependencies = dependenciesFor(world.db(), client);

      for (let i = 0; i < MAX_TASK_ACTIONS_PER_OFFICER_PER_DAY + 3; i += 1) {
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

      expect(notices).toHaveLength(MAX_TASK_ACTIONS_PER_OFFICER_PER_DAY);
      const refusal = edits.at(-1)?.content ?? "";
      expect(refusal).toContain(String(MAX_TASK_ACTIONS_PER_OFFICER_PER_DAY));
      expect(refusal).toContain("nothing was saved");
      // The rounds alternate, so every second one past the limit left the person alone,
      // which pings nobody and still saves. The last, a change of person, saved nothing.
      expect(await row(task.id)).toMatchObject({
        assignee_id: a,
        description: `Round ${String(MAX_TASK_ACTIONS_PER_OFFICER_PER_DAY + 1)}`,
      });
    });

    it("does not count an edit that leaves the person alone", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, testSnowflake());
      const actor = testSnowflake();
      const { client } = fakeClient();

      await run(
        world.router,
        editPayload(
          task.id,
          { description: "New" },
          { member: officer(actor) },
        ),
        dependenciesFor(world.db(), client),
      );

      const { rows } = await world.backend.connection.query(
        `SELECT 1 FROM public.task_reassignments WHERE actor_id = $1`,
        [actor],
      );
      expect(rows).toEqual([]);
    });

    it("says the event is closed when it closes between the read and the write", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, testSnowflake());
      const { client, edits, notices } = fakeClient();

      await run(
        world.router,
        editPayload(
          task.id,
          { description: "New" },
          { member: officer() },
          testSnowflake(),
        ),
        world.racing(client, "PATCH", async () => {
          unwrap(await closeEvent(world.db(), { guildId: GUILD_ID, eventId }));
        }),
      );

      expect(edits[0]?.content).toContain("closed or deleted");
      expect(notices).toEqual([]);
      expect((await row(task.id))?.assignee_id).toBe(task.assignee_id);
    });

    it("refuses a stale edit, keeping the other person's change", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, testSnowflake());
      const { client, edits, notices } = fakeClient();

      await run(
        world.router,
        editPayload(
          task.id,
          { description: "Written later" },
          { member: officer() },
          testSnowflake(),
        ),
        world.racing(client, "PATCH", async () => {
          unwrap(
            await editTask(world.db(), {
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

    it.each([
      ["a bad date", { description: "Changed", due: "not a date" }],
      ["a past date", { description: "Changed", due: "2000-01-01" }],
      ["a masked link", { description: "See [this](https://evil.example)" }],
      ["a blank description", { description: "   " }],
    ] as [string, OptionValues][])(
      "writes nothing at all given %s",
      async (_name, values) => {
        const { eventId } = await eventWithPost();
        const task = await newTask(eventId, testSnowflake());
        const { client, edits } = fakeClient();

        await run(
          world.router,
          editPayload(task.id, values, { member: officer() }),
          dependenciesFor(world.db(), client),
        );

        expect(await row(task.id)).toMatchObject({
          description: "Book the room",
          due_date: FAR_DUE,
        });
        expect(edits[0]?.content).toBeTruthy();
        expect(edits[0]?.content).not.toContain("Saved");
      },
    );

    it.each([
      ["a bot", (id: string) => resolvedHuman(id, { bot: true })],
      ["a non-member", (id: string) => ({ users: { [id]: { id } } })],
    ])("refuses %s as the new person", async (_name, resolved) => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, testSnowflake());
      const { client, notices } = fakeClient();
      const person = testSnowflake();

      await run(
        world.router,
        editPayload(
          task.id,
          { description: "Changed" },
          { member: officer() },
          person,
          resolved(person),
        ),
        dependenciesFor(world.db(), client),
      );

      expect(await row(task.id)).toMatchObject({
        assignee_id: task.assignee_id,
        description: "Book the room",
      });
      expect(notices).toEqual([]);
    });

    it("says so when an edit changes nothing", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, testSnowflake());
      const { client, edits, notices } = fakeClient();
      const dependencies = dependenciesFor(world.db(), client);

      await run(
        world.router,
        editPayload(task.id, {}, { member: officer() }),
        dependencies,
      );
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

      expect(edits.map((edit) => edit.content)).toEqual([
        expect.stringContaining("changes nothing"),
        expect.stringContaining("changes nothing"),
      ]);
      expect(notices).toEqual([]);
    });

    it("refuses a task that is done, or on a closed event", async () => {
      const done = await eventWithPost();
      const doneTask = await newTask(done.eventId, testSnowflake());
      const closed = await eventWithPost();
      const closedTask = await newTask(closed.eventId, testSnowflake());
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

    it.each([
      ["another guild's task", "foreign"],
      ["a deleted task", "deleted"],
      ["a value never offered", UNKNOWN_ID],
    ])("gives %s the one refusal", async (_name, value) => {
      const { eventId } = await eventWithPost();
      let taskId = value;
      if (value === "foreign") {
        const rows = await queryAs<{ id: string }>(
          world.backend.connection,
          "service_role",
          `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
           VALUES ($1, $2, $3, 'Foreign', '2040-01-01', $3) RETURNING id`,
          [world.foreignEventId, world.foreign.guildId, testSnowflake()],
        );
        taskId = rows[0]?.id ?? "";
      } else if (value === "deleted") {
        const task = await newTask(eventId, testSnowflake());
        unwrap(
          await softDeleteTask(world.db(), {
            guildId: GUILD_ID,
            taskId: task.id,
            now: new Date(),
          }),
        );
        taskId = task.id;
      }
      const { client, edits } = fakeClient();

      const ran = await run(
        world.router,
        editPayload(taskId, { description: "Changed" }, { member: officer() }),
        dependenciesFor(world.db(), client),
      );

      expect(refusedWith(ran, edits)).toBe(FIXED_REFUSAL);
    });

    it("gives a replay one ping", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, testSnowflake());
      const { client, edits, notices } = fakeClient();
      const dependencies = dependenciesFor(world.db(), client);
      const payload = editPayload(
        task.id,
        {},
        { member: officer() },
        testSnowflake(),
      );

      await run(world.router, payload, dependencies);
      await run(world.router, payload, dependencies);

      expect(notices).toHaveLength(1);
      expect(edits).toHaveLength(1);
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
      const task = await newTask(eventId, testSnowflake());

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
      const assignee = testSnowflake();
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

    it("checks Confirm from its own payload, so a lost role counts", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, testSnowflake());
      const actor = testSnowflake();
      const { client, edits } = fakeClient();

      const ran = await run(
        world.router,
        componentPayload(confirmId(task), {
          member: plainMember(actor),
        }),
        dependenciesFor(world.db(), client),
      );

      expect(ran.reply.data?.content).toBe(FIXED_REFUSAL);
      expect(edits).toEqual([]);
      expect((await row(task.id))?.deleted).toBe(false);
    });

    it("refuses a Confirm for a task edited since it was shown, and keeps the task", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, testSnowflake());
      const stale = confirmId(task);
      await new Promise((resolve) => setTimeout(resolve, 5));
      unwrap(
        await editTask(world.db(), {
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

    it("refuses when the task is edited between the read and the delete", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, testSnowflake());
      const { client, edits } = fakeClient();

      await run(
        world.router,
        componentPayload(confirmId(task), { member: officer() }),
        world.racing(client, "PATCH", async () => {
          unwrap(
            await editTask(world.db(), {
              guildId: GUILD_ID,
              taskId: task.id,
              expectedUpdatedAt: task.updated_at,
              description: "Pay the deposit",
              dueDate: task.due_date,
              assigneeId: task.assignee_id,
            }),
          );
        }),
      );

      expect(edits[0]?.content).toContain("changed after this was shown");
      expect((await row(task.id))?.deleted).toBe(false);
    });

    it.each([
      ["no fingerprint", (id: string) => `task.delete-yes:${id}`],
      ["a bad fingerprint", (id: string) => `task.delete-yes:${id}:xyz`],
    ])("refuses a Confirm with %s", async (_name, build) => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, testSnowflake());
      const { client } = fakeClient();

      const ran = await run(
        world.router,
        componentPayload(build(task.id), { member: officer() }),
        dependenciesFor(world.db(), client),
      );

      expect(ran.reply.data?.content).toBe(FIXED_REFUSAL);
      expect((await row(task.id))?.deleted).toBe(false);
    });

    it("does not let the assignee Confirm their own task's delete", async () => {
      const { eventId } = await eventWithPost();
      const assignee = testSnowflake();
      const task = await newTask(eventId, assignee);
      const { client } = fakeClient();

      const ran = await run(
        world.router,
        componentPayload(confirmId(task), {
          member: plainMember(assignee),
        }),
        dependenciesFor(world.db(), client),
      );

      expect(ran.reply.data?.content).toBe(FIXED_REFUSAL);
      expect((await row(task.id))?.deleted).toBe(false);
    });

    it("refuses a Confirm on a message others can see", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, testSnowflake());
      const { client } = fakeClient();

      const ran = await run(
        world.router,
        componentPayload(confirmId(task), {
          member: officer(),
          message: { id: testSnowflake(), flags: 0 },
        }),
        dependenciesFor(world.db(), client),
      );

      expect(ran.reply.data?.content).toBe(FIXED_REFUSAL);
      expect((await row(task.id))?.deleted).toBe(false);
    });

    it("gives a second Confirm and a replay the same quiet result", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, testSnowflake());
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
        expect.stringContaining("Deleted"),
        FIXED_REFUSAL,
      ]);
    });

    it("refuses another guild's task named in a crafted Confirm", async () => {
      const rows = await queryAs<{ id: string }>(
        world.backend.connection,
        "service_role",
        `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
         VALUES ($1, $2, $3, 'Foreign', '2040-01-01', $3) RETURNING id`,
        [world.foreignEventId, world.foreign.guildId, testSnowflake()],
      );
      const { client, edits } = fakeClient();

      const ran = await run(
        world.router,
        componentPayload(
          `task.delete-yes:${rows[0]?.id ?? ""}:${"0".repeat(16)}`,
          {
            member: officer(),
          },
        ),
        dependenciesFor(world.db(), client),
      );

      expect(refusedWith(ran, edits)).toBe(FIXED_REFUSAL);
      expect((await row(rows[0]?.id ?? ""))?.deleted).toBe(false);
    });

    it("refuses on a closed event at both steps", async () => {
      const { eventId } = await eventWithPost();
      const task = await newTask(eventId, testSnowflake());
      unwrap(await closeEvent(world.db(), { guildId: GUILD_ID, eventId }));
      const { client, edits } = fakeClient();
      const dependencies = dependenciesFor(world.db(), client);

      await run(
        world.router,
        deletePayload(task.id, { member: officer() }),
        dependencies,
      );
      await run(
        world.router,
        componentPayload(confirmId(task), { member: officer() }),
        dependencies,
      );

      expect(edits.map((edit) => edit.content)).toEqual([
        expect.stringContaining("closed or deleted"),
        expect.stringContaining("closed or deleted"),
      ]);
      expect((await row(task.id))?.deleted).toBe(false);
    });
  });

  it("works from the button that /task assign posted", async () => {
    const { eventId, threadId } = await eventWithPost();
    const person = testSnowflake();
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
      const me = testSnowflake();
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
    const task = await newTask(eventId, testSnowflake(), "Officerpick thing");

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
