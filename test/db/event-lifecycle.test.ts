import { describe, expect, it } from "vitest";
import { getEvent } from "../../src/db/events.ts";
import {
  claimReminder,
  listReminderCandidates,
} from "../../src/db/reminders.ts";
import { parseIsoDate, type DateOnly } from "../../src/lib/dates.ts";
import { COMMANDS } from "../../src/handlers/registry.ts";
import { listEventTasks } from "../../src/db/tasks.ts";
import { deleteVersion } from "../../src/handlers/event.ts";
import { REFUSED } from "../../src/lib/permissions.ts";
import type { Failure } from "../support/discord-server.ts";
import { UNKNOWN_MESSAGE } from "../support/discord-server.ts";
import {
  eventCommand,
  eventWorld,
  inThread,
  OTHER_GUILD,
} from "../support/event-world.ts";
import { HOSTILE_TEXT, hasLiveSyntax } from "../support/hostile-text.ts";
import {
  ADMIN,
  ADMINISTRATOR,
  autocompletePayload,
  commandPayload,
  componentPayload,
  GUILD_ID,
  member,
  MEMBER_ID,
  OFFICER,
  PLAIN_MEMBER,
} from "../support/interactions.ts";
import { fakeId } from "../support/ids.ts";
import { HOSTILE_STRINGS } from "../support/hostile-text.ts";

const world = eventWorld();

const MESSAGES_POST = /^\/channels\/[0-9]+\/messages$/;
const MESSAGE_EDIT = /^\/channels\/[0-9]+\/messages\/[0-9]+$/;
const SERVER_ERROR: Failure = { kind: "respond", status: 500 };
const UNKNOWN_EVENT = "99999999-9999-4999-8999-999999999999";
const officerFields = { member: OFFICER };
const NON_OFFICERS = [
  ["a member with no role", PLAIN_MEMBER],
  ["a member with another role", member({ roles: [fakeId()] })],
  ["a member whose roles are malformed", member({ roles: ["x"] })],
] as const;

interface Seed {
  name?: string;
  date?: string;
  guildId?: string;
  forum?: string;
  status?: "active" | "closed";
  threadStatus?: "pending" | "active" | "missing";
  deleted?: boolean;
  noOverview?: boolean;
}

interface Seeded {
  id: string;
  forum: string;
  threadId: string | null;
  overviewId: string | null;
}

/** A row in any state, with the post Discord would hold for it. */
async function seed({
  name = "Fall Social",
  date = "2099-01-15",
  guildId = GUILD_ID,
  forum,
  status = "active",
  threadStatus = "active",
  deleted = false,
  noOverview = false,
}: Seed = {}): Promise<Seeded> {
  const forumId = forum ?? (await world.addManagedForum(guildId));
  const threadId =
    threadStatus === "pending"
      ? null
      : world.discord.addThread({
          guild_id: guildId,
          parent_id: forumId,
          name,
        });
  const overviewId = threadId === null || noOverview ? null : fakeId();
  if (overviewId !== null) {
    world.discord.messageIds.add(overviewId);
  }
  const { rows } = await world.pg.query<{ id: string }>(
    `INSERT INTO public.events
       (guild_id, channel_id, name, event_date, created_by, thread_id,
        overview_message_id, status, thread_status, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::public.event_status,
       $9::public.thread_status, CASE WHEN $10::boolean THEN now() END)
     RETURNING id`,
    [
      guildId,
      forumId,
      name,
      date,
      MEMBER_ID,
      threadId,
      overviewId,
      status,
      threadStatus,
      deleted,
    ],
  );
  return {
    id: (rows[0] as { id: string }).id,
    forum: forumId,
    threadId,
    overviewId,
  };
}

function dateOnly(value: string): DateOnly {
  const date = parseIsoDate(value);
  if (date === null) {
    throw new Error("bad test date");
  }
  return date;
}

function eventOption(value: unknown) {
  return { event: { type: 3, value } };
}

function picker(
  sub: string,
  typed: unknown,
  fields: Record<string, unknown> = officerFields,
) {
  return autocompletePayload("event", typed, {
    ...fields,
    data: {
      type: 1,
      name: "event",
      options: [
        {
          type: 1,
          name: sub,
          options: [{ name: "event", type: 3, value: typed, focused: true }],
        },
      ],
    },
  });
}

interface Choice {
  name: string;
  value: string;
}

async function choices(
  sub: string,
  typed: unknown,
  fields?: Record<string, unknown>,
): Promise<Choice[]> {
  const ran = await world.send(picker(sub, typed, fields));
  expect(ran.reply.type).toBe(8);
  expect(ran.deferred).toBe(false);
  return ran.reply.data?.choices as Choice[];
}

/** What the button shows for the row as it stands. No row gets a fingerprint of nothing. */
async function confirmId(eventId: unknown): Promise<string> {
  const key = { guildId: GUILD_ID, eventId: String(eventId) };
  const event = await getEvent(world.db, key);
  const tasks = await listEventTasks(world.db, key);
  const version =
    event.ok && event.value !== null && tasks.ok
      ? deleteVersion(event.value, tasks.value)
      : "0".repeat(16);
  return `event.delete.confirm:${String(eventId)}:${version}`;
}

async function confirmClick(
  eventId: unknown,
  fields: Record<string, unknown> = officerFields,
) {
  return componentPayload(await confirmId(eventId), fields);
}

const SUBS_WITH_PICKER = [
  "link",
  "status",
  "close",
  "delete",
  "assign",
  "unassign",
  "pickup",
];

