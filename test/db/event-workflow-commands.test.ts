/**
 * The event workflow from the router down to the real schema: /event assign, unassign
 * and pickup, the people picked on /event create, the overview's checklist and buttons,
 * the ping each finished step sends, and the steps /mytasks lists. Discord is the test
 * server behind the real client, so every send passes the managed-channel check.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { completeEventStep } from "../../src/db/event-steps.ts";
import type { AssignableStepKind } from "../../src/db/types.ts";
import { eventWorld, inThread } from "../support/event-world.ts";
import {
  ADMIN_ROLE,
  commandPayload,
  componentPayload,
  GUILD_ID,
  member,
  OFFICER_ROLE,
} from "../support/interactions.ts";
import { fakeId } from "../support/ids.ts";
import { queryAs } from "./harness.ts";

const world = eventWorld();

const EBOARD_ROLE = fakeId();
const TREASURY_ROLE = fakeId();
const MARKETING_ROLE = fakeId();
const CREATOR = fakeId();
const REFUSAL = "You can't do that, or it doesn't exist.";
const SUPPRESS_EMBEDS = 4;
/** 5:30 PM on the event's date in the guild's zone, New York, in winter. */
const PICKUP_AT = `<t:${String(Date.UTC(2099, 0, 15, 22, 30) / 1000)}:t>`;
const MESSAGE_EDIT = /^\/channels\/[0-9]+\/messages\/[0-9]+$/;

const officer = (id = fakeId()) => member({ id, roles: [OFFICER_ROLE] });
const treasurer = (id = fakeId()) => member({ id, roles: [TREASURY_ROLE] });
const marketer = (id = fakeId()) => member({ id, roles: [MARKETING_ROLE] });
const plain = (id = fakeId()) => member({ id });

async function bindRoles(
  treasury: string | null,
  marketing: string | null,
): Promise<void> {
  const rows = await queryAs<{ version: number }>(
    world.pg,
    "bot_app",
    `SELECT version FROM public.guild_config WHERE guild_id = $1`,
    [GUILD_ID],
  );
  await queryAs(
    world.pg,
    "bot_app",
    `SELECT public.apply_role_bindings($1, $2, $3, $4, $5, $6, NULL, $7, $8)`,
    [
      GUILD_ID,
      rows[0]?.version,
      fakeId(),
      OFFICER_ROLE,
      ADMIN_ROLE,
      EBOARD_ROLE,
      treasury,
      marketing,
    ],
  );
}

interface Seeded {
  id: string;
  forum: string;
  threadId: string;
  overviewId: string;
}

/** An active event with its post and overview, as /event create leaves it. */
async function seed(
  fields: { status?: "active" | "closed"; date?: string } = {},
): Promise<Seeded> {
  const forum = await world.addManagedForum();
  const threadId = world.discord.addThread({
    guild_id: GUILD_ID,
    parent_id: forum,
    name: "Fall Social",
  });
  const overviewId = fakeId();
  world.discord.messageIds.add(overviewId);
  const { rows } = await world.pg.query<{ id: string }>(
    `INSERT INTO public.events
       (guild_id, channel_id, name, event_date, created_by, thread_id,
        overview_message_id, status, thread_status)
     VALUES ($1, $2, 'Fall Social', $3, $4, $5, $6, $7::public.event_status, 'active')
     RETURNING id`,
    [
      GUILD_ID,
      forum,
      fields.date ?? "2099-01-15",
      CREATOR,
      threadId,
      overviewId,
      fields.status ?? "active",
    ],
  );
  return { id: (rows[0] as { id: string }).id, forum, threadId, overviewId };
}

/** `/event <sub>` with string options and user options, as Discord sends it. */
function command(
  sub: string,
  strings: Record<string, string>,
  users: Record<string, string>,
  who: Record<string, unknown>,
) {
  const ids = Object.values(users);
  return commandPayload(
    "event",
    { member: who },
    {
      options: [
        {
          type: 1,
          name: sub,
          options: [
            ...Object.entries(strings).map(([name, value]) => ({
              type: 3,
              name,
              value,
            })),
            ...Object.entries(users).map(([name, value]) => ({
              type: 6,
              name,
              value,
            })),
          ],
        },
      ],
      resolved: {
        users: Object.fromEntries(ids.map((id) => [id, { id }])),
        members: Object.fromEntries(ids.map((id) => [id, { roles: [] }])),
      },
    },
  );
}

