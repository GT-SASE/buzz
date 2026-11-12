import { describe, expect, it, vi } from "vitest";
import {
  eventCommand,
  eventWorld,
  FUTURE,
  inThread,
  OTHER_GUILD,
} from "../support/event-world.ts";
import {
  HOSTILE_TEXT,
  INVISIBLE_TEXT,
  UNSTORABLE_TEXT,
} from "../support/hostile-text.ts";
import {
  ADMIN_ROLE,
  APP_ID,
  GUILD_ID,
  member,
  MEMBER_ID,
  OFFICER,
  OFFICER_ROLE,
  PLAIN_MEMBER,
} from "../support/interactions.ts";
import {
  MISSING_ACCESS,
  type Failure,
  type SentRequest,
  UNKNOWN_CHANNEL,
} from "../support/discord-server.ts";
import { fakeId } from "../support/ids.ts";
import { softDeleteEvent } from "../../src/db/events.ts";
import { REFUSED } from "../../src/lib/permissions.ts";
import { handler } from "../../src/handlers/event.ts";
import { containsInviteOrMaskedLink } from "../../src/discord/safe-text.ts";

const world = eventWorld();
// Invites and masked links are refused outright, and the rest are stored inert.
const LINKING_TEXT = HOSTILE_TEXT.filter(([, text]) =>
  containsInviteOrMaskedLink(text),
);
const INERT_TEXT = HOSTILE_TEXT.filter(
  ([, text]) => !containsInviteOrMaskedLink(text),
);
const COMMANDS = handler.commands;

const THREADS_POST = /^\/channels\/[0-9]+\/threads$/;
const MESSAGES_POST = /^\/channels\/[0-9]+\/messages$/;
const ACTIVE_THREADS = /\/threads\/active$/;
const ORIGINAL = /\/messages\/@original$/;
const SERVER_ERROR: Failure = { kind: "respond", status: 500 };
const FORBIDDEN: Failure = {
  kind: "respond",
  status: 403,
  code: MISSING_ACCESS,
};

const OTHER_DATE = "2099-02-15";
const ARCHIVED = /\/threads\/archived\/public$/;
const officerFields = { member: OFFICER };

function threadsMade() {
  return [...world.discord.channels.values()].filter(
    (channel) => channel.type === 11,
  );
}

