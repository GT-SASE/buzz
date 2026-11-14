import { describe, expect, it } from "bun:test";
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
import {
  eventCommand,
  eventWorld,
  inThread,
  OTHER_GUILD,
} from "../support/event-world.ts";
import { hasLiveSyntax } from "../support/hostile-text.ts";
import {
  autocompletePayload,
  componentPayload,
  GUILD_ID,
  MEMBER_ID,
  OFFICER,
  PLAIN_MEMBER,
} from "../support/interactions.ts";
import { fakeId } from "../support/ids.ts";

const world = eventWorld();

const MESSAGES_POST = /^\/channels\/[0-9]+\/messages$/;
const MESSAGE_EDIT = /^\/channels\/[0-9]+\/messages\/[0-9]+$/;
const SERVER_ERROR: Failure = { kind: "respond", status: 500 };
const UNKNOWN_EVENT = "99999999-9999-4999-8999-999999999999";
const officerFields = { member: OFFICER };

interface Seed {
  name?: string;
  date?: string;
  guildId?: string;
  forum?: string;
  status?: "active" | "closed";
  threadStatus?: "pending" | "active" | "missing";
  deleted?: boolean;
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
  const overviewId = threadId === null ? null : fakeId();
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

/** Requests to the events table made since `before`. */
function eventReads(before: number): string[] {
  return world
    .dbRequests()
    .slice(before)
    .filter((request) => /\/events|"events"/.test(request));
}

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

  it("offers name, date and short ID on every command, and submits the full ID", async () => {
    const event = await seed({ name: "Fall Social", date: "2099-03-04" });

    for (const sub of SUBS_WITH_PICKER) {
      expect(await choices(sub, "fall")).toEqual([
        {
          name: `Fall Social - 2099-03-04 - ${event.id.slice(0, 8)}`,
          value: event.id,
        },
      ]);
    }
  });

  it("offers a member who is not an officer nothing, and reads no event", async () => {
    await seed();
    const before = world.dbRequests().length;

    expect(await choices("status", "", { member: PLAIN_MEMBER })).toEqual([]);
    expect(eventReads(before)).toEqual([]);
  });

  it("offers no deleted event and no other guild's event", async () => {
    await seed({ name: "Gone", deleted: true });
    await seed({ name: "Theirs", guildId: OTHER_GUILD });

    expect(await choices("status", "")).toEqual([]);
  });

  it("offers at most 25 choices, and says when an event is closed", async () => {
    const forum = await world.addManagedForum();
    for (let index = 0; index < 30; index++) {
      await seed({ forum, name: `Event ${String(index)}`, status: "closed" });
    }

    const offered = await choices("status", "Event");
    expect(offered).toHaveLength(25);
    expect(offered[0]?.name).toContain(" - closed");
  });

