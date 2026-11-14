/**
 * What an officer is told after a task change: whether the person was mentioned, whether
 * they can reach the post, and whether the post itself is still right.
 */

import { PermissionFlagsBits } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { DiscordClientError } from "../../src/discord/client.ts";
import type {
  DiscordClient,
  DiscordFailure,
  GuildRole,
  PermissionOverwrite,
} from "../../src/discord/client.ts";
import { setEventThread } from "../../src/db/events.ts";
import { createRouter } from "../../src/handlers/router.ts";
import { handler as eventHandler } from "../../src/handlers/event.ts";
import {
  commandPayload,
  dependenciesFor,
  GUILD_ID,
  run,
} from "../support/interactions.ts";
import { fakeId } from "../support/ids.ts";
import { insertEvent } from "./fixtures.ts";
import { queryAs } from "./harness.ts";
import {
  FAR_DUE,
  fakeClient,
  OPTION,
  officer,
  pickerPayload,
  plainMember,
  stringOptions,
  subcommand,
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

  beforeEach(() => {
    spyOn(console, "error").mockImplementation(() => undefined);
  });

  describe("when the notice's send fails", () => {
    async function replyAfter(failure: DiscordFailure) {
      const { threadId } = await eventWithPost();
      const { client, edits } = fakeClient({
        sendMessage: () =>
          Promise.reject(new DiscordClientError("send message", failure)),
      });
      const person = fakeId();
      await run(
        world.router,
        assignPayload(person, { member: officer(), ...inThread(threadId) }),
        dependenciesFor(world.db(), client),
      );
      return { reply: edits[0]?.content ?? "", person };
    }

    it.each<[string, DiscordFailure, string]>([
      ["no answer", { kind: "network" }, "may not have been mentioned"],
      [
        "a refusal",
        { kind: "api", status: 400, code: 160005 },
        "was not mentioned",
      ],
    ])("says what happened after %s", async (_label, failure, text) => {
      const { reply, person } = await replyAfter(failure);

      expect(reply).toContain(`<@${person}> ${text}`);
    });
  });

  describe("the person's access to the forum", () => {
    const VIEW = PermissionFlagsBits.ViewChannel;
    const MEMBER_ROLE = fakeId();

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
        getGuildChannel: (_guildId, channelId) =>
          channelId === world.fixture.channelId
            ? Promise.resolve({
                id: world.fixture.channelId,
                name: "forum",
                type: 15,
                overwrites: [
                  { id: GUILD_ID, type: 0, allow: 0n, deny: VIEW },
                  { id: MEMBER_ROLE, type: 0, allow: VIEW, deny: 0n },
                  ...extra,
                ],
              })
            : Promise.reject(new Error("not this forum")),
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
      const person = fakeId();
      const { client, edits, notices } = privateForum();

      await assigned(client, person);

      const reply = edits[0]?.content ?? "";
      expect(reply).toContain(`<@${person}> was mentioned`);
      expect(reply).toContain(`<@${person}> can't view this event's forum`);
      expect(reply).toContain("/mytasks");
      expect(notices).toHaveLength(1);
    });

    it("warns the officer when someone is put on an event step", async () => {
      const person = fakeId();
      const { eventId } = await eventWithPost();
      const { client, edits } = privateForum();

      await run(
        createRouter([eventHandler]),
        commandPayload(
          "event",
          { member: officer() },
          {
            options: [
              {
                name: "assign",
                type: OPTION.subcommand,
                options: [
                  ...stringOptions({ step: "budget_sheet", event: eventId }),
                  { name: "user", type: OPTION.user, value: person },
                ],
              },
            ],
            resolved: resolvedHuman(person),
          },
        ),
        dependenciesFor(world.db(), client),
      );

      const reply = edits[0]?.content ?? "";
      expect(reply).toContain(`Put <@${person}> on Budget Sheet`);
      expect(reply).toContain(`<@${person}> can't view this event's forum`);
      expect(reply).toContain("see the step in /mytasks");
    });
  });

  describe("under a removed forum", () => {
    it("keeps the task and says reminders are off until the forum is back", async () => {
      const removedForum = fakeId();
      const version = async () => {
        const rows = await queryAs<{ version: number }>(
          world.backend.connection,
          "bot_app",
          `SELECT version FROM public.guild_config WHERE guild_id = $1`,
          [GUILD_ID],
        );
        return rows[0]?.version ?? 0;
      };
      await queryAs(
        world.backend.connection,
        "bot_app",
        `SELECT public.apply_config_change($1, $2, $3, NULL, ARRAY[$4]::text[])`,
        [GUILD_ID, await version(), fakeId(), removedForum],
      );
      const eventId = await insertEvent(world.backend.connection, {
        ...world.fixture,
        channelId: removedForum,
      });
      unwrap(
        await setEventThread(world.db(), {
          guildId: GUILD_ID,
          eventId,
          threadId: fakeId(),
        }),
      );
      await queryAs(
        world.backend.connection,
        "bot_app",
        `SELECT public.apply_config_change($1, $2, $3, NULL, NULL, ARRAY[$4]::text[])`,
        [GUILD_ID, await version(), fakeId(), removedForum],
      );
      const person = fakeId();
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
  });

  describe("when the overview can't be updated", () => {
    const NOT_UPDATED = "couldn't update the task list in the event's post";

    it("says so after /task assign, and when the refresh throws", async () => {
      world.refreshOverview.mockRejectedValue(new Error("overview failure"));
      const { threadId } = await eventWithPost();
      const { client, edits } = fakeClient();

      await run(
        world.router,
        assignPayload(fakeId(), {
          member: officer(),
          ...inThread(threadId),
        }),
        dependenciesFor(world.db(), client),
      );

      expect(edits[0]?.content).toContain("Assigned task");
      expect(edits[0]?.content).toContain(NOT_UPDATED);
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
      const assignee = fakeId();
      const { eventId } = await eventWithPost();
      const task = await world.newTask(eventId, assignee);

      const reply = await doneTyped(shortId(task.id), plainMember(assignee));

      expect(reply).toContain("Marked done");
      expect((await world.row(task.id))?.status).toBe("done");
    });

    it("does not reach someone else's task, or say it exists", async () => {
      const { eventId } = await eventWithPost();
      const task = await world.newTask(eventId, fakeId());

      const reply = await doneTyped(shortId(task.id), plainMember());

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
          [id, eventId, GUILD_ID, fakeId(), FAR_DUE, fakeId()],
        );
      }

      const reply = await doneTyped(shared, officer());

      expect(reply).toContain(PICK);
      for (const id of ids) {
        expect((await world.row(id))?.status).toBe("open");
      }
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
      const task = await world.newTask(eventId, fakeId(), description);
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
      const open = await world.newTask(eventId, fakeId(), "Deletetest waiting");

      const found = await pick("Deletetest");

      expect(found.map((choice) => choice.value)).toEqual([open.id, done.id]);
      expect(found[1]?.name).toContain("done, due");
      expect(found[0]?.name).not.toContain("done,");
    });
  });
});