/** Lets the row's post attempt lapse, as if the minute had passed. */
function attemptLapsed() {
  return world.pg.query(
    `UPDATE public.events SET post_attempt_at = now() - interval '61 seconds'`,
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

function privateReplies(): number {
  return world.discord.requests.filter(
    (request) =>
      request.method === "PATCH" &&
      request.path.endsWith("/messages/@original"),
  ).length;
}

function eventInserts(): string[] {
  return world
    .dbRequests()
    .filter((request) => request.startsWith("SQL insert into events"));
}

function postTitles(): unknown[] {
  return world.discord.posts().map((post) => post.body?.name);
}

describe("/event create", () => {
  it.each([
    "Join discord.gg/abc",
    "Social [log in](https://evil.example)",
    "disc\u034Ford.gg/x",
  ])("refuses a name holding an invite or a masked link: %j", async (name) => {
    await world.addManagedForum();

    await world.send(create({ name }));

    expect(world.discord.lastReply()).toContain(
      "can't hold a server invite or a masked link",
    );
    expect(await world.events()).toEqual([]);
    expect(world.discord.posts()).toEqual([]);
  });

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
    expect(event?.thread_id).toEqual(expect.any(String));
    expect(world.discord.channels.get(event?.thread_id ?? "")?.parent_id).toBe(
      forum,
    );
    expect(event?.overview_message_id).toBe(event?.thread_id);
    expect(world.discord.lastReply()).toContain("Created **Fall Social**");
  });

  it("says who created it in the first post, with no ping", async () => {
    await world.addManagedForum();

    await world.send(create());

    const message = world.discord.posts()[0]?.body?.message as Record<
      string,
      unknown
    >;
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
    expect(privateReplies()).toBe(1);
  });

  it("makes one row and one post from a replay that races the first", async () => {
    await world.addManagedForum();
    const payload = create();

    await Promise.all([world.send(payload), world.send(payload)]);

    expect(await world.events()).toHaveLength(1);
    expect(world.discord.posts()).toHaveLength(1);
  });

  describe("choosing a forum", () => {
    it("takes a named forum when several are managed", async () => {
      await world.addManagedForum();
      const chosen = await world.addManagedForum();

      await world.send(create({ forum: forumOption(chosen) }));

      expect((await world.events())[0]?.channel_id).toBe(chosen);
    });

    it("refuses to guess when several are managed", async () => {
      await world.addManagedForum();
      await world.addManagedForum();

      await world.send(create());

      expect(await world.events()).toEqual([]);
      expect(world.discord.publicWrites()).toEqual([]);
      expect(world.discord.lastReply()).toContain("choose one");
    });

    it("explains when no forum is managed", async () => {
      await world.send(create());

      expect(await world.events()).toEqual([]);
      expect(world.discord.lastReply()).toContain("No forums are managed");
    });

    it("does not default to a removed forum", async () => {
      await world.addManagedForum(GUILD_ID, "removed");
      const active = await world.addManagedForum();

      await world.send(create());

      expect((await world.events())[0]?.channel_id).toBe(active);
    });

    it.each([
      ["an unmanaged channel", () => fakeId()],
      ["a value that is no ID", () => "x,channel_id.not.is.null"],
      ["__proto__", () => "__proto__"],
    ])("refuses %s", async (_label, id) => {
      await world.addManagedForum();

      await world.send(create({ forum: forumOption(id()) }));

      expect(await world.events()).toEqual([]);
      expect(world.discord.publicWrites()).toEqual([]);
      expect(world.discord.lastReply()).toContain("isn't managed");
    });

    it("refuses another guild's managed forum", async () => {
      await world.addManagedForum();
      const foreign = await world.addManagedForum(OTHER_GUILD);

      await world.send(create({ forum: forumOption(foreign) }));

      expect(await world.events()).toEqual([]);
      expect(world.discord.publicWrites()).toEqual([]);
    });

    it("refuses a removed forum named outright", async () => {
      const removed = await world.addManagedForum(GUILD_ID, "removed");

      await world.send(create({ forum: forumOption(removed) }));

      expect(await world.events()).toEqual([]);
      expect(world.discord.publicWrites()).toEqual([]);
      // Refused here, without leaning on the database's own check.
      expect(eventInserts()).toEqual([]);
    });
  });

  describe("names", () => {
    it.each(LINKING_TEXT)(
      "refuses a name with an invite or masked link: %s",
      async (_label, name) => {
        await world.addManagedForum();

        await world.send(create({ name: name.slice(0, 100) }));

        expect(await world.events()).toEqual([]);
        expect(world.discord.publicWrites()).toEqual([]);
        expect(world.discord.lastReply()).toContain(
          "can't hold a server invite or a masked link",
        );
      },
    );

    it.each(INERT_TEXT)(
      "stores and posts an inert name: %s",
      async (_label, name) => {
        await world.addManagedForum();

        await world.send(create({ name: name.slice(0, 100) }));

        const titles = postTitles();
        const [event] = await world.events();
        for (const text of [...titles, event?.name]) {
          expect(text).not.toMatch(/[@<>#[\]`|*_~:/\\.\n\r]/u);
        }
        expect(event?.name).toBe(titles[0]);
      },
    );

    it.each([
      ...INVISIBLE_TEXT,
      ...UNSTORABLE_TEXT,
      ["punctuation", "@#/:"],
      ["too long", "x".repeat(101)],
      ["too many emoji", "😀".repeat(51)],
    ] as const)("refuses %s before any write or send", async (_label, name) => {
      await world.addManagedForum();
      const before = world.dbRequests().length;

      await world.send(create({ name }));

      expect(await world.events()).toEqual([]);
      expect(world.discord.publicWrites()).toEqual([]);
      expect(world.discord.lastReply()).toContain("can't be used");
      // The config read and the claim, and nothing that holds the name.
      expect(
        world
          .dbRequests()
          .slice(before)
          .filter((request) => !/guild_config|claim_interaction/.test(request)),
      ).toEqual([]);
    });

    it("tells the person when their name was changed", async () => {
      await world.addManagedForum();

      await world.send(create({ name: "@everyone party" }));

      expect((await world.events())[0]?.name).toBe("everyone party");
      expect(world.discord.lastReply()).toContain("tidied");
    });

    it("refuses a name option that is not a string", async () => {
      await world.addManagedForum();

      await world.send(create({ name: { type: 4, value: 5 } }));

      expect(await world.events()).toEqual([]);
    });
  });

  describe("dates", () => {
    it.each([
      ["2000-01-02", "passed"],
      ["soon", "isn't valid"],
      ["2099-02-30", "isn't valid"],
      ["infinity", "isn't valid"],
      ["2099-01-15\u0000", "isn't valid"],
    ])("refuses %j before any write or send", async (date, reply) => {
      await world.addManagedForum();

      await world.send(create({ date }));

      expect(await world.events()).toEqual([]);
      expect(world.discord.publicWrites()).toEqual([]);
      expect(world.discord.lastReply()).toContain(reply);
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

  it("says when the event that already exists is closed", async () => {
    await world.addManagedForum();
    await world.send(create());
    const [event] = await world.events();
    await world.pg.query(`UPDATE public.events SET status = 'closed'`);

    await world.send(create());

    expect(await world.events()).toHaveLength(1);
    expect(world.discord.lastReply()).toContain(
      `<#${event?.thread_id ?? ""}> and is closed`,
    );
  });

  it("takes the actor and guild only from the signed payload", async () => {
    await world.addManagedForum();
    const hostile = { type: 3, value: fakeId() };

    await world.send(
      create({
        p_actor_id: hostile,
        actor_id: hostile,
        created_by: hostile,
        guild_id: hostile,
        p_guild_id: hostile,
      }),
    );

    expect((await world.events())[0]).toMatchObject({
      guild_id: GUILD_ID,
      created_by: MEMBER_ID,
    });
  });

  it("never shows a name any member controls", async () => {
    await world.addManagedForum();
    const nick = "CanaryNickname";

    await world.send(
      create(
        {},
        {
          member: {
            ...OFFICER,
            nick,
            user: {
              id: MEMBER_ID,
              username: nick,
              global_name: nick,
            },
          },
        },
      ),
    );

    expect(JSON.stringify(world.discord.requests)).not.toContain(nick);
  });

  describe("who may do it", () => {
    it.each([
      ["a member with no role", PLAIN_MEMBER],
      ["a member with another role", member({ roles: [fakeId()] })],
      ["a member whose roles are malformed", member({ roles: ["x"] })],
    ])("refuses %s, with nothing written or sent", async (_label, who) => {
      await world.addManagedForum();

      const ran = await world.send(create({}, { member: who }));

      expect(ran.reply.data?.content).toBe(REFUSED.message);
      expect(ran.deferred).toBe(false);
      expect(await world.events()).toEqual([]);
      expect(world.discord.requests).toEqual([]);
    });

    it("takes the officer role from this payload, not an earlier one", async () => {
      await world.addManagedForum();
      await world.send(create({ name: "First" }));

      const ran = await world.send(
        create({ name: "Second" }, { member: PLAIN_MEMBER }),
      );

      expect(ran.reply.data?.content).toBe(REFUSED.message);
      expect(await world.events()).toHaveLength(1);
    });
  });

  describe("when Discord fails", () => {
    it.each<[string, string, RegExp, Failure]>([
      ["reading the forum", "GET", /^\/channels\/[0-9]+$/, SERVER_ERROR],
      ["reading the forum, refused", "GET", /^\/channels\/[0-9]+$/, FORBIDDEN],
      ["creating the post, refused", "POST", THREADS_POST, FORBIDDEN],
      [
        "creating the post, rate limited",
        "POST",
        THREADS_POST,
        {
          kind: "respond",
          status: 429,
          body: { retry_after: 1, global: true },
        },
      ],
    ])(
      "keeps a pending row and no post: %s",
      async (_label, method, path, failure) => {
        await world.addManagedForum();
        world.discord.fail(method, path, failure);

        await world.send(create());

        const [event, ...others] = await world.events();
        expect(others).toEqual([]);
        expect(event).toMatchObject({
          thread_status: "pending",
          thread_id: null,
          overview_message_id: null,
        });
        expect(world.discord.channels.size).toBe(1);
        expect(world.discord.lastReply()).toContain("/event create");
        expect(world.discord.lastReply()).toContain("/event delete");
      },
    );

    it("recovers on the same row when the same command is run again", async () => {
      await world.addManagedForum();
      world.discord.fail("POST", THREADS_POST, FORBIDDEN, 1);

      await world.send(create());
      await world.send(create());

      const [event, ...others] = await world.events();
      expect(others).toEqual([]);
      expect(event?.thread_status).toBe("active");
      expect(world.discord.lastReply()).toContain("Created");
    });

    it("adopts the post when only the answer was lost", async () => {
      await world.addManagedForum();
      world.discord.fail("POST", THREADS_POST, { kind: "lost" }, 1);

      await world.send(create());

      const [event] = await world.events();
      const threads = [...world.discord.channels.values()].filter(
        (channel) => channel.type === 11,
      );
      expect(threads).toHaveLength(1);
      expect(event).toMatchObject({
        thread_id: threads[0]?.id,
        overview_message_id: threads[0]?.id,
        thread_status: "active",
      });
      expect(world.discord.lastReply()).toContain("Created");
    });

    it("stays pending when no post turns up after an unclear failure", async () => {
      await world.addManagedForum();
      world.discord.fail("POST", THREADS_POST, SERVER_ERROR, 1);

      await world.send(create());

      expect((await world.events())[0]?.thread_status).toBe("pending");
      expect(world.discord.lastReply()).toContain("did not confirm");
    });

    it("does not post twice when the first post is found only on the retry", async () => {
      await world.addManagedForum();
      world.discord.fail("POST", THREADS_POST, { kind: "lost" }, 1);
      world.discord.fail("GET", ACTIVE_THREADS, SERVER_ERROR, 1);

      await world.send(create());

      expect((await world.events())[0]?.thread_status).toBe("pending");

      await world.send(create());

      const [event, ...others] = await world.events();
      const threads = [...world.discord.channels.values()].filter(
        (channel) => channel.type === 11,
      );
      expect(others).toEqual([]);
      expect(threads).toHaveLength(1);
      expect(event?.thread_id).toBe(threads[0]?.id);
    });

    it("makes no second post while it can't check for the first", async () => {
      await world.addManagedForum();
      world.discord.fail("POST", THREADS_POST, { kind: "lost" }, 1);
      world.discord.fail("GET", ACTIVE_THREADS, SERVER_ERROR);

      await world.send(create());
      await world.send(create());

      expect(world.discord.posts()).toHaveLength(1);
      expect((await world.events())[0]?.thread_status).toBe("pending");
      expect(world.discord.lastReply()).toContain("didn't make another");
    });

    it.each([
      ["someone else's post", fakeId(), "Fall Social"],
      ["the bot's post with another title", APP_ID, "Other"],
    ])("does not adopt %s", async (_label, owner, title) => {
      const forum = await world.addManagedForum();
      world.discord.addThread({
        guild_id: GUILD_ID,
        parent_id: forum,
        name: title,
        owner_id: owner,
      });
      world.discord.fail("POST", THREADS_POST, SERVER_ERROR, 1);

      await world.send(create());

      expect((await world.events())[0]?.thread_status).toBe("pending");
    });

    it("does not adopt the bot's post of the same title in another forum", async () => {
      await world.addManagedForum();
      const chosen = await world.addManagedForum();
      const elsewhere = [...world.discord.channels.values()].find(
        (channel) => channel.id !== chosen,
      );
      world.discord.addThread({
        guild_id: GUILD_ID,
        parent_id: elsewhere?.id ?? "",
        name: "Fall Social",
        owner_id: APP_ID,
      });
      world.discord.fail("POST", THREADS_POST, SERVER_ERROR, 1);

      await world.send(create({ forum: forumOption(chosen) }));

      expect((await world.events())[0]?.thread_status).toBe("pending");
    });

    it("treats a success with no usable ID as unclear, and looks for the post", async () => {
      const forum = await world.addManagedForum();
      const threadId = world.discord.addThread({
        guild_id: GUILD_ID,
        parent_id: forum,
        name: "Fall Social",
        owner_id: APP_ID,
      });
      world.discord.fail(
        "POST",
        THREADS_POST,
        { kind: "respond", status: 201, body: {} },
        1,
      );

      await world.send(create());

      expect((await world.events())[0]).toMatchObject({
        thread_id: threadId,
        thread_status: "active",
      });
    });

    it("does not look for a post after a clear refusal", async () => {
      const forum = await world.addManagedForum();
      world.discord.addThread({
        guild_id: GUILD_ID,
        parent_id: forum,
        name: "Fall Social",
        owner_id: APP_ID,
      });
      world.discord.fail("POST", THREADS_POST, {
        kind: "respond",
        status: 400,
        code: 40067,
      });

      await world.send(create());

      expect((await world.events())[0]?.thread_status).toBe("pending");
      expect(
        world.discord.requests.filter((request) =>
          request.path.endsWith("/threads/active"),
        ),
      ).toEqual([]);
    });

    it("brings the overview up to date when a pending event gets its post", async () => {
      await world.addManagedForum();
      world.discord.fail("POST", THREADS_POST, FORBIDDEN, 1);
      await world.send(create());
      const [pending] = await world.events();
      await world.insertTask(pending?.id ?? "");

      await world.send(create());

      const edit = world.discord.requests.find(
        (request) =>
          request.method === "PATCH" &&
          !request.path.endsWith("/messages/@original"),
      );
      expect(edit?.body?.content).toContain("Tasks: 1 open");
    });

    describe("looking for a lost post", () => {
      it("does not adopt another live event's post, and a retry gets its own", async () => {
        await world.addManagedForum();
        await world.send(create());
        const [first] = await world.events();
        world.discord.fail("POST", THREADS_POST, SERVER_ERROR, 1);

        await world.send(create({ date: OTHER_DATE }));

        expect(world.discord.lastReply()).toContain("did not confirm");
        expect(await world.events("thread_status = 'pending'")).toHaveLength(1);

        await attemptLapsed();
        await world.send(create({ date: OTHER_DATE }));

        const second = (await world.events(`event_date = '${OTHER_DATE}'`))[0];
        expect(second?.thread_status).toBe("active");
        expect(second?.thread_id).not.toBe(first?.thread_id);
        expect(threadsMade()).toHaveLength(2);
      });

      it("adopts the new post, not the live event's, when the answer is lost", async () => {
        await world.addManagedForum();
        await world.send(create());
        const [first] = await world.events();
        world.discord.fail("POST", THREADS_POST, { kind: "lost" }, 1);

        await world.send(create({ date: OTHER_DATE }));

        const second = (await world.events(`event_date = '${OTHER_DATE}'`))[0];
        const made = threadsMade().map((thread) => thread.id);
        expect(made).toHaveLength(2);
        expect(second?.thread_id).toBe(
          made.find((id) => id !== first?.thread_id),
        );
        expect(second?.thread_status).toBe("active");
      });

      it("does not adopt a deleted event's post from before the row", async () => {
        await world.addManagedForum();
        world.discord.threadAgeMs = 60_000;
        await world.send(create());
        world.discord.threadAgeMs = 0;
        const [old] = await world.events();
        await softDeleteEvent(world.db, {
          guildId: GUILD_ID,
          eventId: old?.id ?? "",
        });
        const before = world.discord.requests.length;
        world.discord.fail("POST", THREADS_POST, SERVER_ERROR, 1);

        await world.send(create({ date: OTHER_DATE }));

        const [fresh] = await world.events("deleted_at IS NULL");
        expect(fresh?.thread_status).toBe("pending");
        expect(fresh?.thread_id).toBeNull();
        expect(
          world.discord.requests
            .slice(before)
            .filter(
              (request) =>
                request.method === "PATCH" &&
                !request.path.endsWith("/messages/@original"),
            ),
        ).toEqual([]);
      });

      it("chooses neither when two posts could be it", async () => {
        const forum = await world.addManagedForum();
        for (let count = 0; count < 2; count++) {
          world.discord.addThread({
            guild_id: GUILD_ID,
            parent_id: forum,
            name: "Fall Social",
            owner_id: APP_ID,
          });
        }
        world.discord.fail("POST", THREADS_POST, SERVER_ERROR, 1);

        await world.send(create());

        expect((await world.events())[0]?.thread_status).toBe("pending");
        expect(world.discord.lastReply()).toContain("did not confirm");
        expect(world.discord.lastReply()).toContain("More than one post");

        await world.send(create());

        expect((await world.events())[0]?.thread_status).toBe("pending");
        const reply = world.discord.lastReply();
        expect(reply).toContain("didn't make another");
        expect(reply).toContain("event option");
        expect(reply).not.toContain("try again");
        expect(world.discord.posts()).toHaveLength(1);
      });

      it("makes no choice when it can't read who holds a post", async () => {
        const forum = await world.addManagedForum();
        world.discord.addThread({
          guild_id: GUILD_ID,
          parent_id: forum,
          name: "Fall Social",
          owner_id: APP_ID,
        });
        world.discord.fail("POST", THREADS_POST, SERVER_ERROR, 1);
        world.failDb(/^SQL select .* where thread_id = \$/);

        await world.send(create());

        world.clearDbFailures();
        expect((await world.events())[0]?.thread_status).toBe("pending");
        expect(world.discord.lastReply()).toContain("did not confirm");
      });

      it("makes no second post on a retry while it can't read who holds a post", async () => {
        const forum = await world.addManagedForum();
        world.discord.fail("POST", THREADS_POST, SERVER_ERROR, 1);
        await world.send(create());
        world.discord.addThread({
          guild_id: GUILD_ID,
          parent_id: forum,
          name: "Fall Social",
          owner_id: APP_ID,
        });
        await attemptLapsed();
        world.failDb(/^SQL select .* where thread_id = \$/);
        const before = world.discord.posts().length;

        await world.send(create());

        world.clearDbFailures();
        expect(world.discord.posts()).toHaveLength(before);
        expect(world.discord.lastReply()).toContain("didn't make another");
      });

      it("brings the adopted post's overview up to date", async () => {
        await world.addManagedForum();
        world.discord.fail("POST", THREADS_POST, { kind: "lost" }, 1);

        await world.send(create());

        const edit = world.discord.requests.find(
          (request) =>
            request.method === "PATCH" &&
            !request.path.endsWith("/messages/@original"),
        );
        expect(edit?.body?.content).toContain("**Fall Social**");
      });

      it("finds a post that has since been archived", async () => {
        const forum = await world.addManagedForum();
        const threadId = world.discord.addThread({
          guild_id: GUILD_ID,
          parent_id: forum,
          name: "Fall Social",
          owner_id: APP_ID,
          archived: true,
        });
        world.discord.fail("POST", THREADS_POST, SERVER_ERROR, 1);

        await world.send(create());

        expect((await world.events())[0]?.thread_id).toBe(threadId);
      });

      it("ignores an archived post older than the row", async () => {
        const forum = await world.addManagedForum();
        world.discord.threadAgeMs = 60_000;
        world.discord.addThread({
          guild_id: GUILD_ID,
          parent_id: forum,
          name: "Fall Social",
          owner_id: APP_ID,
          archived: true,
        });
        world.discord.threadAgeMs = 0;
        world.discord.fail("POST", THREADS_POST, SERVER_ERROR, 1);

        await world.send(create());

        expect((await world.events())[0]?.thread_status).toBe("pending");
      });

      it("carries on when refused the archived posts, as the planned permissions do", async () => {
        await world.addManagedForum();
        world.discord.fail("POST", THREADS_POST, SERVER_ERROR, 1);
        world.discord.fail("GET", ARCHIVED, FORBIDDEN);

        await world.send(create());
        await attemptLapsed();
        await world.send(create());

        expect((await world.events())[0]?.thread_status).toBe("active");
        expect(threadsMade()).toHaveLength(1);
      });

      it("makes no second post when the archived posts can't be read", async () => {
        await world.addManagedForum();
        world.discord.fail("POST", THREADS_POST, SERVER_ERROR, 1);
        world.discord.fail("GET", ARCHIVED, SERVER_ERROR);

        await world.send(create());
        await attemptLapsed();
        await world.send(create());

        expect(world.discord.posts()).toHaveLength(1);
        expect(world.discord.lastReply()).toContain("didn't make another");
      });
    });

    describe("the post attempt", () => {
      it("lets one of two retries post, and tells the other", async () => {
        await world.addManagedForum();
        world.discord.fail("POST", THREADS_POST, FORBIDDEN, 1);
        await world.send(create());
        const before = world.discord.posts().length;

        await Promise.all([world.send(create()), world.send(create())]);

        expect(await world.events()).toHaveLength(1);
        expect(world.discord.posts().length - before).toBe(1);
        expect(threadsMade()).toHaveLength(1);
        const replies = world.discord.requests
          .filter(
            (request) =>
              request.method === "PATCH" &&
              request.path.endsWith("/messages/@original"),
          )
          .map((request) => request.body?.content);
        expect(replies.join("\n")).toContain("already in progress");
      });

      it("makes a retry wait after an unclear failure", async () => {
        await world.addManagedForum();
        world.discord.fail("POST", THREADS_POST, SERVER_ERROR, 1);

        await world.send(create());
        await world.send(create());

        expect(world.discord.posts()).toHaveLength(1);
        expect(world.discord.lastReply()).toContain("already in progress");
      });

      it("lets a retry through at once after a clear refusal", async () => {
        await world.addManagedForum();
        world.discord.fail("POST", THREADS_POST, FORBIDDEN, 1);

        await world.send(create());
        await world.send(create());

        expect((await world.events())[0]?.thread_status).toBe("active");
      });

      it("recovers by itself if the holder crashed", async () => {
        await world.addManagedForum();
        world.discord.fail("POST", THREADS_POST, SERVER_ERROR, 1);
        await world.send(create());
        await attemptLapsed();

        await world.send(create());

        expect((await world.events())[0]?.thread_status).toBe("active");
      });

      it("posts nothing if the attempt can't be taken", async () => {
        await world.addManagedForum();
        world.failDb(/public\.claim_event_post_attempt\(/);

        await world.send(create());

        expect(world.discord.posts()).toEqual([]);
        expect(world.discord.lastReply()).toContain("Something went wrong");
      });

      it("still succeeds if another retry attached this same post first", async () => {
        await world.addManagedForum();
        world.discord.onThreadCreated = (threadId) =>
          world.pg.query(
            `UPDATE public.events SET thread_id = $1, thread_status = 'active'`,
            [threadId],
          );

        await world.send(create());

        expect(world.discord.lastReply()).toContain("Created");
        expect(world.errors).not.toHaveBeenCalled();
      });

      it("reports the post if another retry attached a different one", async () => {
        await world.addManagedForum();
        const other = fakeId();
        world.discord.onThreadCreated = () =>
          world.pg.query(
            `UPDATE public.events SET thread_id = $1, thread_status = 'active'`,
            [other],
          );

        await world.send(create());

        const made = threadsMade()[0]?.id ?? "";
        expect(world.discord.lastReply()).toContain(`<#${made}>`);
        expect(world.discord.lastReply()).toContain("/event link");
      });
    });

    describe("when the wording itself is refused", () => {
      it.each([200000, 200001, 240000])(
        "does not suggest the same command again: %i",
        async (code) => {
          await world.addManagedForum();
          world.discord.fail("POST", THREADS_POST, {
            kind: "respond",
            status: 400,
            code,
          });

          await world.send(create());

          expect(world.discord.lastReply()).toContain("different wording");
          expect(world.discord.lastReply()).not.toContain("same /event create");
        },
      );

      it("still suggests it for a refusal that has nothing to do with the words", async () => {
        await world.addManagedForum();
        world.discord.fail(
          "POST",
          THREADS_POST,
          { kind: "respond", status: 400, code: 160006 },
          1,
        );

        await world.send(create());

        expect(world.discord.lastReply()).toContain("same /event create");
      });
    });

    describe("naming the real cause", () => {
      it.each<[string, Failure, string]>([
        [
          "a forum that requires tags",
          { kind: "respond", status: 400, code: 40067 },
          "requires a tag",
        ],
        ["AutoMod", { kind: "respond", status: 400, code: 200000 }, "AutoMod"],
        [
          "AutoMod on the title",
          { kind: "respond", status: 400, code: 200001 },
          "AutoMod",
        ],
        [
          "a harmful link",
          { kind: "respond", status: 400, code: 240000 },
          "AutoMod",
        ],
        [
          "tags only moderators can set",
          { kind: "respond", status: 400, code: 40066 },
          "only moderators",
        ],
        [
          "too many active posts",
          { kind: "respond", status: 400, code: 160006 },
          "limit on active posts",
        ],
        ["no access", FORBIDDEN, "can't see"],
        [
          "no permission",
          { kind: "respond", status: 403, code: 50013 },
          "not allowed",
        ],
        ["another refusal", { kind: "respond", status: 400 }, "refused"],
      ])("%s", async (_label, failure, reply) => {
        await world.addManagedForum();
        world.discord.fail("POST", THREADS_POST, failure, 1);

        await world.send(create());

        expect((await world.events())[0]?.thread_status).toBe("pending");
        expect(world.discord.lastReply()).toContain(reply);
      });
    });

    it("keeps the row and post when the private reply fails", async () => {
      await world.addManagedForum();
      world.discord.fail("PATCH", ORIGINAL, SERVER_ERROR);

      await world.send(create());

      expect((await world.events())[0]?.thread_status).toBe("active");
      expect(world.discord.posts()).toHaveLength(1);
    });
  });

  describe("when the database fails", () => {
    it.each([
      ["the claim", /public\.claim_interaction\(/],
      ["reading the forums", /^SQL select .* from managed_channels/],
      ["looking for the event", /^SQL select .* from events/],
      ["the insert", /^SQL insert into events/],
    ])("posts nothing and says so when %s fails", async (_label, pattern) => {
      await world.addManagedForum();
      world.failDb(pattern);

      await world.send(create());

      world.clearDbFailures();
      expect(await world.events()).toEqual([]);
      expect(world.discord.posts()).toEqual([]);
      expect(world.discord.lastReply()).toContain("Something went wrong");
    });

    it("retries saving the post through a brief failure", async () => {
      await world.addManagedForum();
      world.failDb(/^SQL update events/, 500, 2);

      await world.send(create());

      expect((await world.events())[0]?.thread_status).toBe("active");
      expect(world.discord.lastReply()).toContain("Created");
    });

    it("names and logs the post when it can't be saved", async () => {
      await world.addManagedForum();
      world.failDb(/^SQL update events/);

      await world.send(create());

      world.clearDbFailures();
      const [event] = await world.events();
      const thread = [...world.discord.channels.values()].find(
        (channel) => channel.type === 11,
      );
      expect(event?.thread_status).toBe("pending");
      expect(world.discord.lastReply()).toContain(`<#${thread?.id ?? ""}>`);
      expect(world.discord.lastReply()).toContain("/event link");
      const logged = JSON.stringify(world.errors.mock.calls);
      expect(logged).toContain(thread?.id);
      expect(logged).toContain(event?.id);
      expect(logged).not.toContain("Fall Social");
    });

    it("attaches that post when the same command runs again", async () => {
      await world.addManagedForum();
      world.failDb(/^SQL update events/, 500, 3);

      await world.send(create());
      await world.send(create());

      const [event, ...others] = await world.events();
      expect(others).toEqual([]);
      expect(world.discord.posts()).toHaveLength(1);
      expect(event?.thread_status).toBe("active");
    });

    it("attaches that post when /event link runs inside it", async () => {
      const forum = await world.addManagedForum();
      world.failDb(/^SQL update events/, 500, 3);

      await world.send(create());

      const [pending] = await world.events();
      const threadId =
        [...world.discord.channels.values()].find(
          (channel) => channel.type === 11,
        )?.id ?? "";

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
    expect(event?.overview_message_id).toEqual(expect.any(String));
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
    expect(privateReplies()).toBe(1);
  });

  it.each(LINKING_TEXT)(
    "refuses a title with an invite or masked link: %s",
    async (_label, title) => {
      const { parent, threadId } = await post(title.slice(0, 100));

      await world.send(link(threadId, parent));

      expect(await world.events()).toEqual([]);
      expect(world.discord.publicWrites()).toEqual([]);
      expect(world.discord.lastReply()).toContain(
        "holds a server invite or a masked link",
      );
    },
  );

  it.each(INERT_TEXT)(
    "names the event inertly from a hostile title: %s",
    async (_label, title) => {
      const { parent, threadId } = await post(title.slice(0, 100));

      await world.send(link(threadId, parent));

      const [event] = await world.events();
      expect(event?.name).toEqual(expect.any(String));
      expect(event?.name).not.toMatch(/[@<>#[\]`|*_~:/\\.\n\r]/u);
      expect(JSON.stringify(world.discord.posts())).not.toContain("<@&");
    },
  );

  it.each([
    ...INVISIBLE_TEXT,
    ...UNSTORABLE_TEXT,
    ["no title", null],
    ["only punctuation", "@#/:"],
  ] as const)("refuses a post titled with %s", async (_label, title) => {
    const { parent, threadId } = await post(title);

    await world.send(link(threadId, parent));

    expect(await world.events()).toEqual([]);
    expect(world.discord.publicWrites()).toEqual([]);
    expect(world.discord.lastReply()).toContain("title");
  });

  describe("what it refuses", () => {
    async function expectRefused(payload: unknown, reply = "Run this inside") {
      await world.send(payload);

      expect(await world.events()).toEqual([]);
      expect(world.discord.publicWrites()).toEqual([]);
      expect(world.discord.lastReply()).toContain(reply);
    }

    it("a channel that is not a thread", async () => {
      await world.addManagedForum();
      const text = fakeId();
      world.discord.channels.set(text, {
        id: text,
        type: 0,
        guild_id: GUILD_ID,
        name: "general",
      });

      await expectRefused(
        eventCommand(
          "link",
          { date: FUTURE },
          { ...officerFields, channel: { id: text, type: 0 } },
        ),
      );
    });

    it("a forum itself", async () => {
      const forum = await world.addManagedForum();

      await expectRefused(
        eventCommand(
          "link",
          { date: FUTURE },
          { ...officerFields, channel: { id: forum, type: 15 } },
        ),
      );
    });

    it("an unrelated thread, whose parent is not managed", async () => {
      await world.addManagedForum();
      const unmanaged = world.discord.addForum(GUILD_ID);
      const threadId = world.discord.addThread({
        guild_id: GUILD_ID,
        parent_id: unmanaged,
        name: "Private chat",
      });

      await expectRefused(link(threadId, unmanaged));
    });

    it("a thread whose payload claims a managed parent Discord denies", async () => {
      const managed = await world.addManagedForum();
      const unmanaged = world.discord.addForum(GUILD_ID);
      const threadId = world.discord.addThread({
        guild_id: GUILD_ID,
        parent_id: unmanaged,
        name: "Private chat",
      });

      await expectRefused(link(threadId, managed));
    });

    it("another guild's thread", async () => {
      const managed = await world.addManagedForum();
      const foreignForum = await world.addManagedForum(OTHER_GUILD);
      const threadId = world.discord.addThread({
        guild_id: OTHER_GUILD,
        parent_id: foreignForum,
        name: "Their post",
      });

      await expectRefused(link(threadId, managed));
    });

    it("a thread of this guild under a forum another guild manages", async () => {
      const foreignForum = await world.addManagedForum(OTHER_GUILD);
      const threadId = world.discord.addThread({
        guild_id: GUILD_ID,
        parent_id: foreignForum,
        name: "Odd post",
      });

      await expectRefused(link(threadId, foreignForum));
    });

    it("a channel that has a managed parent but is not a thread", async () => {
      const managed = await world.addManagedForum();
      const text = fakeId();
      world.discord.channels.set(text, {
        id: text,
        type: 0,
        guild_id: GUILD_ID,
        parent_id: managed,
        name: "general",
      });

      await expectRefused(link(text, managed));
    });

    it("a thread Discord places in another guild, under this guild's forum", async () => {
      const managed = await world.addManagedForum();
      const threadId = world.discord.addThread({
        guild_id: OTHER_GUILD,
        parent_id: managed,
        name: "Odd post",
      });

      await expectRefused(link(threadId, managed));
    });

    it("a thread whose managed parent Discord places in another guild", async () => {
      const managed = await world.addManagedForum();
      const entry = world.discord.channels.get(managed);
      if (entry !== undefined) {
        entry.guild_id = OTHER_GUILD;
      }
      const threadId = world.discord.addThread({
        guild_id: GUILD_ID,
        parent_id: managed,
        name: "Odd post",
      });

      await expectRefused(link(threadId, managed));
    });

    it("a thread whose managed parent is no longer a forum", async () => {
      const managed = await world.addManagedForum();
      const entry = world.discord.channels.get(managed);
      if (entry !== undefined) {
        entry.type = 0;
      }
      const threadId = world.discord.addThread({
        guild_id: GUILD_ID,
        parent_id: managed,
        name: "Thread in text",
      });

      await expectRefused(link(threadId, managed));
    });

    it.each(["removed", "unavailable"])(
      "a post in a forum that is %s",
      async (status) => {
        const forum = await world.addManagedForum(GUILD_ID, status);
        const { threadId } = await post("In old forum", forum);

        await expectRefused(link(threadId, forum));
      },
    );

    it("a channel Discord says is gone", async () => {
      const forum = await world.addManagedForum();
      world.discord.fail("GET", /^\/channels\/[0-9]+$/, {
        kind: "respond",
        status: 404,
        code: UNKNOWN_CHANNEL,
      });

      await expectRefused(link(fakeId(), forum));
    });

    it("a post when Discord can't say what it is", async () => {
      const { parent, threadId } = await post();
      world.discord.fail("GET", /^\/channels\/[0-9]+$/, SERVER_ERROR);

      await expectRefused(link(threadId, parent), "could not confirm");
    });

    it("a past date", async () => {
      const { parent, threadId } = await post();

      await expectRefused(
        link(threadId, parent, officerFields, "2000-01-02"),
        "passed",
      );
    });
  });

  it.each(["active", "closed"])(
    "refuses a post already held by an event that is %s",
    async (status) => {
      const { parent, threadId } = await post();
      await world.send(link(threadId, parent));
      await world.pg.query(
        `UPDATE public.events SET status = $1::public.event_status`,
        [status],
      );

      await world.send(link(threadId, parent));

      const inserts = eventInserts().length;
      expect(inserts).toBe(1);
      expect(await world.events()).toHaveLength(1);
      expect(world.discord.posts()).toHaveLength(1);
      expect(world.discord.lastReply()).toContain("already belongs");
    },
  );

  it("posts its own overview when a pending event adopts someone else's post", async () => {
    const forum = await world.addManagedForum();
    world.discord.fail("POST", THREADS_POST, FORBIDDEN, 1);
    await world.send(create({ name: "A Post" }));
    const [pending] = await world.events();
    const { threadId } = await post("A Post", forum);

    await world.send(link(threadId, forum));

    const [event, ...others] = await world.events();
    expect(others).toEqual([]);
    expect(event?.id).toBe(pending?.id);
    expect(event?.thread_id).toBe(threadId);
    // The post's first message is that person's, so the bot could never edit it.
    expect(event?.overview_message_id).not.toBe(threadId);
    expect(world.discord.posts().at(-1)?.path).toBe(
      `/channels/${threadId}/messages`,
    );
  });

  it("refuses a post with the same title and date as a live event's", async () => {
    const forum = await world.addManagedForum();
    await world.send(create());
    const [existing] = await world.events();
    const { threadId } = await post("Fall Social", forum);

    await world.send(link(threadId, forum));

    expect(await world.events()).toHaveLength(1);
    expect(world.discord.posts()).toHaveLength(1);
    expect(world.discord.lastReply()).toContain(
      `<#${existing?.thread_id ?? ""}>`,
    );
  });

  it("allows the same title on another date", async () => {
    const forum = await world.addManagedForum();
    await world.send(create());
    const { threadId } = await post("Fall Social", forum);

    await world.send(link(threadId, forum, officerFields, OTHER_DATE));

    expect(await world.events()).toHaveLength(2);
  });

  it("takes back a post whose event was deleted", async () => {
    const { parent, threadId } = await post();
    await world.send(link(threadId, parent));
    await world.pg.query(`UPDATE public.events SET deleted_at = now()`);

    await world.send(link(threadId, parent));

    expect(await world.events("deleted_at IS NULL")).toHaveLength(1);
    expect(await world.events()).toHaveLength(2);
  });

  it("settles two links of one post at the database", async () => {
    const { parent, threadId } = await post();
    await world.send(link(threadId, parent));
    const held = (await world.events())[0];
    // The event has another name by now, so nothing else stops this before the write.
    await world.pg.query(`UPDATE public.events SET name = 'Other name'`);
    // The read sees nothing held, as if the other link had not yet committed.
    world.failDb(/^SQL select .* where thread_id = \$/, 200, 1);

    await world.send(link(threadId, parent));

    expect(await world.events()).toHaveLength(1);
    expect((await world.events())[0]?.id).toBe(held?.id);
    expect(world.discord.posts()).toHaveLength(1);
    expect(world.discord.lastReply()).toContain("already belongs");
  });

  it.each([
    ["a member with no role", PLAIN_MEMBER],
    ["a member with another role", member({ roles: [fakeId()] })],
  ])("refuses %s, with nothing written or sent", async (_label, who) => {
    const { parent, threadId } = await post();

    const ran = await world.send(link(threadId, parent, { member: who }));

    expect(ran.reply.data?.content).toBe(REFUSED.message);
    expect(await world.events()).toEqual([]);
    expect(world.discord.requests).toEqual([]);
  });

  describe("when a step after the row fails", () => {
    it.each<[string, Failure]>([
      ["a refusal", FORBIDDEN],
      ["a server error", SERVER_ERROR],
      ["no answer", { kind: "network" }],
    ])(
      "keeps the link and says the overview will follow: %s",
      async (_label, failure) => {
        const { parent, threadId } = await post();
        world.discord.fail("POST", MESSAGES_POST, failure);

        await world.send(link(threadId, parent));

        expect((await world.events())[0]).toMatchObject({
          thread_id: threadId,
          thread_status: "active",
          overview_message_id: null,
        });
        expect(world.discord.lastReply()).toContain("overview");
        expect(world.discord.lastReply()).toContain("next change");
      },
    );

    it("keeps the link when saving the overview's ID fails", async () => {
      const { parent, threadId } = await post();
      world.failDb(/^SQL update events/);

      await world.send(link(threadId, parent));

      world.clearDbFailures();
      expect((await world.events())[0]).toMatchObject({
        thread_id: threadId,
        overview_message_id: null,
      });
      expect(world.discord.lastReply()).toContain("Linked this post");
      expect(world.discord.lastReply()).toContain("second one");
      expect(world.errors).toHaveBeenCalledWith(
        expect.stringContaining("overview save"),
      );
    });

    it("waits out a longer failure to save the overview's ID", async () => {
      const { parent, threadId } = await post();
      world.failDb(/^SQL update events/, 500, 4);

      await world.send(link(threadId, parent));

      const [event] = await world.events();
      expect(event?.overview_message_id).toEqual(expect.any(String));
      expect(world.discord.lastReply()).not.toContain("second one");
    });

    it("gives up on saving the overview's ID well inside the function's limit", async () => {
      const { parent, threadId } = await post();
      world.failDb(/^SQL update events/);
      // Each query's deadline is a timer the client starts as the query goes out.
      const timeouts = vi.spyOn(globalThis, "setTimeout");
      const started = Date.now();

      await world.send(link(threadId, parent));

      const pauses = Date.now() - started;
      const deadlines = timeouts.mock.calls.filter(([, ms]) => ms === 4000);
      timeouts.mockRestore();
      world.clearDbFailures();
      const writes = world
        .dbRequests()
        .filter((request) => request.startsWith("SQL update events"));
      expect(writes).toHaveLength(5);
      expect(deadlines).toHaveLength(5);
      // A database that hangs uses every deadline, and the function is stopped at 60 s.
      expect(4000 * writes.length + pauses).toBeLessThan(30_000);
      expect(world.discord.lastReply()).toContain("second one");
      expect(world.errors).toHaveBeenCalledWith(
        expect.stringContaining("overview save"),
      );
    });

    it("posts no second overview in the bot's own post when the save fails", async () => {
      const forum = await world.addManagedForum();
      world.discord.fail("POST", THREADS_POST, FORBIDDEN, 1);
      await world.send(create({ name: "A Post" }));
      const threadId = world.discord.addThread({
        guild_id: GUILD_ID,
        parent_id: forum,
        name: "A Post",
        owner_id: APP_ID,
      });
      world.failDb(/^SQL update events(?!.*thread_status <> )/);
      const before = world.discord.requests.length;

      await world.send(link(threadId, forum));

      world.clearDbFailures();
      expect((await world.events())[0]?.thread_id).toBe(threadId);
      expect(
        world.discord.requests
          .slice(before)
          .filter((request) => MESSAGES_POST.test(request.path)),
      ).toEqual([]);
      expect(world.discord.lastReply()).toContain("second one");
    });

    it("writes nothing when the insert fails", async () => {
      const { parent, threadId } = await post();
      world.failDb(/^SQL insert into events/);

      await world.send(link(threadId, parent));

      world.clearDbFailures();
      expect(await world.events()).toEqual([]);
      expect(world.discord.posts()).toEqual([]);
      expect(world.discord.lastReply()).toContain("Something went wrong");
    });
  });
});

describe("an event whose post was deleted", () => {
  /** An event with one task, in the state the first send to a deleted post leaves it. */
  async function lostEvent(fields: { name?: string } = {}) {
    const forum = await world.addManagedForum();
    await world.send(create({ name: fields.name ?? "Fall Social" }));
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

  function linkIn(threadId: string, forum: string, date = FUTURE) {
    return eventCommand(
      "link",
      { date },
      { ...officerFields, ...inThread(threadId, forum) },
    );
  }

  function overviewTexts(sent: readonly SentRequest[]) {
    return sent.flatMap(({ body }) => {
      const message = (body?.message ?? body) as
        Record<string, unknown> | undefined;
      const content = message?.content;
      return typeof content === "string" && content.includes("Status:")
        ? [content]
        : [];
    });
  }

  describe("/event create with the same name and date", () => {
    it("gives the same row a new post that shows its tasks", async () => {
      const { id, oldThread, sent } = await lostEvent();

      await world.send(create());

      const [event, ...others] = await world.events();
      expect(others).toEqual([]);
      expect(event?.id).toBe(id);
      expect(event?.thread_status).toBe("active");
      expect(event?.thread_id).not.toBe(oldThread);
      expect(event?.overview_message_id).toBe(event?.thread_id);
      const { rows } = await world.pg.query(
        `SELECT 1 FROM public.tasks WHERE event_id = $1 AND deleted_at IS NULL`,
        [id],
      );
      expect(rows).toHaveLength(1);
      expect(overviewTexts(sent())[0]).toContain("Book the room");
      expect(world.discord.lastReply()).toContain("had lost its post");
      expect(world.discord.lastReply()).toContain("reminders start again");
    });

    it("keeps the row as it is when Discord clearly refuses", async () => {
      const { id } = await lostEvent();
      world.discord.fail("POST", THREADS_POST, FORBIDDEN, 1);

      await world.send(create());

      const [event, ...others] = await world.events();
      expect(others).toEqual([]);
      expect(event).toMatchObject({ id, thread_status: "missing" });
      expect(world.discord.lastReply()).toContain("tasks are kept");
    });

    it("points at /event link when replacing the post meets a wording refusal", async () => {
      const { id } = await lostEvent();
      world.discord.fail(
        "POST",
        THREADS_POST,
        { kind: "respond", status: 400, code: 200001 },
        1,
      );

      await world.send(create());

      expect((await world.events())[0]).toMatchObject({
        id,
        thread_status: "missing",
      });
      expect(world.discord.lastReply()).toContain("/event link");
    });

    it("adopts the post when only the answer was lost", async () => {
      const { id, sent } = await lostEvent();
      world.discord.fail("POST", THREADS_POST, { kind: "lost" }, 1);

      await world.send(create());

      const [event, ...others] = await world.events();
      expect(others).toEqual([]);
      expect(event).toMatchObject({ id, thread_status: "active" });
      expect(
        sent().filter((request) => THREADS_POST.test(request.path)),
      ).toHaveLength(1);
    });

    it("does not take up the post of a deleted event made since the row", async () => {
      const { forum, id, sent } = await lostEvent();
      await world.send(create({ date: OTHER_DATE, forum: forumOption(forum) }));
      const other = (await world.events(`event_date = '${OTHER_DATE}'`))[0];
      await softDeleteEvent(world.db, {
        guildId: GUILD_ID,
        eventId: other?.id ?? "",
      });

      await world.send(create({ forum: forumOption(forum) }));

      const [event] = await world.events(`id = '${id}'`);
      expect(event?.thread_status).toBe("active");
      expect(event?.thread_id).not.toBe(other?.thread_id);
      expect(
        sent().filter((request) => THREADS_POST.test(request.path)),
      ).toHaveLength(2);
      expect(world.discord.lastReply()).toContain(
        `<#${event?.thread_id ?? ""}>`,
      );
      expect(
        sent().filter(
          (request) =>
            request.method === "PATCH" &&
            request.path.startsWith(`/channels/${other?.thread_id ?? ""}/`),
        ),
      ).toEqual([]);
    });

    it("still finds a spare post that a replacement left behind", async () => {
      const { forum, id, sent } = await lostEvent();
      const spare = world.discord.addThread({
        guild_id: GUILD_ID,
        parent_id: forum,
        name: "Fall Social",
        owner_id: APP_ID,
      });

      await world.send(create({ forum: forumOption(forum) }));

      expect((await world.events(`id = '${id}'`))[0]?.thread_id).toBe(spare);
      expect(
        sent().filter((request) => THREADS_POST.test(request.path)),
      ).toEqual([]);
    });

    describe("when more than one post could be its new one", () => {
      function sparePosts(forum: string, count: number) {
        return Array.from({ length: count }, () =>
          world.discord.addThread({
            guild_id: GUILD_ID,
            parent_id: forum,
            name: "Fall Social",
            owner_id: APP_ID,
          }),
        );
      }

      it("names them and points to /event link, without asking for a retry", async () => {
        const { forum, sent } = await lostEvent();
        const spares = sparePosts(forum, 2);

        await world.send(create({ forum: forumOption(forum) }));

        const reply = world.discord.lastReply();
        for (const spare of spares) {
          expect(reply).toContain(`<#${spare}>`);
        }
        expect(reply).toContain("/event link");
        expect(reply).toContain("event option");
        expect(reply).not.toContain("try again");
        expect((await world.events())[0]?.thread_status).toBe("missing");
        expect(
          sent().filter((request) => THREADS_POST.test(request.path)),
        ).toEqual([]);
      });

      it("names only the first few", async () => {
        const { forum } = await lostEvent();
        sparePosts(forum, 7);

        await world.send(create({ forum: forumOption(forum) }));

        const reply = world.discord.lastReply() ?? "";
        expect(reply.match(/<#[0-9]+>/g)).toHaveLength(5);
        expect(reply).toContain("and others");
      });

      it("says the same when the new post's answer was lost", async () => {
        const { forum } = await lostEvent();
        const [archived] = sparePosts(forum, 1);
        Object.assign(world.discord.channels.get(archived ?? "") ?? {}, {
          archived: true,
        });
        // The first look can't see the archived post. The second, after the post, can.
        world.discord.fail("GET", ARCHIVED, FORBIDDEN, 1);
        world.discord.fail("POST", THREADS_POST, { kind: "lost" }, 1);

        await world.send(create({ forum: forumOption(forum) }));

        const reply = world.discord.lastReply();
        expect(reply).toContain("did not confirm");
        expect(reply).toContain(`<#${archived ?? ""}>`);
        expect(reply).toContain("More than one post");
        expect((await world.events())[0]?.thread_status).toBe("missing");
      });

      it("still asks for a retry when Discord can't answer", async () => {
        const { forum } = await lostEvent();
        sparePosts(forum, 2);
        world.discord.fail("GET", ACTIVE_THREADS, SERVER_ERROR, 1);

        await world.send(create({ forum: forumOption(forum) }));

        const reply = world.discord.lastReply();
        expect(reply).toContain("try again");
        expect(reply).not.toContain("More than one post");
      });

      it("finds one and takes it up once the others are claimed or gone", async () => {
        const { forum, id } = await lostEvent();
        const [first, second] = sparePosts(forum, 2);
        await world.send(create({ forum: forumOption(forum) }));
        Object.assign(world.discord.channels.get(second ?? "") ?? {}, {
          parent_id: fakeId(),
        });

        await world.send(create({ forum: forumOption(forum) }));

        expect((await world.events(`id = '${id}'`))[0]).toMatchObject({
          thread_id: first,
          thread_status: "active",
        });
      });
    });

    it("finds the post on a retry rather than making a second", async () => {
      const { sent } = await lostEvent();
      world.discord.fail("POST", THREADS_POST, { kind: "lost" }, 1);
      // The first look finds nothing to ask about, so this only stops the second.
      world.failDb(/^SQL select .* where thread_id = \$/);
      await world.send(create());
      expect(world.discord.lastReply()).toContain("did not confirm");
      world.clearDbFailures();

      await world.send(create());

      expect(
        sent().filter((request) => THREADS_POST.test(request.path)),
      ).toHaveLength(1);
      expect((await world.events())[0]?.thread_status).toBe("active");
    });

    it("makes no post while it can't check for an earlier one", async () => {
      const { sent } = await lostEvent();
      world.discord.fail("GET", ACTIVE_THREADS, SERVER_ERROR, 1);

      await world.send(create());

      expect(
        sent().filter((request) => THREADS_POST.test(request.path)),
      ).toEqual([]);
      expect((await world.events())[0]?.thread_status).toBe("missing");
    });

    it("names the spare post when another request got there first", async () => {
      const { id } = await lostEvent();
      const winner = fakeId();
      world.discord.onThreadCreated = async () => {
        await world.pg.query(
          `UPDATE public.events SET thread_id = $1, thread_status = 'active' WHERE id = $2`,
          [winner, id],
        );
      };

      await world.send(create());

      expect((await world.events())[0]?.thread_id).toBe(winner);
      expect(world.discord.lastReply()).toContain(`<#${winner}>`);
      expect(world.discord.lastReply()).toContain("spare");
    });

    it("names and logs the post when it can't be saved, and a retry joins it", async () => {
      const { sent } = await lostEvent();
      world.failDb(/^SQL update events/);

      await world.send(create());

      world.clearDbFailures();
      expect((await world.events())[0]?.thread_status).toBe("missing");
      expect(world.discord.lastReply()).toContain("could not be saved");
      expect(world.errors).toHaveBeenCalledWith(
        expect.stringContaining("post save"),
      );

      await world.send(create());

      expect((await world.events())[0]?.thread_status).toBe("active");
      expect(
        sent().filter((request) => THREADS_POST.test(request.path)),
      ).toHaveLength(1);
    });

    it("says so when the overview's ID can't be saved", async () => {
      const { sent } = await lostEvent();
      world.failDb(/^SQL update events(?!.*thread_status <> )/);

      await world.send(create());

      world.clearDbFailures();
      expect((await world.events())[0]?.thread_status).toBe("active");
      expect(world.discord.lastReply()).toContain("second one");
      // Refreshing with no saved overview would post a second one.
      expect(
        sent().filter((request) => MESSAGES_POST.test(request.path)),
      ).toEqual([]);
    });

    it("does not take up a closed event", async () => {
      const { id } = await lostEvent();
      await world.pg.query(
        `UPDATE public.events SET status = 'closed' WHERE id = $1`,
        [id],
      );
      const before = world.discord.posts().length;

      await world.send(create());

      expect(await world.events()).toHaveLength(1);
      expect(world.discord.posts()).toHaveLength(before);
      expect(world.discord.lastReply()).toContain("closed");
    });

    it("refuses to guess between two events that lost their posts", async () => {
      const { forum, id } = await lostEvent();
      await world.pg.query(
        `INSERT INTO public.events
           (guild_id, channel_id, name, event_date, created_by, thread_id, thread_status)
         SELECT guild_id, channel_id, name, event_date, created_by, $2, 'missing'
         FROM public.events WHERE id = $1`,
        [id, fakeId()],
      );
      const before = world.discord.posts().length;

      await world.send(create({ forum: forumOption(forum) }));

      expect(await world.events()).toHaveLength(2);
      expect(world.discord.posts()).toHaveLength(before);
      expect(world.discord.lastReply()).toContain("More than one");
    });

    it("leaves it alone for another date or another forum", async () => {
      const { forum, id } = await lostEvent();
      const other = await world.addManagedForum();

      await world.send(create({ date: OTHER_DATE, forum: forumOption(forum) }));
      await world.send(create({ forum: forumOption(other) }));

      expect(await world.events()).toHaveLength(3);
      expect((await world.events(`id = '${id}'`))[0]?.thread_status).toBe(
        "missing",
      );
    });

    it("still refuses while another event of that name has a post", async () => {
      const { forum, id } = await lostEvent();
      await world.send(create());
      const live = (await world.events())[0]?.thread_id ?? "";
      await world.pg.query(
        `INSERT INTO public.events
           (guild_id, channel_id, name, event_date, created_by, thread_id, thread_status)
         SELECT guild_id, channel_id, name, event_date, created_by, $2, 'missing'
         FROM public.events WHERE id = $1`,
        [id, fakeId()],
      );

      await world.send(create({ forum: forumOption(forum) }));

      expect(world.discord.lastReply()).toContain(`<#${live}>`);
      expect(world.discord.lastReply()).toContain("already exists");
    });
  });

  describe("/event link in a replacement post", () => {
    it("refuses to guess between two events that lost their posts", async () => {
      const { forum, id } = await lostEvent();
      await world.pg.query(
        `INSERT INTO public.events
           (guild_id, channel_id, name, event_date, created_by, thread_id, thread_status)
         SELECT guild_id, channel_id, name, event_date, created_by, $2, 'missing'
         FROM public.events WHERE id = $1`,
        [id, fakeId()],
      );
      const threadId = memberPost(forum);

      await world.send(linkIn(threadId, forum));

      expect(world.discord.lastReply()).toContain("More than one");
      expect(await world.events("thread_status = 'missing'")).toHaveLength(2);
      expect(await world.events(`thread_id = '${threadId}'`)).toEqual([]);
    });

    it("moves the row to someone else's post, with its tasks in a new overview", async () => {
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
      expect(
        world.discord.messageIds.has(event?.overview_message_id ?? ""),
      ).toBe(true);
      expect(overviewTexts(sent()).at(-1)).toContain("Book the room");
      expect(world.discord.lastReply()).toContain("reminders start again");
    });

    it("takes the bot's own post and edits its first message", async () => {
      const { forum, id, sent } = await lostEvent();
      const threadId = world.discord.addThread({
        guild_id: GUILD_ID,
        parent_id: forum,
        name: "Fall Social",
        owner_id: APP_ID,
      });
      world.discord.messageIds.add(threadId);

      await world.send(linkIn(threadId, forum));

      expect((await world.events())[0]).toMatchObject({
        id,
        thread_id: threadId,
        overview_message_id: threadId,
      });
      expect(overviewTexts(sent()).at(-1)).toContain("Book the room");
      expect(
        sent().filter((request) => MESSAGES_POST.test(request.path)),
      ).toEqual([]);
    });

    it("repairs the row, with no second overview, inside a post that still exists", async () => {
      const forum = await world.addManagedForum();
      await world.send(create());
      const [event] = await world.events();
      const threadId = event?.thread_id ?? "";
      await world.insertTask(event?.id ?? "");
      await world.pg.query(
        `UPDATE public.events SET thread_status = 'missing'`,
      );
      const before = world.discord.requests.length;

      await world.send(linkIn(threadId, forum));

      const sent = world.discord.requests.slice(before);
      expect((await world.events())[0]).toMatchObject({
        id: event?.id,
        thread_id: threadId,
        thread_status: "active",
      });
      expect(
        sent.filter((request) => MESSAGES_POST.test(request.path)),
      ).toEqual([]);
      expect(overviewTexts(sent).at(-1)).toContain("Book the room");
    });

    it("leaves it alone for a post with another title or date", async () => {
      const { forum, id } = await lostEvent();

      await world.send(linkIn(memberPost(forum, "Something Else"), forum));
      await world.send(linkIn(memberPost(forum), forum, OTHER_DATE));

      expect(await world.events()).toHaveLength(3);
      expect((await world.events(`id = '${id}'`))[0]?.thread_status).toBe(
        "missing",
      );
    });

    it("does not take up a closed event", async () => {
      const { forum, id } = await lostEvent();
      await world.pg.query(
        `UPDATE public.events SET status = 'closed' WHERE id = $1`,
        [id],
      );

      await world.send(linkIn(memberPost(forum), forum));

      expect(await world.events()).toHaveLength(1);
      expect(world.discord.lastReply()).toContain("closed");
    });

    it("says so when the row changed just before the write", async () => {
      const { forum } = await lostEvent();
      world.failDb(/^SQL update events/, 200, 1);

      await world.send(linkIn(memberPost(forum), forum));

      expect(world.discord.lastReply()).toContain("changed just now");
    });
  });

  describe("/event link with the event chosen", () => {
    function linkChosen(
      eventId: unknown,
      threadId: string,
      forum: string,
      fields: Record<string, unknown> = officerFields,
    ) {
      return eventCommand(
        "link",
        { event: { type: 3, value: eventId } },
        { ...fields, ...inThread(threadId, forum) },
      );
    }

    it("is registered with an optional date and a picker", () => {
      const event = COMMANDS.find((command) => command.name === "event");
      const sub = event?.options?.find((option) => option.name === "link");
      expect(sub?.options?.map((option) => option.name)).toEqual([
        "date",
        "event",
      ]);
      expect(sub?.options?.[0]?.required).toBe(false);
      expect(sub?.options?.[1]?.autocomplete).toBe(true);
      expect(sub?.options?.[1]?.required).toBeUndefined();
    });

    it("moves the row to a post with another title, keeping its name and tasks", async () => {
      const { forum, id, sent } = await lostEvent();
      const threadId = memberPost(forum, "Replacement Thread");

      await world.send(linkChosen(id, threadId, forum));

      const [event, ...others] = await world.events();
      expect(others).toEqual([]);
      expect(event).toMatchObject({
        id,
        name: "Fall Social",
        thread_id: threadId,
        thread_status: "active",
      });
      expect(overviewTexts(sent()).at(-1)).toContain("Book the room");
      expect(world.discord.lastReply()).toContain("reminders start again");
    });

    it("works for an event whose date has passed, and asks for no date", async () => {
      const { forum, id } = await lostEvent();
      await world.pg.query(
        `UPDATE public.events SET event_date = '2020-01-01' WHERE id = $1`,
        [id],
      );
      const threadId = memberPost(forum, "Replacement Thread");

      await world.send(linkChosen(id, threadId, forum));

      expect((await world.events())[0]?.thread_id).toBe(threadId);
    });

    it("takes up a pending event too", async () => {
      const forum = await world.addManagedForum();
      world.discord.fail("POST", THREADS_POST, FORBIDDEN, 1);
      await world.send(create());
      const [pending] = await world.events();
      const threadId = memberPost(forum, "Replacement Thread");

      await world.send(linkChosen(pending?.id, threadId, forum));

      expect((await world.events())[0]).toMatchObject({
        id: pending?.id,
        thread_id: threadId,
        thread_status: "active",
      });
      expect(world.discord.lastReply()).not.toContain("reminders start again");
    });

    it("repairs the row inside its own post, whatever its title", async () => {
      const forum = await world.addManagedForum();
      await world.send(create());
      const [event] = await world.events();
      await world.pg.query(
        `UPDATE public.events SET thread_status = 'missing'`,
      );
      const before = world.discord.requests.length;

      await world.send(linkChosen(event?.id, event?.thread_id ?? "", forum));

      expect((await world.events())[0]?.thread_status).toBe("active");
      expect(
        world.discord.requests
          .slice(before)
          .filter((request) => MESSAGES_POST.test(request.path)),
      ).toEqual([]);
    });

    it.each([
      ["an unknown ID", () => "99999999-9999-4999-8999-999999999999"],
      ["a value that is no ID", () => "not-an-id"],
    ])("refuses %s", async (_label, value) => {
      const forum = await world.addManagedForum();
      const threadId = memberPost(forum);

      await world.send(linkChosen(value(), threadId, forum));

      expect(await world.events()).toEqual([]);
      expect(world.discord.lastReply()).toBe(REFUSED.message);
    });

    it("refuses a deleted event", async () => {
      const { forum, id } = await lostEvent();
      await world.pg.query(`UPDATE public.events SET deleted_at = now()`);

      await world.send(linkChosen(id, memberPost(forum), forum));

      expect(world.discord.lastReply()).toBe(REFUSED.message);
    });

    it("refuses another guild's event", async () => {
      const forum = await world.addManagedForum();
      const otherForum = await world.addManagedForum(OTHER_GUILD);
      const { rows } = await world.pg.query<{ id: string }>(
        `INSERT INTO public.events
           (guild_id, channel_id, name, event_date, created_by, thread_id, thread_status)
         VALUES ($1, $2, 'Theirs', '2099-01-15', $3, $4, 'missing') RETURNING id`,
        [OTHER_GUILD, otherForum, MEMBER_ID, fakeId()],
      );
      const threadId = memberPost(forum);

      await world.send(linkChosen(rows[0]?.id, threadId, forum));

      expect(world.discord.lastReply()).toBe(REFUSED.message);
      expect(await world.events("thread_status = 'active'")).toEqual([]);
    });

    it("refuses someone who is not an officer, before reading any event", async () => {
      const { forum, id } = await lostEvent();
      const threadId = memberPost(forum);
      const before = world.dbRequests().length;

      const ran = await world.send(
        linkChosen(id, threadId, forum, { member: PLAIN_MEMBER }),
      );

      expect(ran.reply.data?.content).toBe(REFUSED.message);
      expect(
        world
          .dbRequests()
          .slice(before)
          .filter((request) => /\/events|"events"/.test(request)),
      ).toEqual([]);
    });

    it("refuses a closed event", async () => {
      const { forum, id } = await lostEvent();
      await world.pg.query(`UPDATE public.events SET status = 'closed'`);

      await world.send(linkChosen(id, memberPost(forum), forum));

      expect((await world.events())[0]?.thread_status).toBe("missing");
      expect(world.discord.lastReply()).toContain("is closed");
    });

    it("refuses an event that still has its post, and points at it", async () => {
      const forum = await world.addManagedForum();
      await world.send(create());
      const [event] = await world.events();

      await world.send(linkChosen(event?.id, memberPost(forum), forum));

      expect((await world.events())[0]?.thread_id).toBe(event?.thread_id);
      expect(world.discord.lastReply()).toContain(
        `<#${event?.thread_id ?? ""}>`,
      );
    });

    it("refuses a post in another forum, since the event's forum never changes", async () => {
      const { forum, id } = await lostEvent();
      const other = await world.addManagedForum();

      await world.send(linkChosen(id, memberPost(other), other));

      expect((await world.events())[0]?.thread_status).toBe("missing");
      expect(world.discord.lastReply()).toContain(`<#${forum}>`);
    });

    it("refuses a post another event holds", async () => {
      const { forum, id } = await lostEvent();
      await world.send(create({ name: "Other Event" }));
      const holder = (await world.events("name = 'Other Event'"))[0];

      await world.send(linkChosen(id, holder?.thread_id ?? "", forum));

      expect((await world.events(`id = '${id}'`))[0]?.thread_status).toBe(
        "missing",
      );
      expect(world.discord.lastReply()).toContain("already belongs");
    });

    it("refuses outside a managed forum's post", async () => {
      const { id } = await lostEvent();
      const channel = fakeId();

      await world.send(
        eventCommand(
          "link",
          { event: { type: 3, value: id } },
          { ...officerFields, channel: { id: channel, type: 0 } },
        ),
      );

      expect((await world.events())[0]?.thread_status).toBe("missing");
      expect(world.discord.lastReply()).toContain("Run this inside a post");
    });

    it("asks for a date or an event when given neither", async () => {
      const forum = await world.addManagedForum();
      const threadId = memberPost(forum);

      await world.send(
        eventCommand(
          "link",
          {},
          {
            ...officerFields,
            ...inThread(threadId, forum),
          },
        ),
      );

      expect(await world.events()).toEqual([]);
      expect(world.discord.lastReply()).toContain("event option");
    });
  });

  it("shows a pending event's tasks in an overview posted to someone else's post", async () => {
    const forum = await world.addManagedForum();
    world.discord.fail("POST", THREADS_POST, FORBIDDEN, 1);
    await world.send(create());
    const [pending] = await world.events();
    await world.insertTask(pending?.id ?? "");
    const before = world.discord.requests.length;

    await world.send(linkIn(memberPost(forum), forum));

    const edits = overviewTexts(world.discord.requests.slice(before));
    expect(edits.at(-1)).toContain("Book the room");
    expect(edits.at(-1)).not.toContain("No tasks yet");
  });
});
