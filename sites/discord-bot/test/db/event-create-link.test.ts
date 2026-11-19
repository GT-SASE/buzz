import { describe, expect, it } from "bun:test";
import {
  eventCommand,
  eventWorld,
  FUTURE,
  inThread,
  OTHER_GUILD,
} from "../support/event-world.ts";
import { HOSTILE_TEXT, INVISIBLE_TEXT } from "../support/hostile-text.ts";
import {
  ADMIN_ROLE,
  GUILD_ID,
  MEMBER_ID,
  OFFICER,
  OFFICER_ROLE,
  PLAIN_MEMBER,
} from "../support/interactions.ts";
import {
  MISSING_ACCESS,
  type Failure,
  type SentRequest,
} from "../support/discord-server.ts";
import { fakeId } from "../support/ids.ts";
import { REFUSED } from "../../src/lib/permissions.ts";
import { containsInviteOrMaskedLink } from "../../src/discord/safe-text.ts";

const world = eventWorld();
// Invites and masked links are refused outright; everything else is stored inert.
const LINKING_TEXT = HOSTILE_TEXT.filter(([, text]) =>
  containsInviteOrMaskedLink(text),
);
const INERT_NAME = /[@<>#[\]`|*_~:/\\.\n\r]/u;

const THREADS_POST = /^\/channels\/[0-9]+\/threads$/;
const FORBIDDEN: Failure = {
  kind: "respond",
  status: 403,
  code: MISSING_ACCESS,
};
const officerFields = { member: OFFICER };

function threadsMade() {
  return [...world.discord.channels.values()].filter(
    (channel) => channel.type === 11,
  );
}

function create(
  options: Record<string, string | { type: number; value: unknown }> = {},
  fields: Record<string, unknown> = officerFields,
) {
  return eventCommand(
    "create",
    { name: "Fall Social", date: FUTURE, ...options },
    fields,
  );
}

function forumOption(id: unknown) {
  return { type: 7, value: id };
}

/** Asserts nothing was stored or posted, and the reply says why. */
async function refusedWith(reply: string) {
  expect(await world.events()).toEqual([]);
  expect(world.discord.publicWrites()).toEqual([]);
  expect(world.discord.lastReply()).toContain(reply);
}

describe("/event create", () => {
  it("makes one active row and one post, and joins them", async () => {
    const forum = await world.addManagedForum();

    const ran = await world.send(create());

    expect(ran.reply).toEqual({ type: 5, data: { flags: 64 } });
    expect(ran.deferred).toBe(true);
    const [event, ...others] = await world.events();
    expect(others).toEqual([]);
    const [post, ...otherPosts] = world.discord.posts();
    expect(otherPosts).toEqual([]);
    expect(post?.path).toBe(`/channels/${forum}/threads`);
    expect(post?.body?.name).toBe("Fall Social");
    expect(event).toMatchObject({
      guild_id: GUILD_ID,
      channel_id: forum,
      name: "Fall Social",
      event_date: FUTURE,
      status: "active",
      thread_status: "active",
      created_by: MEMBER_ID,
    });
    expect(world.discord.channels.get(event?.thread_id ?? "")?.parent_id).toBe(
      forum,
    );
    expect(event?.overview_message_id).toBe(event?.thread_id);
    expect(world.discord.lastReply()).toContain("Created **Fall Social**");
    // The first post says who created it, with no ping.
    const message = post?.body?.message as Record<string, unknown>;
    expect(message.content).toContain(`Created by <@${MEMBER_ID}>`);
    expect(message.allowed_mentions).toEqual({ parse: [], users: [] });
  });

  it("makes one row and one post from a replayed request", async () => {
    await world.addManagedForum();
    const payload = create();

    await world.send(payload);
    await world.send(payload);

    expect(await world.events()).toHaveLength(1);
    expect(world.discord.posts()).toHaveLength(1);
  });

  describe("choosing a forum", () => {
    it("takes a named forum when several are managed, and refuses to guess", async () => {
      await world.addManagedForum();
      const chosen = await world.addManagedForum();

      await world.send(create());
      await refusedWith("choose one");

      await world.send(create({ forum: forumOption(chosen) }));
      expect((await world.events())[0]?.channel_id).toBe(chosen);
    });

    it("explains when no forum is managed", async () => {
      await world.send(create());

      await refusedWith("No forums are managed");
    });

    it.each([
      ["an unmanaged channel", () => Promise.resolve(fakeId())],
      [
        "another guild's managed forum",
        () => world.addManagedForum(OTHER_GUILD),
      ],
    ])("refuses %s", async (_label, id) => {
      await world.addManagedForum();

      await world.send(create({ forum: forumOption(await id()) }));

      await refusedWith("isn't managed");
    });
  });

  describe("names and dates", () => {
    it.each(LINKING_TEXT)(
      "refuses a name with an invite or masked link: %s",
      async (_label, name) => {
        await world.addManagedForum();

        await world.send(create({ name }));

        await refusedWith("can't hold a server invite or a masked link");
      },
    );

    it("stores and posts a tidied name, and says it was changed", async () => {
      await world.addManagedForum();

      await world.send(create({ name: "@everyone party **now**" }));

      const [event] = await world.events();
      expect(event?.name).toBe("everyone party now");
      expect(world.discord.posts()[0]?.body?.name).toBe(event?.name);
      expect(world.discord.lastReply()).toContain("tidied");
    });

    it.each([
      INVISIBLE_TEXT[0] ?? ["", ""],
      ["too long", "x".repeat(101)],
    ] as const)("refuses %s before any write or send", async (_label, name) => {
      await world.addManagedForum();

      await world.send(create({ name }));

      await refusedWith("can't be used");
    });

    it.each([
      ["2000-01-02", "passed"],
      ["2099-02-30", "isn't valid"],
    ])("refuses the date %j before any write or send", async (date, reply) => {
      await world.addManagedForum();

      await world.send(create({ date }));

      await refusedWith(reply);
    });
  });

  it("refuses an event that already exists there, and points at its post", async () => {
    await world.addManagedForum();
    await world.send(create());
    const [event] = await world.events();

    await world.send(create());

    expect(await world.events()).toHaveLength(1);
    expect(world.discord.posts()).toHaveLength(1);
    expect(world.discord.lastReply()).toContain(`<#${event?.thread_id ?? ""}>`);
  });

  it("refuses a member who is not an officer, with nothing written or sent", async () => {
    await world.addManagedForum();

    const ran = await world.send(create({}, { member: PLAIN_MEMBER }));

    expect(ran.reply.data?.content).toBe(REFUSED.message);
    expect(ran.deferred).toBe(false);
    expect(await world.events()).toEqual([]);
    expect(world.discord.requests).toEqual([]);
  });

  it("refuses everything before setup, even for an officer's roles", async () => {
    const replica = "SET session_replication_role = replica";
    await world.pg.exec(
      `${replica}; DELETE FROM public.guild_config WHERE officer_role_id = '${OFFICER_ROLE}'; RESET session_replication_role`,
    );
    try {
      const ran = await world.send(create());

      expect(ran.reply.data?.content).toBe(REFUSED.message);
      expect(await world.events()).toEqual([]);
    } finally {
      await world.pg.exec(
        `${replica}; INSERT INTO public.guild_config (guild_id, officer_role_id, admin_role_id, version) VALUES ('${GUILD_ID}', '${OFFICER_ROLE}', '${ADMIN_ROLE}', 1); RESET session_replication_role`,
      );
    }
  });

  describe("when Discord fails", () => {
    it("keeps a pending row and no post, and recovers it when run again", async () => {
      await world.addManagedForum();
      world.discord.fail("POST", THREADS_POST, FORBIDDEN, 1);

      await world.send(create());

      expect((await world.events())[0]).toMatchObject({
        thread_status: "pending",
        thread_id: null,
        overview_message_id: null,
      });
      expect(world.discord.lastReply()).toContain("/event create");
      expect(world.discord.lastReply()).toContain("/event delete");

      await world.send(create());

      const [event, ...others] = await world.events();
      expect(others).toEqual([]);
      expect(event?.thread_status).toBe("active");
      expect(world.discord.lastReply()).toContain("Created");
    });

    it("keeps the row pending and points at /event link when the post is unconfirmed", async () => {
      const forum = await world.addManagedForum();
      world.discord.fail("POST", THREADS_POST, { kind: "lost" }, 1);

      await world.send(create());

      expect((await world.events())[0]?.thread_status).toBe("pending");
      expect(world.discord.lastReply()).toBe(
        `Discord didn't confirm the post, so it may have been made. If **Fall Social** is in <#${forum}>, run /event link inside it and choose this event. If it isn't, make the post yourself in <#${forum}> and run /event link inside it.`,
      );
    });

    it("makes no second post when run again after an unconfirmed post", async () => {
      const forum = await world.addManagedForum();
      world.discord.fail("POST", THREADS_POST, { kind: "lost" }, 1);
      await world.send(create());
      const before = world.discord.posts().length;

      await world.send(create());

      expect(world.discord.posts()).toHaveLength(before);
      expect(threadsMade()).toHaveLength(1);
      expect((await world.events())[0]?.thread_status).toBe("pending");
      expect(world.discord.lastReply()).toBe(
        `A post for **Fall Social** may already exist in <#${forum}>. Run /event link inside it and choose this event. If there is none, make the post yourself and run /event link there.`,
      );
    });
  });

  describe("when the database fails", () => {
    it("names and logs a post it can't save, and /event link in it attaches it", async () => {
      const forum = await world.addManagedForum();
      world.failDb(/^SQL update events/, 500, 1);

      await world.send(create());

      const [pending] = await world.events();
      const threadId = threadsMade()[0]?.id ?? "";
      expect(pending?.thread_status).toBe("pending");
      expect(world.discord.lastReply()).toContain(`<#${threadId}>`);
      expect(world.discord.lastReply()).toContain("/event link");
      const logged = JSON.stringify(world.errors.mock.calls);
      expect(logged).toContain(threadId);
      expect(logged).not.toContain("Fall Social");

      await world.send(
        eventCommand(
          "link",
          { date: FUTURE },
          { ...officerFields, ...inThread(threadId, forum) },
        ),
      );

      const [event, ...others] = await world.events();
      expect(others).toEqual([]);
      expect(event).toMatchObject({
        id: pending?.id,
        thread_id: threadId,
        overview_message_id: threadId,
        thread_status: "active",
      });
      // Its first post is already the overview, so there is no second one.
      expect(world.discord.posts()).toHaveLength(1);
    });
  });
});

describe("/event link", () => {
  async function post(name: unknown = "A Post", forum?: string) {
    const parent = forum ?? (await world.addManagedForum());
    const threadId = world.discord.addThread({
      guild_id: GUILD_ID,
      parent_id: parent,
      name: name as string,
      owner_id: fakeId(),
    });
    return { parent, threadId };
  }

  function link(
    threadId: string,
    parent: string,
    fields: Record<string, unknown> = officerFields,
    date = FUTURE,
  ) {
    return eventCommand(
      "link",
      { date },
      { ...fields, ...inThread(threadId, parent) },
    );
  }

  it("adopts the post, names the event after it and posts an overview", async () => {
    const { parent, threadId } = await post("Spring Gala");

    await world.send(link(threadId, parent));

    const [event, ...others] = await world.events();
    expect(others).toEqual([]);
    const [overview, ...otherPosts] = world.discord.posts();
    expect(otherPosts).toEqual([]);
    expect(overview?.path).toBe(`/channels/${threadId}/messages`);
    expect(overview?.body?.content).toContain("**Spring Gala**");
    expect(overview?.body?.content).toContain(`Created by <@${MEMBER_ID}>`);
    expect(event).toMatchObject({
      channel_id: parent,
      name: "Spring Gala",
      event_date: FUTURE,
      thread_id: threadId,
      thread_status: "active",
      status: "active",
      created_by: MEMBER_ID,
    });
    expect(world.discord.messageIds.has(event?.overview_message_id ?? "")).toBe(
      true,
    );
    expect(world.discord.lastReply()).toContain("Linked this post");
  });

  it("makes one row and one overview from a replayed request", async () => {
    const { parent, threadId } = await post();
    const payload = link(threadId, parent);

    await world.send(payload);
    await world.send(payload);

    expect(await world.events()).toHaveLength(1);
    expect(world.discord.posts()).toHaveLength(1);
  });

  it("names the event inertly from a hostile title", async () => {
    const { parent, threadId } = await post("<@&1> **Official** @everyone");

    await world.send(link(threadId, parent));

    expect((await world.events())[0]?.name).not.toMatch(INERT_NAME);
    expect(JSON.stringify(world.discord.posts())).not.toContain("<@&");
  });

  it.each([
    ["no title", null],
    ["only punctuation", "@#/:"],
  ] as const)("refuses a post titled with %s", async (_label, title) => {
    const { parent, threadId } = await post(title);

    await world.send(link(threadId, parent));

    await refusedWith("title");
  });

  describe("what it refuses", () => {
    function thread(guildId: string, parentId: string): string {
      return world.discord.addThread({
        guild_id: guildId,
        parent_id: parentId,
        name: "Odd post",
      });
    }

    // Every case is a channel the bot must not adopt, whatever the payload claims.
    it.each<[string, () => Promise<unknown>]>([
      [
        "a forum itself",
        async () =>
          eventCommand(
            "link",
            { date: FUTURE },
            {
              ...officerFields,
              channel: { id: await world.addManagedForum(), type: 15 },
            },
          ),
      ],
      [
        "a thread whose payload claims a managed parent Discord denies",
        async () => {
          const managed = await world.addManagedForum();
          const unmanaged = world.discord.addForum(GUILD_ID);
          return link(thread(GUILD_ID, unmanaged), managed);
        },
      ],
      [
        "another guild's thread",
        async () => {
          const managed = await world.addManagedForum();
          const foreign = await world.addManagedForum(OTHER_GUILD);
          return link(thread(OTHER_GUILD, foreign), managed);
        },
      ],
      [
        "a post in a removed forum",
        async () => {
          const forum = await world.addManagedForum(GUILD_ID, "removed");
          return link((await post("In old forum", forum)).threadId, forum);
        },
      ],
    ])("%s", async (_label, payload) => {
      await world.send(await payload());

      await refusedWith("Run this inside");
    });
  });

  it("refuses a post already held by an event", async () => {
    const { parent, threadId } = await post();
    await world.send(link(threadId, parent));

    await world.send(link(threadId, parent));

    expect(await world.events()).toHaveLength(1);
    expect(world.discord.posts()).toHaveLength(1);
    expect(world.discord.lastReply()).toContain("already belongs");
  });

  it("posts its own overview, with its tasks, when a pending event adopts someone else's post", async () => {
    const forum = await world.addManagedForum();
    world.discord.fail("POST", THREADS_POST, FORBIDDEN, 1);
    await world.send(create({ name: "A Post" }));
    const [pending] = await world.events();
    await world.insertTask(pending?.id ?? "");
    const { threadId } = await post("A Post", forum);

    await world.send(link(threadId, forum));

    const [event, ...others] = await world.events();
    expect(others).toEqual([]);
    expect(event?.id).toBe(pending?.id);
    expect(event?.thread_id).toBe(threadId);
    // The post's first message is that person's, so the bot could never edit it.
    expect(event?.overview_message_id).not.toBe(threadId);
    const shown = world.discord.requests
      .map((request) => request.body?.content)
      .filter((content) => typeof content === "string")
      .filter((content) => content.includes("Status:"));
    expect(shown.at(-1)).toContain("Book the room");
  });

  it("refuses a member who is not an officer, with nothing written or sent", async () => {
    const { parent, threadId } = await post();

    const ran = await world.send(
      link(threadId, parent, { member: PLAIN_MEMBER }),
    );

    expect(ran.reply.data?.content).toBe(REFUSED.message);
    expect(await world.events()).toEqual([]);
    expect(world.discord.requests).toEqual([]);
  });
});

describe("an event whose post was deleted", () => {
  /** An event with one task, in the state the first send to a deleted post leaves it. */
  async function lostEvent() {
    const forum = await world.addManagedForum();
    await world.send(create());
    const [event] = await world.events();
    const id = event?.id ?? "";
    await world.insertTask(id);
    // Gone from what Discord lists for the forum, as a deleted post is.
    Object.assign(world.discord.channels.get(event?.thread_id ?? "") ?? {}, {
      parent_id: fakeId(),
    });
    await world.pg.query(
      `UPDATE public.events SET thread_status = 'missing' WHERE id = $1`,
      [id],
    );
    const before = world.discord.requests.length;
    return {
      forum,
      id,
      oldThread: event?.thread_id,
      sent: () => world.discord.requests.slice(before),
    };
  }

  function memberPost(forum: string, name = "Fall Social") {
    return world.discord.addThread({
      guild_id: GUILD_ID,
      parent_id: forum,
      name,
      owner_id: fakeId(),
    });
  }

  function linkIn(
    threadId: string,
    forum: string,
    options: Record<string, { type: number; value: unknown }> = {
      date: { type: 3, value: FUTURE },
    },
  ) {
    return eventCommand("link", options, {
      ...officerFields,
      ...inThread(threadId, forum),
    });
  }

  const chosen = (eventId: unknown) => ({ event: { type: 3, value: eventId } });

  function lastOverview(sent: readonly SentRequest[]) {
    return sent
      .flatMap(({ body }) => {
        const message = (body?.message ?? body) as
          Record<string, unknown> | undefined;
        const content = message?.content;
        return typeof content === "string" && content.includes("Status:")
          ? [content]
          : [];
      })
      .at(-1);
  }

  it("gets a new post on the same row from /event create, showing its tasks", async () => {
    const { id, oldThread, sent } = await lostEvent();

    await world.send(create());

    const [event, ...others] = await world.events();
    expect(others).toEqual([]);
    expect(event?.id).toBe(id);
    expect(event?.thread_status).toBe("active");
    expect(event?.thread_id).not.toBe(oldThread);
    expect(lastOverview(sent())).toContain("Book the room");
    expect(world.discord.lastReply()).toContain("had lost its post");
    expect(world.discord.lastReply()).toContain("reminders start again");
  });

  it("keeps the row and its tasks when the new post is refused or unconfirmed", async () => {
    const { forum, id } = await lostEvent();
    world.discord.fail("POST", THREADS_POST, FORBIDDEN, 1);

    await world.send(create());
    expect(world.discord.lastReply()).toContain("tasks are kept");

    world.discord.fail("POST", THREADS_POST, { kind: "lost" }, 1);
    await world.send(create());

    const [event, ...others] = await world.events();
    expect(others).toEqual([]);
    expect(event).toMatchObject({ id, thread_status: "missing" });
    expect(world.discord.lastReply()).toBe(
      `Discord didn't confirm the post, so it may have been made. The event and its tasks are kept. If **Fall Social** is in <#${forum}>, run /event link inside it and choose this event. If it isn't, make the post yourself in <#${forum}> and run /event link inside it.`,
    );
  });

  it("moves to someone else's post of the same title, with its tasks in a new overview", async () => {
    const { forum, id, sent } = await lostEvent();
    const threadId = memberPost(forum);

    await world.send(linkIn(threadId, forum));

    const [event, ...others] = await world.events();
    expect(others).toEqual([]);
    expect(event).toMatchObject({
      id,
      thread_id: threadId,
      thread_status: "active",
    });
    expect(lastOverview(sent())).toContain("Book the room");
    expect(world.discord.lastReply()).toContain("reminders start again");
  });

  describe("/event link with the event chosen", () => {
    it("moves the row to a post with another title, keeping its name", async () => {
      const { forum, id } = await lostEvent();
      const threadId = memberPost(forum, "Replacement Thread");

      await world.send(linkIn(threadId, forum, chosen(id)));

      expect((await world.events())[0]).toMatchObject({
        id,
        name: "Fall Social",
        thread_id: threadId,
        thread_status: "active",
      });
    });

    it("refuses a deleted event and another guild's event", async () => {
      const { forum, id } = await lostEvent();
      await world.pg.query(`UPDATE public.events SET deleted_at = now()`);
      const otherForum = await world.addManagedForum(OTHER_GUILD);
      const { rows } = await world.pg.query<{ id: string }>(
        `INSERT INTO public.events
           (guild_id, channel_id, name, event_date, created_by, thread_id, thread_status)
         VALUES ($1, $2, 'Theirs', '2099-01-15', $3, $4, 'missing') RETURNING id`,
        [OTHER_GUILD, otherForum, MEMBER_ID, fakeId()],
      );

      for (const eventId of [id, rows[0]?.id]) {
        await world.send(linkIn(memberPost(forum), forum, chosen(eventId)));
        expect(world.discord.lastReply()).toBe(REFUSED.message);
      }
      expect(await world.events("thread_status = 'active'")).toEqual([]);
    });

    it("asks for a date or an event when given neither", async () => {
      const forum = await world.addManagedForum();

      await world.send(linkIn(memberPost(forum), forum, {}));

      await refusedWith("event option");
    });
  });
});