function assign(
  event: Seeded,
  step: string,
  userId: string,
  who: Record<string, unknown> = officer(),
) {
  return world.send(
    command("assign", { event: event.id, step }, { user: userId }, who),
  );
}

function click(prefix: string, event: Seeded, who: Record<string, unknown>) {
  return componentPayload(`${prefix}:${event.id}`, {
    member: who,
    message: { id: event.overviewId, flags: SUPPRESS_EMBEDS },
    ...inThread(event.threadId, event.forum),
  });
}

async function steps(eventId: string) {
  const { rows } = await world.pg.query<{
    kind: string;
    status: string;
    completed_by: string | null;
    handoff_sent: boolean;
  }>(
    `SELECT kind::text AS kind, status::text AS status, completed_by,
            handoff_sent_at IS NOT NULL AS handoff_sent
     FROM public.event_steps WHERE event_id = $1 ORDER BY kind`,
    [eventId],
  );
  return Object.fromEntries(rows.map((row) => [row.kind, row]));
}

async function owners(eventId: string, kind: AssignableStepKind) {
  const { rows } = await world.pg.query<{ user_id: string }>(
    `SELECT user_id FROM public.event_step_assignees
     WHERE event_id = $1 AND kind = $2::public.event_step_kind
       AND removed_at IS NULL
     ORDER BY created_at, id`,
    [eventId, kind],
  );
  return rows.map((row) => row.user_id);
}

async function pickupTime(eventId: string): Promise<string | null> {
  const { rows } = await world.pg.query<{ pickup_time: string | null }>(
    `SELECT to_char(pickup_time, 'HH24:MI') AS pickup_time
     FROM public.events WHERE id = $1`,
    [eventId],
  );
  return rows[0]?.pickup_time ?? null;
}

/** Messages posted in the event's post, leaving out overview edits. */
function postedIn(event: Seeded) {
  return world.discord
    .posts()
    .filter((post) => post.path === `/channels/${event.threadId}/messages`);
}

function lastOverviewEdit(event: Seeded) {
  return world.discord.requests.findLast(
    (request) =>
      request.method === "PATCH" &&
      request.path ===
        `/channels/${event.threadId}/messages/${event.overviewId}`,
  );
}

function buttonIds(body: Record<string, unknown> | undefined): string[] {
  const rows = (body?.components ?? []) as {
    components: { custom_id: string }[];
  }[];
  return rows.flatMap((row) => row.components.map((part) => part.custom_id));
}

async function approve(event: Seeded): Promise<void> {
  const done = await completeEventStep(world.db, {
    guildId: GUILD_ID,
    eventId: event.id,
    kind: "budget_approved",
    actorId: fakeId(),
  });
  expect(done).toEqual({ ok: true, value: true });
}

beforeEach(async () => {
  await bindRoles(TREASURY_ROLE, MARKETING_ROLE);
});

describe("/event assign and unassign", () => {
  it("puts a member on Budget Sheet and redraws the checklist without pinging", async () => {
    const event = await seed();
    const person = fakeId();

    await assign(event, "budget_sheet", person);

    expect(await owners(event.id, "budget_sheet")).toEqual([person]);
    expect(world.discord.lastReply()).toContain(
      `Put <@${person}> on Budget Sheet for **Fall Social**.`,
    );
    const edit = lastOverviewEdit(event);
    const content = edit?.body?.content as string;
    expect(content).toContain("**Checklist**");
    expect(content).toContain(`⬜ Budget Sheet: <@${person}>`);
    expect(content).toContain("⬜ Engage post: nobody assigned");
    expect(content).toContain("⬜ Food pickup: time not set, nobody assigned");
    expect(edit?.body?.allowed_mentions).toEqual({ parse: [], users: [] });
    expect(buttonIds(edit?.body)).toEqual([
      `event.sheet-done:${event.id}`,
      `event.engage-done:${event.id}`,
      `event.budget-ok:${event.id}`,
    ]);
    expect(postedIn(event)).toEqual([]);
  });

  it.each([
    ["a member with no role", plain()],
    ["Treasury", treasurer()],
  ])("refuses %s and writes nothing", async (_label, who) => {
    const event = await seed();

    const ran = await assign(event, "budget_sheet", fakeId(), who);

    expect(ran.reply.data?.content).toBe(REFUSAL);
    expect(await owners(event.id, "budget_sheet")).toEqual([]);
    expect(world.discord.publicWrites()).toEqual([]);
  });

  it("takes someone off a step and redraws", async () => {
    const event = await seed();
    const person = fakeId();
    await assign(event, "budget_sheet", person);

    await world.send(
      command(
        "unassign",
        { event: event.id, step: "budget_sheet" },
        { user: person },
        officer(),
      ),
    );

    expect(await owners(event.id, "budget_sheet")).toEqual([]);
    expect(world.discord.lastReply()).toContain(
      `Took <@${person}> off Budget Sheet`,
    );
    expect(lastOverviewEdit(event)?.body?.content).toContain(
      "⬜ Budget Sheet: nobody assigned",
    );
  });
});