  it("shows a stored hostile name inertly", async () => {
    await seed({ name: "@everyone [x](https://evil.example) **y**" });

    const [choice] = await choices("status", "");

    expect(choice?.name).not.toMatch(/[@<>#[\]`|*~:/\\.\n\r]/u);
  });

  it("reports a database failure as no choices", async () => {
    await seed();
    world.failDb(/^SQL select .* from events/);

    expect(await choices("status", "")).toEqual([]);
  });
});

/** Every way to name an event that must look the same to the caller. */
const UNUSABLE: [string, () => Promise<string>][] = [
  ["a value never offered", () => Promise.resolve(UNKNOWN_EVENT)],
  ["a deleted event's ID", async () => (await seed({ deleted: true })).id],
  [
    "another guild's event",
    async () => (await seed({ guildId: OTHER_GUILD })).id,
  ],
  ["a malformed value", () => Promise.resolve("x' OR '1'='1")],
];

describe.each(["status", "close", "delete"])(
  "/event %s, choosing the event",
  (sub) => {
    it.each(UNUSABLE)("refuses %s", async (_label, value) => {
      const bystander = await seed({ name: "Bystander" });
      const hostile = await value();

      const ran = await world.send(
        eventCommand(sub, eventOption(hostile), officerFields),
      );

      // The row is read after the acknowledgement, which is private.
      expect(ran.reply.type).toBe(5);
      expect(ran.reply.data?.flags).toBe(64);
      expect(world.discord.lastReply()).toBe(REFUSED.message);
      expect(world.discord.publicWrites()).toEqual([]);
      expect((await world.events(`id = '${bystander.id}'`))[0]).toMatchObject({
        status: "active",
        deleted_at: null,
      });
    });

    it("tells an officer what to do outside a post when no event is named", async () => {
      await seed();

      await world.send(eventCommand(sub, {}, officerFields));

      expect(world.discord.lastReply()).toContain("choose the event");
      expect(world.discord.publicWrites()).toEqual([]);
    });

    it("refuses a member who is not an officer, reading no event", async () => {
      const event = await seed();
      const before = world.dbRequests().length;

      const ran = await world.send(
        eventCommand(sub, eventOption(event.id), { member: PLAIN_MEMBER }),
      );

      expect(ran.reply.data?.content).toBe(REFUSED.message);
      expect(ran.deferred).toBe(false);
      expect(world.discord.requests).toEqual([]);
      expect(eventReads(before)).toEqual([]);
      expect((await world.events())[0]).toMatchObject({
        status: "active",
        deleted_at: null,
      });
    });
  },
);

describe("/event status", () => {
  const status = (
    options: Record<string, { type: number; value: unknown }>,
    fields: Record<string, unknown> = officerFields,
  ) => world.send(eventCommand("status", options, fields));

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
      { ...officerFields, ...inThread(event.threadId ?? "", event.forum) },
    );

    expect(world.discord.lastReply()).toContain("**This One**");
  });

  it.each<[string, Seed, string]>([
    ["no post yet", { threadStatus: "pending" }, "none yet"],
    ["a post that has gone", { threadStatus: "missing" }, "/event link"],
  ])("explains an event with %s", async (_label, fields, text) => {
    const event = await seed(fields);

    await status(eventOption(event.id));

    expect(world.discord.lastReply()).toContain(text);
  });
});