describe("the event picker", () => {
  it("is registered on exactly the commands that have a route for it", () => {
    const event = COMMANDS.find((command) => command.name === "event") as {
      options: { name: string; options?: { autocomplete?: boolean }[] }[];
    };
    const withPicker = event.options
      .filter((sub) => sub.options?.some((option) => option.autocomplete))
      .map((sub) => sub.name);

    expect(withPicker.sort()).toEqual([...SUBS_WITH_PICKER].sort());
  });

  describe.each(SUBS_WITH_PICKER)("on /event %s", (sub) => {
    it("offers name, date and short ID, and submits the full ID", async () => {
      const event = await seed({ name: "Fall Social", date: "2099-03-04" });

      expect(await choices(sub, "fall")).toEqual([
        {
          name: `Fall Social - 2099-03-04 - ${event.id.slice(0, 8)}`,
          value: event.id,
        },
      ]);
    });

    it("writes nothing and calls Discord for nothing", async () => {
      await seed();
      const before = world.dbRequests().length;

      await choices(sub, "fall");

      expect(world.discord.requests).toEqual([]);
      const made = world.dbRequests().slice(before);
      expect(
        made.filter((request) => !/^(GET |SQL select )/.test(request)),
      ).toEqual([]);
      // The config read, and one search.
      expect(made).toHaveLength(2);
    });

    it.each(NON_OFFICERS)("offers %s nothing", async (_label, who) => {
      await seed();
      const before = world.dbRequests().length;

      expect(await choices(sub, "", { member: who })).toEqual([]);

      expect(
        world
          .dbRequests()
          .slice(before)
          .filter((request) => /\/events|"events"/.test(request)),
      ).toEqual([]);
    });

    it("offers no deleted event and no other guild's event", async () => {
      await seed({ name: "Gone", deleted: true });
      await seed({ name: "Theirs", guildId: OTHER_GUILD });

      expect(await choices(sub, "")).toEqual([]);
    });
  });

  it("shows an administrator and an admin the choices as well", async () => {
    await seed();

    expect(await choices("status", "", { member: ADMIN })).toHaveLength(1);
    expect(await choices("status", "", { member: ADMINISTRATOR })).toHaveLength(
      1,
    );
  });

  it("offers at most 25 choices", async () => {
    const forum = await world.addManagedForum();
    for (let index = 0; index < 30; index++) {
      await seed({ forum, name: `Event ${String(index)}` });
    }

    expect(await choices("status", "Event")).toHaveLength(25);
  });

  it("says when an event is closed", async () => {
    await seed({ status: "closed" });

    expect((await choices("close", ""))[0]?.name).toContain(" - closed");
  });

  it("tells lookalike names apart", async () => {
    const forum = await world.addManagedForum();
    const date = "2099-03-04";
    const real = await seed({ forum, name: "Officer Meeting", date });
    const fake = await seed({ forum, name: "Offic\u0435r Meeting", date });

    const offered = await choices("delete", "");

    expect(offered).toHaveLength(2);
    expect(new Set(offered.map((choice) => choice.name)).size).toBe(2);
    expect(offered.map((choice) => choice.value).sort()).toEqual(
      [real.id, fake.id].sort(),
    );
    expect(offered.find((choice) => choice.value === fake.id)?.name).toContain(
      fake.id.slice(0, 8),
    );
  });

  it("stays within Discord's limit at the longest name", async () => {
    await seed({ name: "😀".repeat(50) });
    await seed({ name: "x".repeat(100) });

    const offered = await choices("status", "");

    expect(offered).toHaveLength(2);
    for (const choice of offered) {
      expect(choice.name.length).toBeLessThanOrEqual(100);
      expect(choice.name).toMatch(/ - 2099-01-15 - [0-9a-f]{8}$/u);
    }
  });

  it.each(HOSTILE_TEXT)(
    "shows a stored hostile name inertly: %s",
    async (_label, name) => {
      await seed({ name: name.slice(0, 100) });

      const [choice] = await choices("status", "");

      expect(choice?.name).not.toMatch(/[@<>#[\]`|*~:/\\.\n\r]/u);
    },
  );

  it("keeps working for a stored name with nothing visible", async () => {
    const event = await seed({ name: "\u200B\u3164" });

    const [choice] = await choices("status", "");

    expect(choice?.value).toBe(event.id);
  });

  describe("what is typed never shapes the query", () => {
    it.each([
      "x%,deleted_at.not.is.null",
      "x,guild_id.neq.0",
      "x)",
      ")",
      "a.b",
      'x","y',
      "x*",
      "%",
      "_",
      "\\",
      "__proto__",
    ])("%j matches only literally, in this guild", async (typed) => {
      await seed({ name: "Plain event" });
      await seed({ name: "Gone", deleted: true });
      await seed({ name: "Theirs", guildId: OTHER_GUILD });

      expect(await choices("status", typed)).toEqual([]);
    });

    it("finds a literal percent sign and nothing else for it", async () => {
      const forum = await world.addManagedForum();
      const match = await seed({ forum, name: "Half 50% off" });
      await seed({ forum, name: "Plain event" });

      expect((await choices("status", "%")).map((c) => c.value)).toEqual([
        match.id,
      ]);
    });

    it.each([
      ["NUL", "x\u0000y"],
      ["a lone surrogate", "x\ud800y"],
      ["too long", "x".repeat(101)],
      ["not text", 5],
    ])("asks the database nothing for %s", async (_label, typed) => {
      await seed();
      const before = world.dbRequests().length;

      expect(await choices("status", typed)).toEqual([]);

      expect(
        world
          .dbRequests()
          .slice(before)
          .filter((request) => /\/events|"events"/.test(request)),
      ).toEqual([]);
    });
  });

  it("answers within Discord's window on a crowded table", async () => {
    const forum = await world.addManagedForum();
    await world.pg.query(
      `INSERT INTO public.events
         (guild_id, channel_id, name, event_date, created_by)
       SELECT $1, $2, 'Event ' || n, '2099-01-15', $3
       FROM generate_series(1, 3000) AS n`,
      [GUILD_ID, forum, MEMBER_ID],
    );

    const started = performance.now();
    const offered = await choices(
      "status",
      `${"%_*".repeat(30)}Event`.slice(0, 100),
    );
    const common = await choices("status", "Event");
    const elapsed = performance.now() - started;

    expect(offered).toEqual([]);
    expect(common).toHaveLength(25);
    expect(elapsed).toBeLessThan(2500);

    // With another guild's rows in the table, this guild's are found by index.
    const theirs = await world.addManagedForum(OTHER_GUILD);
    await world.pg.query(
      `INSERT INTO public.events
         (guild_id, channel_id, name, event_date, created_by)
       SELECT $1, $2, 'Event ' || n, '2099-01-15', $3
       FROM generate_series(1, 30000) AS n`,
      [OTHER_GUILD, theirs, MEMBER_ID],
    );
    await world.pg.exec("ANALYZE public.events");
    const plan = await world.pg.query<{ "QUERY PLAN": string }>(
      `EXPLAIN SELECT id, name, event_date, status FROM public.events
       WHERE guild_id = '${GUILD_ID}' AND deleted_at IS NULL AND name ILIKE '%x%'
       ORDER BY event_date, id LIMIT 25`,
    );
    const shape = JSON.stringify(plan.rows);
    expect(shape).toMatch(/Index/u);
    expect(shape).not.toMatch(/Seq Scan/u);
  });

  it("reports a database failure as no choices", async () => {
    await seed();
    world.failDb(/^SQL select .* from events/);

    expect(await choices("status", "")).toEqual([]);
  });
});

/** Every way to name an event that must look the same to the caller. */
function unusableValues(): [string, () => Promise<string>][] {
  return [
    ["a value never offered", () => Promise.resolve(UNKNOWN_EVENT)],
    ["a deleted event's ID", async () => (await seed({ deleted: true })).id],
    [
      "another guild's event",
      async () => (await seed({ guildId: OTHER_GUILD })).id,
    ],
    ...HOSTILE_STRINGS.map((hostile): [string, () => Promise<string>] => [
      `the malformed value ${JSON.stringify(hostile)}`,
      () => Promise.resolve(hostile),
    ]),
  ];
}

describe.each(["status", "close", "delete"])(
  "/event %s, choosing the event",
  (sub) => {
    it.each(unusableValues())("refuses %s", async (_label, value) => {
      const bystander = await seed({ name: "Bystander" });
      const hostile = await value();
      const before = world.dbRequests().length;

      const ran = await world.send(
        eventCommand(sub, eventOption(hostile), officerFields),
      );

      // The row is read after the acknowledgement, which is private.
      expect(ran.reply.type).toBe(5);
      expect(ran.reply.data?.flags).toBe(64);
      expect(world.discord.lastReply()).toBe(REFUSED.message);
      expect(world.discord.publicWrites()).toEqual([]);
      expect(
        world
          .dbRequests()
          .slice(before)
          .filter(
            (request) =>
              !/^(GET |SQL select )/.test(request) &&
              !request.includes("public.claim_interaction("),
          ),
      ).toEqual([]);
      expect((await world.events(`id = '${bystander.id}'`))[0]).toMatchObject({
        status: "active",
        deleted_at: null,
      });
    });

    it("asks the database nothing for a value that is no ID", async () => {
      await seed();
      const before = world.dbRequests().length;

      await world.send(
        eventCommand(sub, eventOption("x\u0000y"), officerFields),
      );

      expect(
        world
          .dbRequests()
          .slice(before)
          .filter((request) => /\/events|"events"/.test(request)),
      ).toEqual([]);
    });

    it("tells an officer what to do outside a post when no event is named", async () => {
      await seed();
      const before = world.dbRequests().length;

      await world.send(eventCommand(sub, {}, officerFields));

      expect(world.discord.lastReply()).toContain("choose the event");
      expect(world.discord.publicWrites()).toEqual([]);
      // A channel that is no thread can't be a post, so there is nothing to look up.
      expect(
        world
          .dbRequests()
          .slice(before)
          .filter((request) => /\/events|"events"/.test(request)),
      ).toEqual([]);
    });

    it("gives no such hint to someone who is not an officer", async () => {
      const ran = await world.send(
        eventCommand(sub, {}, { member: PLAIN_MEMBER }),
      );

      expect(ran.reply.data?.content).toBe(REFUSED.message);
      expect(ran.deferred).toBe(false);
    });

    it("acknowledges an officer without reading the event first", async () => {
      const event = await seed();
      world.failDb(/^SQL select .* from events/);

      const ran = await world.send(
        eventCommand(sub, eventOption(event.id), officerFields),
      );

      world.clearDbFailures();
      // With the row read first, this failure would answer at once and defer nothing.
      expect(ran.reply.type).toBe(5);
      expect(ran.deferred).toBe(true);
      expect(world.discord.lastReply()).toContain("Something went wrong");
    });

    it("reads no event at all for someone who is not an officer", async () => {
      const event = await seed();
      const before = world.dbRequests().length;

      await world.send(
        eventCommand(sub, eventOption(event.id), { member: PLAIN_MEMBER }),
      );

      expect(
        world
          .dbRequests()
          .slice(before)
          .filter((request) => /\/events|"events"/.test(request)),
      ).toEqual([]);
    });

    it("gives the same hint in a post that belongs to no event", async () => {
      const forum = await world.addManagedForum();
      const threadId = world.discord.addThread({
        guild_id: GUILD_ID,
        parent_id: forum,
        name: "Not an event",
      });

      await world.send(
        eventCommand(
          sub,
          {},
          { ...officerFields, ...inThread(threadId, forum) },
        ),
      );

      expect(world.discord.lastReply()).toContain("choose the event");
    });

    it.each(NON_OFFICERS)(
      "refuses %s the same way, for a real event",
      async (_label, who) => {
        const event = await seed();

        const ran = await world.send(
          eventCommand(sub, eventOption(event.id), { member: who }),
        );

        expect(ran.reply.data?.content).toBe(REFUSED.message);
        expect(ran.deferred).toBe(false);
        expect(world.discord.requests).toEqual([]);
        expect((await world.events())[0]).toMatchObject({
          status: "active",
          deleted_at: null,
        });
      },
    );

    it("refuses a non-officer inside the event's own post", async () => {
      const event = await seed();

      const ran = await world.send(
        eventCommand(
          sub,
          {},
          {
            member: PLAIN_MEMBER,
            ...inThread(event.threadId ?? "", event.forum),
          },
        ),
      );

      expect(ran.reply.data?.content).toBe(REFUSED.message);
    });
  },
);

describe("/event status", () => {
  async function status(
    options: Record<string, { type: number; value: unknown }>,
    fields: Record<string, unknown> = officerFields,
  ) {
    return world.send(eventCommand("status", options, fields));
  }

  it("answers privately and posts nothing", async () => {
    const event = await seed();
    await world.insertTask(event.id);

    const ran = await status(eventOption(event.id));

    expect(ran.reply).toEqual({ type: 5, data: { flags: 64 } });
    expect(world.discord.publicWrites()).toEqual([]);
    const reply = world.discord.lastReply();
    expect(reply).toContain("**Fall Social**");
    expect(reply).toContain("Tasks: 1 open, 0 done");
    expect(reply).toContain(`<#${event.threadId ?? ""}>`);
    expect(reply).toContain(event.id.slice(0, 8));
  });

  it("defaults to the post it is run in", async () => {
    await seed({ name: "Another" });
    const event = await seed({ name: "This One" });

    await status(
      {},
      {
        ...officerFields,
        ...inThread(event.threadId ?? "", event.forum),
      },
    );

    expect(world.discord.lastReply()).toContain("**This One**");
  });

  it("prefers the event named over the post it is run in", async () => {
    const here = await seed({ name: "This One" });
    const named = await seed({ name: "Named" });

    await status(eventOption(named.id), {
      ...officerFields,
      ...inThread(here.threadId ?? "", here.forum),
    });

    expect(world.discord.lastReply()).toContain("**Named**");
  });

  it("does not take a deleted event from the post it is run in", async () => {
    const event = await seed({ deleted: true });

    await status(
      {},
      {
        ...officerFields,
        ...inThread(event.threadId ?? "", event.forum),
      },
    );

    expect(world.discord.lastReply()).toContain("choose the event");
  });

  it("shows an event in a removed forum, with a note", async () => {
    const event = await seed();
    await world.setForumStatus(event.forum, "removed");

    await status(eventOption(event.id));

    expect(world.discord.lastReply()).toContain("no longer managed");
    expect(world.discord.publicWrites()).toEqual([]);
  });

  it("explains an event with no post yet", async () => {
    const event = await seed({ threadStatus: "pending" });

    await status(eventOption(event.id));

    expect(world.discord.lastReply()).toContain("none yet");
  });

  it("explains an event whose post has gone", async () => {
    const event = await seed({ threadStatus: "missing" });

    await status(eventOption(event.id));

    expect(world.discord.lastReply()).toContain("can no longer be found");
    expect(world.discord.lastReply()).toContain("/event link");
    expect(world.discord.lastReply()).toContain("/event create");
    expect(world.discord.lastReply()).toContain("tasks are kept");
  });

  it("offers no way back for a closed event whose post has gone", async () => {
    const event = await seed({ threadStatus: "missing", status: "closed" });

    await status(eventOption(event.id));

    expect(world.discord.lastReply()).toContain("can no longer be found");
    expect(world.discord.lastReply()).not.toContain("/event link");
  });

  it("shows an officer a forum they can't see, as documented", async () => {
    // Nothing in the payload says which forums an officer can see, and nothing asks.
    const event = await seed();
    const before = world.discord.requests.length;

    await status(eventOption(event.id));

    expect(
      world.discord.requests
        .slice(before)
        .filter((request) => request.path.includes(event.forum)),
    ).toEqual([]);
    expect(world.discord.lastReply()).toContain("Fall Social");
  });

  it.each(HOSTILE_TEXT)(
    "keeps a stored name inert: %s",
    async (_label, name) => {
      const event = await seed({ name: name.slice(0, 100) });

      await status(eventOption(event.id));

      const [title = ""] = (world.discord.lastReply() ?? "").split("\n");
      expect(hasLiveSyntax(title.slice(2, -2))).toBe(false);
    },
  );

  it("never shows a name any member controls", async () => {
    const event = await seed();

    await status(eventOption(event.id), {
      member: {
        ...OFFICER,
        nick: "CanaryNickname",
        user: { id: MEMBER_ID, username: "CanaryNickname" },
      },
    });

    expect(JSON.stringify(world.discord.requests)).not.toContain("Canary");
  });

  it("reports a database failure with no detail", async () => {
    const event = await seed();
    world.failDb(/^SQL select .* from tasks/);

    await status(eventOption(event.id));

    expect(world.discord.lastReply()).toContain("Something went wrong");
  });

  it("shows an open task when more than a hundred done ones exist", async () => {
    const event = await seed();
    // Quotas now stop this many, so these stand for rows older than them.
    await world.pg.exec("SET session_replication_role = replica");
    await world.pg.query(
      `INSERT INTO public.tasks
         (event_id, guild_id, assignee_id, description, due_date, created_by, status,
          completed_at)
       SELECT $1::uuid, $2, $3, 'Done ' || n, '2099-01-01', $3, 'done', now()
       FROM generate_series(1, 101) AS n`,
      [event.id, GUILD_ID, MEMBER_ID],
    );
    await world.insertTask(event.id, { description: "Still to do" });
    await world.pg.exec("RESET session_replication_role");

    await status(eventOption(event.id));

    const reply = world.discord.lastReply() ?? "";
    expect(reply).toContain("Still to do");
    expect(reply).toContain("and more");
  });

  it("offers the live event first when more than 25 finished ones match", async () => {
    const forum = await world.addManagedForum();
    await world.pg.query(
      `INSERT INTO public.events
         (guild_id, channel_id, name, event_date, created_by, status)
       SELECT $1, $2, 'Social ' || n, '2099-06-01', $3, 'closed'
       FROM generate_series(1, 30) AS n`,
      [GUILD_ID, forum, MEMBER_ID],
    );
    const live = await seed({ forum, name: "Social", date: "2099-01-01" });

    expect((await choices("status", "Social"))[0]?.value).toBe(live.id);
  });

  it("stays within one message for a very long event", async () => {
    const event = await seed();
    for (let index = 0; index < 60; index++) {
      await world.insertTask(event.id, { description: "*".repeat(900) });
    }

    await status(eventOption(event.id));

    const reply = world.discord.lastReply() ?? "";
    expect(reply.length).toBeLessThanOrEqual(2000);
    expect(reply).toContain("more not shown");
  });
});

describe("/task changes reach the overview", () => {
  it("redraws the overview when a task is marked done", async () => {
    const event = await seed();
    const task = await world.insertTask(event.id, { assignee: MEMBER_ID });

    await world.send(
      commandPayload(
        "task",
        { member: PLAIN_MEMBER },
        {
          options: [
            {
              type: 1,
              name: "done",
              options: [{ type: 3, name: "task", value: task }],
            },
          ],
        },
      ),
    );

    const edit = world.discord.requests.find(
      (request) =>
        request.method === "PATCH" && MESSAGE_EDIT.test(request.path),
    );
    expect(edit?.path).toContain(event.overviewId);
    expect(edit?.body?.content).toContain("Tasks: 0 open, 1 done");
    expect(edit?.body?.allowed_mentions).toEqual({ parse: [], users: [] });
  });

  it("still marks it done when the overview can't be redrawn", async () => {
    const event = await seed();
    const task = await world.insertTask(event.id, { assignee: MEMBER_ID });
    world.discord.fail("PATCH", MESSAGE_EDIT, SERVER_ERROR);

    await world.send(
      commandPayload(
        "task",
        { member: PLAIN_MEMBER },
        {
          options: [
            {
              type: 1,
              name: "done",
              options: [{ type: 3, name: "task", value: task }],
            },
          ],
        },
      ),
    );

    const { rows } = await world.pg.query<{ status: string }>(
      `SELECT status FROM public.tasks WHERE id = $1`,
      [task],
    );
    expect(rows[0]?.status).toBe("done");
    expect(world.discord.lastReply()).toContain("Marked done");
  });
});

describe("/event list", () => {
  const list = (fields: Record<string, unknown> = officerFields) =>
    world.send(eventCommand("list", {}, fields));

  it("lists every managed forum's live events, privately", async () => {
    const one = await seed({ name: "In One" });
    const two = await seed({ name: "In Two", status: "closed" });
    await seed({ name: "Gone", deleted: true });
    await seed({ name: "Theirs", guildId: OTHER_GUILD });

    const ran = await list();

    expect(ran.reply).toEqual({ type: 5, data: { flags: 64 } });
    expect(world.discord.publicWrites()).toEqual([]);
    const reply = world.discord.lastReply();
    expect(reply).toContain("**In One**");
    expect(reply).toContain(`<#${one.threadId ?? ""}>`);
    expect(reply).toContain("**In Two**");
    expect(reply).toContain(two.id.slice(0, 8));
    expect(reply).not.toContain("Gone");
    expect(reply).not.toContain("Theirs");
  });

  it("points at the next step for an event that lost its post", async () => {
    await seed({ threadStatus: "missing" });

    await world.send(eventCommand("list", {}, officerFields));

    expect(world.discord.lastReply()).toContain(
      "post missing and reminders off, see /event status",
    );
  });

  it("marks an event in a removed forum", async () => {
    const event = await seed();
    await world.setForumStatus(event.forum, "removed");

    await list();

    expect(world.discord.lastReply()).toContain("forum no longer managed");
  });

  it("says when there are none", async () => {
    await list();

    expect(world.discord.lastReply()).toContain("no events yet");
  });

  it("stays within one message, keeps active events and counts the rest", async () => {
    const forum = await world.addManagedForum();
    for (let index = 0; index < 50; index++) {
      await seed({
        forum,
        name: `${"*".repeat(90)} ${String(index)}`,
        status: index === 49 ? "active" : "closed",
        date: `2099-01-${String((index % 28) + 1).padStart(2, "0")}`,
      });
    }

    await list();

    const reply = world.discord.lastReply() ?? "";
    expect(reply.length).toBeLessThanOrEqual(2000);
    expect(reply).toMatch(/…and [0-9]+ more not shown\./u);
    expect(reply.split("\n")[1]).toContain(" 49**");
  });

  it.each(HOSTILE_TEXT)(
    "keeps a stored name inert: %s",
    async (_label, name) => {
      await seed({ name: name.slice(0, 100) });

      await list();

      const line = (world.discord.lastReply() ?? "").split("\n")[1] ?? "";
      expect(
        hasLiveSyntax(line.replace(/<#[0-9]+>/u, "").replaceAll("**", "")),
      ).toBe(false);
    },
  );

  it("shows a live event when more than a hundred finished ones exist", async () => {
    const forum = await world.addManagedForum();
    await world.pg.query(
      `INSERT INTO public.events
         (guild_id, channel_id, name, event_date, created_by, status)
       SELECT $1, $2, 'Old ' || n, '2099-01-01', $3, 'closed'
       FROM generate_series(1, 101) AS n`,
      [GUILD_ID, forum, MEMBER_ID],
    );
    await seed({ forum, name: "Next Week", date: "2099-12-31" });

    await list();

    const reply = world.discord.lastReply() ?? "";
    expect(reply.split("\n")[1]).toContain("**Next Week**");
    expect(reply).toContain("and more than");
  });

  it.each(NON_OFFICERS)("refuses %s", async (_label, who) => {
    await seed();

    const ran = await list({ member: who });

    expect(ran.reply.data?.content).toBe(REFUSED.message);
    expect(world.discord.requests).toEqual([]);
  });
});

async function reminderState(taskId: string) {
  const lastDueDate = dateOnly("2099-12-31");
  const candidates = await listReminderCandidates(world.db, { lastDueDate });
  const listed =
    candidates.ok &&
    candidates.value.rows.some((row) => row.task.id === taskId);
  const claim = await claimReminder(world.db, {
    taskId,
    kind: "one_day",
    dueDate: dateOnly("2099-01-10"),
  });
  return { listed, claimed: claim.ok && claim.value !== null };
}

describe("/event close", () => {
  const close = (eventId: string, fields = officerFields) =>
    world.send(eventCommand("close", eventOption(eventId), fields));

  function lines(threadId: string | null) {
    return world.discord
      .posts()
      .filter((post) => post.path === `/channels/${threadId ?? ""}/messages`);
  }

  it("closes, adds one line, refreshes the overview, and stops reminders", async () => {
    const event = await seed();
    const task = await world.insertTask(event.id);
    const list = await listReminderCandidates(world.db, {
      lastDueDate: dateOnly("2099-12-31"),
    });
    expect(list.ok && list.value.rows.map((row) => row.task.id)).toContain(
      task,
    );

    const ran = await close(event.id);

    expect(ran.reply).toEqual({ type: 5, data: { flags: 64 } });
    expect((await world.events())[0]?.status).toBe("closed");
    const [line, ...others] = lines(event.threadId);
    expect(others).toEqual([]);
    expect(line?.body?.content).toContain(`closed by <@${MEMBER_ID}>`);
    const edit = world.discord.requests.find(
      (request) =>
        request.method === "PATCH" && MESSAGE_EDIT.test(request.path),
    );
    expect(edit?.path).toContain(event.overviewId);
    expect(edit?.body?.content).toContain("Status: Closed");
    expect(await reminderState(task)).toEqual({
      listed: false,
      claimed: false,
    });
    expect(world.discord.lastReply()).toContain("Closed **Fall Social**");
  });

  it("defaults to the post it is run in", async () => {
    await seed({ name: "Another" });
    const event = await seed({ name: "This One" });

    await world.send(
      eventCommand(
        "close",
        {},
        {
          ...officerFields,
          ...inThread(event.threadId ?? "", event.forum),
        },
      ),
    );

    expect(
      (await world.events(`status = 'closed'`)).map((row) => row.id),
    ).toEqual([event.id]);
  });

  it("adds one line from a replayed request", async () => {
    const event = await seed();
    const payload = eventCommand("close", eventOption(event.id), officerFields);

    await world.send(payload);
    await world.send(payload);

    expect(lines(event.threadId)).toHaveLength(1);
  });

  it("changes nothing when closed a second time", async () => {
    const event = await seed();

    await close(event.id);
    await close(event.id);

    expect(lines(event.threadId)).toHaveLength(1);
    expect(world.discord.lastReply()).toContain("already closed");
  });

  it("refuses an event with no post yet", async () => {
    const event = await seed({ threadStatus: "pending" });

    await close(event.id);

    expect((await world.events())[0]?.status).toBe("active");
    expect(world.discord.lastReply()).toContain("no post yet");
  });

  it("closes an event in a removed forum, and posts nothing there", async () => {
    const event = await seed();
    await world.setForumStatus(event.forum, "removed");

    await close(event.id);

    expect((await world.events())[0]?.status).toBe("closed");
    expect(world.discord.publicWrites()).toEqual([]);
    expect(world.discord.lastReply()).toContain("couldn't add a line");
  });

  it.each<[string, Failure]>([
    ["a server error", SERVER_ERROR],
    ["no answer", { kind: "network" }],
    ["a refusal", { kind: "respond", status: 403, code: 50001 }],
  ])("stays closed when the line fails: %s", async (_label, failure) => {
    const event = await seed();
    world.discord.fail("POST", MESSAGES_POST, failure);

    await close(event.id);

    expect((await world.events())[0]?.status).toBe("closed");
    expect(world.discord.lastReply()).toContain("couldn't add a line");
  });

  it("stays closed when the overview edit fails, and says so in the reply", async () => {
    const event = await seed();
    world.discord.fail("PATCH", MESSAGE_EDIT, SERVER_ERROR);

    await close(event.id);

    expect((await world.events())[0]?.status).toBe("closed");
    expect(world.discord.lastReply()).toContain("Closed **Fall Social**");
    expect(world.discord.lastReply()).toContain("may still say Active");
  });

  it("does not mention the overview when it was updated", async () => {
    const event = await seed();

    await close(event.id);

    expect(world.discord.lastReply()).not.toContain("overview");
  });

  it("says how a close can be undone", async () => {
    const event = await seed();

    await close(event.id);

    expect(world.discord.lastReply()).toContain("no command to reopen");
    expect(world.discord.lastReply()).toContain("maintainer");
  });

  it("repairs the overview on a second close, with no second line", async () => {
    const event = await seed();
    world.discord.fail("PATCH", MESSAGE_EDIT, SERVER_ERROR);
    await close(event.id);
    world.discord.clearFailures();
    const before = world.discord.requests.length;

    await close(event.id);

    const edit = world.discord.requests
      .slice(before)
      .find(
        (request) =>
          request.method === "PATCH" && MESSAGE_EDIT.test(request.path),
      );
    expect(edit?.body?.content).toContain("Status: Closed");
    expect(lines(event.threadId)).toHaveLength(1);
    expect(world.discord.lastReply()).toContain("already closed");
    expect(world.discord.lastReply()).toContain("now shows");
  });

  it("says so when the second close can't repair the overview either", async () => {
    const event = await seed();
    world.discord.fail("PATCH", MESSAGE_EDIT, SERVER_ERROR);

    await close(event.id);
    await close(event.id);

    expect(world.discord.lastReply()).toContain("already closed");
    expect(world.discord.lastReply()).toContain("may still say Active");
  });

  it("offers no retry for an event in a removed forum", async () => {
    const event = await seed();
    await world.setForumStatus(event.forum, "removed");

    await close(event.id);

    expect(world.discord.lastReply()).toContain("Closed **Fall Social**");
    expect(world.discord.lastReply()).not.toContain("may still say Active");

    await close(event.id);

    expect(world.discord.lastReply()).toBe("This event is already closed.");
    expect(world.discord.publicWrites()).toEqual([]);
  });

  it("repairs nothing on a closed event whose post has gone", async () => {
    const event = await seed({ status: "closed", threadStatus: "missing" });

    await close(event.id);

    expect(world.discord.publicWrites()).toEqual([]);
    expect(world.discord.lastReply()).toBe("This event is already closed.");
  });

  it("posts a fresh overview when the old one was removed", async () => {
    const event = await seed();
    world.discord.fail("PATCH", MESSAGE_EDIT, {
      kind: "respond",
      status: 404,
      code: UNKNOWN_MESSAGE,
    });

    await close(event.id);

    const stored = (await world.events())[0];
    expect(stored?.overview_message_id).not.toBe(event.overviewId);
    expect(lines(event.threadId)).toHaveLength(2);
  });

  it("posts nothing when the write fails", async () => {
    const event = await seed();
    world.failDb(/^SQL update events/);

    await close(event.id);

    world.clearDbFailures();
    expect((await world.events())[0]?.status).toBe("active");
    expect(world.discord.publicWrites()).toEqual([]);
    expect(world.discord.lastReply()).toContain("Something went wrong");
  });

  it("changes nothing when the claim fails", async () => {
    const event = await seed();
    world.failDb(/public\.claim_interaction\(/);

    await close(event.id);

    world.clearDbFailures();
    expect((await world.events())[0]?.status).toBe("active");
    expect(world.discord.publicWrites()).toEqual([]);
  });

  it("posts nothing for an event whose post has gone", async () => {
    const event = await seed({ threadStatus: "missing" });

    await close(event.id);

    expect((await world.events())[0]?.status).toBe("closed");
    expect(world.discord.publicWrites()).toEqual([]);
  });
});

describe.each(HOSTILE_TEXT)("a stored name of %s", (_label, name) => {
  /** Everything sent with text in it, without the bot's own bold and mentions. */
  function sentText(): string[] {
    return world.discord.requests
      .map((request) => request.body?.content)
      .filter((content) => typeof content === "string")
      .map((content) =>
        content.replaceAll("**", "").replace(/<[@#][0-9]+>/gu, ""),
      );
  }

  it("stays inert through close", async () => {
    const event = await seed({ name: name.slice(0, 100) });

    await world.send(
      eventCommand("close", eventOption(event.id), officerFields),
    );

    expect(sentText().length).toBeGreaterThan(0);
    for (const text of sentText()) {
      expect(hasLiveSyntax(text)).toBe(false);
    }
  });

  it("stays inert through the delete prompt and Confirm", async () => {
    const event = await seed({ name: name.slice(0, 100) });

    await world.send(
      eventCommand("delete", eventOption(event.id), officerFields),
    );
    await world.send(await confirmClick(event.id));

    expect(sentText().length).toBeGreaterThan(0);
    for (const text of sentText()) {
      expect(hasLiveSyntax(text)).toBe(false);
    }
  });
});

describe("/event delete", () => {
  /** The custom_id of the button on the private reply. */
  function confirmShown(): string | undefined {
    const reply = world.discord.requests.findLast(
      (request) => request.method === "PATCH",
    );
    const rows = reply?.body?.components as
      { components: { custom_id: string }[] }[] | undefined;
    return rows?.[0]?.components[0]?.custom_id;
  }

  const ask = (
    eventId: string,
    fields: Record<string, unknown> = officerFields,
  ) => world.send(eventCommand("delete", eventOption(eventId), fields));

  it("only asks first, privately, and changes nothing", async () => {
    const event = await seed();

    const ran = await ask(event.id);

    // What it says goes back through Discord, not in the response to this request.
    expect(ran.reply).toEqual({ type: 5, data: { flags: 64 } });
    expect(world.discord.publicWrites()).toEqual([]);
    expect(world.discord.lastReply()).toContain("Fall Social");
    expect(confirmShown()).toBe(await confirmId(event.id));
    expect((await world.events())[0]?.deleted_at).toBeNull();
  });

  it("defaults to the post it is run in", async () => {
    const event = await seed();

    await world.send(
      eventCommand(
        "delete",
        {},
        {
          ...officerFields,
          ...inThread(event.threadId ?? "", event.forum),
        },
      ),
    );

    expect(confirmShown()).toBe(await confirmId(event.id));
  });

  describe("Confirm", () => {
    it("deletes the event and its tasks, adds one line, stops reminders", async () => {
      const event = await seed();
      const task = await world.insertTask(event.id);

      const ran = await world.send(await confirmClick(event.id));

      expect(ran.reply.type).toBe(6);
      expect((await world.events())[0]?.deleted_at).not.toBeNull();
      const { rows } = await world.pg.query<{ deleted: boolean }>(
        `SELECT deleted_at IS NOT NULL AS deleted FROM public.tasks`,
      );
      expect(rows).toEqual([{ deleted: true }]);
      const [line, ...others] = world.discord.posts();
      expect(others).toEqual([]);
      expect(line?.path).toBe(`/channels/${event.threadId ?? ""}/messages`);
      expect(line?.body?.content).toContain(`deleted by <@${MEMBER_ID}>`);
      expect(line?.body?.content).toContain("This post stays");
      expect(await reminderState(task)).toEqual({
        listed: false,
        claimed: false,
      });
      const lookup = await getEvent(world.db, {
        guildId: GUILD_ID,
        eventId: event.id,
      });
      expect(lookup).toEqual({ ok: true, value: null });
      expect(world.discord.lastReply()).toContain("Deleted **Fall Social**");
    });

    it("acknowledges the click without reading the event first", async () => {
      const event = await seed();
      world.failDb(/^SQL select .* from events/);

      const ran = await world.send(await confirmClick(event.id));

      world.clearDbFailures();
      expect(ran.reply.type).toBe(6);
      expect(ran.deferred).toBe(true);
      expect((await world.events())[0]?.deleted_at).toBeNull();
    });

    it("shows how many tasks would go", async () => {
      const event = await seed();
      await world.insertTask(event.id);
      await world.insertTask(event.id);

      await ask(event.id);

      expect(world.discord.lastReply()).toContain("all its tasks (2)");
    });

    it("deletes nothing when a task was added after it was shown", async () => {
      const event = await seed();
      const stale = await confirmClick(event.id);
      await world.insertTask(event.id);

      await world.send(stale);

      expect((await world.events())[0]?.deleted_at).toBeNull();
      const { rows } = await world.pg.query<{ deleted: boolean }>(
        `SELECT deleted_at IS NOT NULL AS deleted FROM public.tasks`,
      );
      expect(rows).toEqual([{ deleted: false }]);
      expect(world.discord.publicWrites()).toEqual([]);
      expect(world.discord.lastReply()).toContain(
        "changed after this was shown",
      );
    });

    it("deletes nothing when a task changed after it was shown", async () => {
      const event = await seed();
      await world.insertTask(event.id);
      const stale = await confirmClick(event.id);
      await world.pg.query(
        `UPDATE public.tasks SET description = 'Book a bigger room'`,
      );

      await world.send(stale);

      expect((await world.events())[0]?.deleted_at).toBeNull();
    });

    it("deletes nothing when the event changed after it was shown", async () => {
      const event = await seed();
      const stale = await confirmClick(event.id);
      await world.pg.query(`UPDATE public.events SET status = 'closed'`);

      await world.send(stale);

      expect((await world.events())[0]?.deleted_at).toBeNull();
    });

    it("deletes from the button the prompt really showed", async () => {
      const event = await seed();
      await world.insertTask(event.id);
      await ask(event.id);

      await world.send(componentPayload(confirmShown() ?? "", officerFields));

      expect((await world.events())[0]?.deleted_at).not.toBeNull();
    });

    it("removes the button once done", async () => {
      const event = await seed();

      await world.send(await confirmClick(event.id));

      const final = world.discord.requests.findLast(
        (request) => request.method === "PATCH",
      );
      expect(final?.body?.components).toEqual([]);
    });

    it("leaves the overview as it was, as documented", async () => {
      const event = await seed();

      await world.send(await confirmClick(event.id));

      expect(
        world.discord.requests.filter((request) =>
          MESSAGE_EDIT.test(request.path),
        ),
      ).toEqual([]);
    });

    it("makes one change and one line from a replayed click", async () => {
      const event = await seed();
      const click = await confirmClick(event.id);

      await world.send(click);
      await world.send(click);

      expect(world.discord.posts()).toHaveLength(1);
    });

    it("refuses a second click, as the event is gone", async () => {
      const event = await seed();

      await world.send(await confirmClick(event.id));
      await world.send(await confirmClick(event.id));

      expect(world.discord.lastReply()).toBe(REFUSED.message);
      expect(world.discord.posts()).toHaveLength(1);
    });

    it.each(NON_OFFICERS)(
      "refuses %s, from the click's own payload",
      async (_label, who) => {
        const event = await seed();

        const ran = await world.send(
          await confirmClick(event.id, { member: who }),
        );

        expect(ran.reply.data?.content).toBe(REFUSED.message);
        expect(ran.deferred).toBe(false);
        expect((await world.events())[0]?.deleted_at).toBeNull();
        expect(world.discord.requests).toEqual([]);
      },
    );

    it("refuses an officer who lost the role after being asked", async () => {
      const event = await seed();
      await ask(event.id);

      const ran = await world.send(
        await confirmClick(event.id, { member: PLAIN_MEMBER }),
      );

      expect(ran.reply.data?.content).toBe(REFUSED.message);
      expect((await world.events())[0]?.deleted_at).toBeNull();
    });

    it.each(unusableValues())("refuses %s", async (_label, value) => {
      const hostile = await value();
      const before = await world.events();

      const ran = await world.send(await confirmClick(hostile));

      // A malformed ID is refused at once, and a well-formed one once the row is read.
      expect(ran.reply.data?.content ?? world.discord.lastReply()).toBe(
        REFUSED.message,
      );
      expect(world.discord.publicWrites()).toEqual([]);
      expect(await world.events()).toEqual(before);
    });

    it("refuses a click with fields it does not expect", async () => {
      const event = await seed();

      const ran = await world.send(
        componentPayload(`${await confirmId(event.id)}:extra`, officerFields),
      );

      expect(ran.reply.data?.content).toBe(REFUSED.message);
      expect((await world.events())[0]?.deleted_at).toBeNull();
    });

    it("refuses a click on a message others can see", async () => {
      const event = await seed();

      const ran = await world.send(
        await confirmClick(event.id, {
          ...officerFields,
          message: { id: fakeId(), flags: 0 },
        }),
      );

      expect(ran.reply.data?.content).toBe(REFUSED.message);
      expect((await world.events())[0]?.deleted_at).toBeNull();
    });

    it("deletes an event with no post yet, with no line and no complaint", async () => {
      const event = await seed({ threadStatus: "pending" });

      await world.send(await confirmClick(event.id));

      expect((await world.events())[0]?.deleted_at).not.toBeNull();
      expect(world.discord.publicWrites()).toEqual([]);
      expect(world.discord.lastReply()).not.toContain("couldn't add");
    });

    it("deletes an event in a removed forum, and posts nothing there", async () => {
      const event = await seed();
      await world.setForumStatus(event.forum, "removed");

      await world.send(await confirmClick(event.id));

      expect((await world.events())[0]?.deleted_at).not.toBeNull();
      expect(world.discord.publicWrites()).toEqual([]);
      expect(world.discord.lastReply()).toContain("couldn't add a line");
    });

    it("stays deleted when the line fails", async () => {
      const event = await seed();
      world.discord.fail("POST", MESSAGES_POST, SERVER_ERROR);

      await world.send(await confirmClick(event.id));

      expect((await world.events())[0]?.deleted_at).not.toBeNull();
      expect(world.discord.lastReply()).toContain("couldn't add a line");
    });

    it("posts nothing when the delete fails", async () => {
      const event = await seed();
      world.failDb(/public\.soft_delete_event\(/);

      await world.send(await confirmClick(event.id));

      world.clearDbFailures();
      expect((await world.events())[0]?.deleted_at).toBeNull();
      expect(world.discord.publicWrites()).toEqual([]);
      expect(world.discord.lastReply()).toContain("Something went wrong");
    });
  });

  it("is gone from every read once deleted", async () => {
    const event = await seed();

    await world.send(await confirmClick(event.id));

    expect(await choices("status", "")).toEqual([]);
    await world.send(
      eventCommand("status", eventOption(event.id), officerFields),
    );
    expect(world.discord.lastReply()).toBe(REFUSED.message);
    await ask(event.id);
    expect(world.discord.lastReply()).toBe(REFUSED.message);
    await world.send(eventCommand("list", {}, officerFields));
    expect(world.discord.lastReply()).toContain("no events yet");
  });
});