describe("/event pickup", () => {
  const pickup = (event: Seeded, time: string, who = officer()) =>
    world.send(command("pickup", { event: event.id, time }, {}, who));

  it("sets the time and the people before the budget is approved", async () => {
    const event = await seed();
    const person = fakeId();

    await pickup(event, "5:30 PM");
    await assign(event, "food_pickup", person);

    expect(await pickupTime(event.id)).toBe("17:30");
    expect(await owners(event.id, "food_pickup")).toEqual([person]);
  });

  it("finishes the step once approved with people on it, and shows the time", async () => {
    const event = await seed();
    await approve(event);
    const person = fakeId();
    await assign(event, "food_pickup", person);
    expect(world.discord.lastReply()).toContain(
      "Set the pickup time with /event pickup.",
    );

    await pickup(event, "5:30 PM");

    expect((await steps(event.id)).food_pickup?.status).toBe("done");
    expect(world.discord.lastReply()).toContain(
      `Food pickup for **Fall Social** is at ${PICKUP_AT} on 2099\\-01\\-15.`,
    );
    expect(lastOverviewEdit(event)?.body?.content).toContain(
      `✅ Food pickup: at ${PICKUP_AT}, <@${person}>`,
    );
  });

  it("refuses a time it can't read, and a member who is not an officer", async () => {
    const event = await seed();

    await pickup(event, "half five");
    expect(world.discord.lastReply()).toContain("Enter the pickup time");

    const ran = await pickup(event, "5:30 PM", treasurer());
    expect(ran.reply.data?.content).toBe(REFUSAL);
    expect(await pickupTime(event.id)).toBeNull();
  });
});

it("/event create puts the people picked on their steps before drawing the post", async () => {
  await world.addManagedForum();
  const budget = fakeId();
  const engage = fakeId();

  await world.send(
    command(
      "create",
      { name: "Spring Gala", date: "2099-04-01" },
      { budget, engage },
      officer(),
    ),
  );

  const [event] = await world.events();
  expect(await owners(event?.id ?? "", "budget_sheet")).toEqual([budget]);
  expect(await owners(event?.id ?? "", "engage_post")).toEqual([engage]);
  const message = world.discord.posts()[0]?.body?.message as Record<
    string,
    unknown
  >;
  expect(message.content).toContain(`⬜ Budget Sheet: <@${budget}>`);
  expect(message.content).toContain(`⬜ Engage post: <@${engage}>`);
  expect(message.allowed_mentions).toEqual({ parse: [], users: [] });
  expect(buttonIds(message)).toHaveLength(3);
});