async function reminderState(taskId: string) {
  const candidates = await listReminderCandidates(world.db, {
    lastDueDate: dateOnly("2099-12-31"),
  });
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
  const close = (eventId: string) =>
    world.send(eventCommand("close", eventOption(eventId), officerFields));

  function lines(threadId: string | null) {
    return world.discord
      .posts()
      .filter((post) => post.path === `/channels/${threadId ?? ""}/messages`);
  }

  it("closes, adds one line, refreshes the overview, and stops reminders", async () => {
    const event = await seed();
    const task = await world.insertTask(event.id);
    expect((await reminderState(task)).listed).toBe(true);

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
    expect(edit?.path).toContain(event.overviewId ?? "");
    expect(edit?.body?.content).toContain("Status: Closed");
    expect(await reminderState(task)).toEqual({
      listed: false,
      claimed: false,
    });
    const reply = world.discord.lastReply();
    expect(reply).toContain("Closed **Fall Social**");
    expect(reply).not.toContain("overview");
    expect(reply).toContain("no command to reopen");
    expect(reply).toContain("maintainer");
  });

  it("adds one line from a replayed request, and none on a second close", async () => {
    const event = await seed();
    const payload = eventCommand("close", eventOption(event.id), officerFields);

    await world.send(payload);
    await world.send(payload);
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

  it.each<[string, Seed]>([
    ["in a removed forum", {}],
    ["whose post has gone", { threadStatus: "missing" }],
  ])("closes an event %s, and posts nothing", async (label, fields) => {
    const event = await seed(fields);
    if (label === "in a removed forum") {
      await world.setForumStatus(event.forum, "removed");
    }

    await close(event.id);

    expect((await world.events())[0]?.status).toBe("closed");
    expect(world.discord.publicWrites()).toEqual([]);
  });

  it("stays closed when the line fails", async () => {
    const event = await seed();
    world.discord.fail("POST", MESSAGES_POST, SERVER_ERROR);

    await close(event.id);

    expect((await world.events())[0]?.status).toBe("closed");
    expect(world.discord.lastReply()).toContain("couldn't add a line");
  });
});

it("keeps a stored hostile name inert through close, the delete prompt and Confirm", async () => {
  const event = await seed({
    name: "@everyone <@&1> [x](https://evil.example)",
  });

  await world.send(eventCommand("close", eventOption(event.id), officerFields));
  await world.send(
    eventCommand("delete", eventOption(event.id), officerFields),
  );
  await world.send(await confirmClick(event.id));

  const sent = world.discord.requests
    .map((request) => request.body?.content)
    .filter((content) => typeof content === "string")
    .map((content) =>
      content.replaceAll("**", "").replace(/<[@#][0-9]+>/gu, ""),
    );
  expect(sent.length).toBeGreaterThan(2);
  for (const text of sent) {
    expect(hasLiveSyntax(text)).toBe(false);
  }
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

  const ask = (eventId: string) =>
    world.send(eventCommand("delete", eventOption(eventId), officerFields));

  it("only asks first, privately, shows the task count and changes nothing", async () => {
    const event = await seed();
    await world.insertTask(event.id);
    await world.insertTask(event.id);

    const ran = await ask(event.id);

    // What it says goes back through Discord, not in the response to this request.
    expect(ran.reply).toEqual({ type: 5, data: { flags: 64 } });
    expect(world.discord.publicWrites()).toEqual([]);
    expect(world.discord.lastReply()).toContain("Fall Social");
    expect(world.discord.lastReply()).toContain("all its tasks (2)");
    expect(confirmShown()).toBe(await confirmId(event.id));
    expect((await world.events())[0]?.deleted_at).toBeNull();
  });

  describe("Confirm", () => {
    it("deletes the event and its tasks, adds one line, stops reminders", async () => {
      const event = await seed();
      const task = await world.insertTask(event.id);
      await ask(event.id);

      const ran = await world.send(
        componentPayload(confirmShown() ?? "", officerFields),
      );

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
      expect(world.discord.lastReply()).toContain("Deleted **Fall Social**");
      const final = world.discord.requests.findLast(
        (request) => request.method === "PATCH",
      );
      expect(final?.body?.components).toEqual([]);
    });

    it("deletes nothing when a task was added after it was shown", async () => {
      const event = await seed();
      const stale = await confirmClick(event.id);
      await world.insertTask(event.id);

      await world.send(stale);

      expect((await world.events())[0]?.deleted_at).toBeNull();
      expect(world.discord.publicWrites()).toEqual([]);
      expect(world.discord.lastReply()).toContain(
        "changed after this was shown",
      );
    });

    it("makes one change and one line from a replayed click, and refuses a second click", async () => {
      const event = await seed();
      const click = await confirmClick(event.id);

      await world.send(click);
      await world.send(click);
      await world.send(await confirmClick(event.id));

      expect(world.discord.lastReply()).toBe(REFUSED.message);
      expect(world.discord.posts()).toHaveLength(1);
    });

    it("refuses a member who is not an officer, from the click's own payload", async () => {
      const event = await seed();
      await ask(event.id);

      const ran = await world.send(
        await confirmClick(event.id, { member: PLAIN_MEMBER }),
      );

      expect(ran.reply.data?.content).toBe(REFUSED.message);
      expect(ran.deferred).toBe(false);
      expect((await world.events())[0]?.deleted_at).toBeNull();
    });

    it.each(UNUSABLE)("refuses %s", async (_label, value) => {
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

    it("deletes an event with no post yet, with no line and no complaint", async () => {
      const event = await seed({ threadStatus: "pending" });

      await world.send(await confirmClick(event.id));

      expect((await world.events())[0]?.deleted_at).not.toBeNull();
      expect(world.discord.publicWrites()).toEqual([]);
      expect(world.discord.lastReply()).not.toContain("couldn't add");
    });
  });

  it("is gone from every read once deleted", async () => {
    const event = await seed();

    await world.send(await confirmClick(event.id));

    expect(await choices("status", "")).toEqual([]);
    expect(
      await getEvent(world.db, { guildId: GUILD_ID, eventId: event.id }),
    ).toEqual({ ok: true, value: null });
    await world.send(
      eventCommand("status", eventOption(event.id), officerFields),
    );
    expect(world.discord.lastReply()).toBe(REFUSED.message);
    await world.send(eventCommand("list", {}, officerFields));
    expect(world.discord.lastReply()).toContain("no events yet");
  });
});