describe("the overview's buttons", () => {
  it("refuses someone not on Budget Sheet who is not an officer", async () => {
    const event = await seed();
    await assign(event, "budget_sheet", fakeId());

    await world.send(click("event.sheet-done", event, plain()));

    expect(world.discord.lastReply()).toBe(REFUSAL);
    expect((await steps(event.id)).budget_sheet?.status).toBe("open");
    expect(postedIn(event)).toEqual([]);
  });

  it("lets the assignee finish Budget Sheet, pings Treasury once and hides the button", async () => {
    const event = await seed();
    const person = fakeId();
    await assign(event, "budget_sheet", person);
    world.allowPings({ roles: [TREASURY_ROLE] });

    const first = click("event.sheet-done", event, plain(person));
    const ran = await world.send(first);
    // The same delivery again, and a second click by someone else.
    await world.send(first);
    await world.send(click("event.sheet-done", event, officer()));

    expect(ran.reply).toEqual({ type: 5, data: { flags: 64 } });
    expect((await steps(event.id)).budget_sheet).toMatchObject({
      status: "done",
      completed_by: person,
      handoff_sent: true,
    });
    const pings = postedIn(event);
    expect(pings).toHaveLength(1);
    expect(pings[0]?.body).toMatchObject({
      content: `<@&${TREASURY_ROLE}> Budget Sheet for **Fall Social** is done.`,
      allowed_mentions: { parse: [], users: [], roles: [TREASURY_ROLE] },
    });
    expect(world.discord.lastReply()).toContain(
      "Budget Sheet for **Fall Social** is already done",
    );
    const edit = lastOverviewEdit(event);
    expect(edit?.body?.content).toContain(`✅ Budget Sheet: <@${person}>`);
    expect(buttonIds(edit?.body)).toEqual([
      `event.engage-done:${event.id}`,
      `event.budget-ok:${event.id}`,
    ]);
  });

  it("loses the ping rather than sending it twice when the post can't be reached", async () => {
    const event = await seed();
    const path = `/channels/${event.threadId}/messages`;
    world.allowPings({ roles: [TREASURY_ROLE] });
    world.discord.fail(
      "POST",
      new RegExp(`^${path}$`),
      { kind: "respond", status: 403, code: 50001 },
      1,
    );

    await world.send(click("event.sheet-done", event, officer()));
    expect(world.discord.lastReply()).toContain(
      "I couldn't post in the event's post",
    );
    await world.send(click("event.sheet-done", event, officer()));

    const tries = world.discord.requests.filter(
      (request) => request.method === "POST" && request.path === path,
    );
    expect(tries).toHaveLength(1);
  });

  it("lets an officer finish Engage post with nobody assigned, and pings Marketing", async () => {
    const event = await seed();
    world.allowPings({ roles: [MARKETING_ROLE] });

    await world.send(click("event.engage-done", event, officer()));

    expect((await steps(event.id)).engage_post?.status).toBe("done");
    expect(postedIn(event).map((post) => post.body?.content)).toEqual([
      `<@&${MARKETING_ROLE}> Engage post for **Fall Social** is up.`,
    ]);
    expect(world.discord.lastReply()).toContain(
      "I let the Marketing Committee know",
    );
  });

  it("says to run /setup, and pings nobody, when the role is not chosen", async () => {
    const event = await seed();
    await bindRoles(TREASURY_ROLE, null);

    await world.send(click("event.engage-done", event, officer()));

    const [post] = postedIn(event);
    expect(post?.body?.content).toBe(
      "Engage post for **Fall Social** is up. Run /setup to choose the Marketing Committee role, so the next one pings it.",
    );
    expect(post?.body?.allowed_mentions).toEqual({ parse: [], users: [] });
  });

  it("does not let Marketing or a Budget Sheet assignee approve the budget", async () => {
    const event = await seed();
    const person = fakeId();
    await assign(event, "budget_sheet", person);

    for (const who of [marketer(), plain(person)]) {
      const ran = await world.send(click("event.budget-ok", event, who));
      // Refused by the tier, before the acknowledgement.
      expect(ran.reply.data?.content).toBe(REFUSAL);
    }
    expect((await steps(event.id)).budget_approved?.status).toBe("open");
  });

  it("lets Treasury approve, and says so once in the post without a ping", async () => {
    const event = await seed();
    const approver = fakeId();

    await world.send(click("event.budget-ok", event, treasurer(approver)));
    expect(world.discord.lastReply()).toContain(
      "I said so in the event's post.",
    );
    await world.send(click("event.budget-ok", event, treasurer()));

    expect((await steps(event.id)).budget_approved).toMatchObject({
      status: "done",
      completed_by: approver,
    });
    const pings = postedIn(event);
    expect(pings).toHaveLength(1);
    expect(pings[0]?.body).toMatchObject({
      content: "The budget for **Fall Social** is approved.",
      allowed_mentions: { parse: [], users: [] },
    });
    expect(lastOverviewEdit(event)?.body?.content).toContain(
      `✅ Budget approved by <@${approver}>`,
    );
  });

  it("refuses a closed event and a deleted one", async () => {
    const closed = await seed({ status: "closed" });
    await world.send(click("event.budget-ok", closed, officer()));
    expect(world.discord.lastReply()).toContain("That event is closed");

    const deleted = await seed();
    await world.pg.query(
      `UPDATE public.events SET deleted_at = now() WHERE id = $1`,
      [deleted.id],
    );
    await world.send(click("event.sheet-done", deleted, officer()));
    expect(world.discord.lastReply()).toBe(REFUSAL);
    expect(
      world.discord.requests.filter(
        (request) =>
          request.method === "PATCH" && MESSAGE_EDIT.test(request.path),
      ),
    ).toEqual([]);
  });
});
