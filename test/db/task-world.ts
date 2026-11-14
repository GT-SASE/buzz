/**
 * The setup shared by the task command tests: a guild in the allowed list, another guild
 * to name rows from, and a router whose overview refresh can be watched. Discord is faked.
 *
 * The signature check only admits one guild, so another guild's rows are put in the
 * database directly and named from an interaction in the allowed guild.
 */

import { afterAll, afterEach, beforeAll, mock, type Mock } from "bun:test";
import type { DiscordClient } from "../../src/discord/client.ts";
import { setEventThread } from "../../src/db/events.ts";
import type { DbResult } from "../../src/db/errors.ts";
import { createTask } from "../../src/db/tasks.ts";
import { handler as mytasksHandler } from "../../src/handlers/mytasks.ts";
import {
  createRouter,
  type Router,
  type RouterDependencies,
} from "../../src/handlers/router.ts";
import { createTaskHandler } from "../../src/handlers/task.ts";
import type { RefreshOverview } from "../../src/tasks/shared.ts";
import {
  parseIsoDate,
  todayInZone,
  type DateOnly,
} from "../../src/lib/dates.ts";
import {
  ADMIN_ROLE,
  commandPayload,
  fakeDiscord,
  GUILD_ID,
  member,
  OFFICER_ROLE,
} from "../support/interactions.ts";
import { fakeId } from "../support/ids.ts";
import { openBackend, type Backend } from "./backend.ts";
import { insertEvent, insertGuild, type GuildFixture } from "./fixtures.ts";
import { HOOK_TIMEOUT_MS, queryAs } from "./harness.ts";

export const EPHEMERAL = 64;
export const SUPPRESS_EMBEDS = 4;
export const DEFERRED_MESSAGE = 5;
export const DEFERRED_UPDATE = 6;
export const FIXED_REFUSAL = "You can't do that, or it doesn't exist.";
export const UNKNOWN_ID = "99999999-9999-4999-8999-999999999999";
export const OPTION = { subcommand: 1, string: 3, user: 6 } as const;
export const FAR_DUE = "2040-06-15";

const TIMEZONE = "America/New_York";

export function date(value: string): DateOnly {
  const parsed = parseIsoDate(value);
  if (parsed === null) throw new Error("bad test date");
  return parsed;
}

export function unwrap<T>(result: DbResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

export function officer(id = fakeId()) {
  return member({ id, roles: [OFFICER_ROLE] });
}

export function admin(id = fakeId()) {
  return member({ id, roles: [ADMIN_ROLE] });
}

export function plainMember(id = fakeId()) {
  return member({ id });
}

export type OptionValues = Record<string, string>;

export function stringOptions(values: OptionValues) {
  return Object.entries(values).map(([name, value]) => ({
    name,
    type: OPTION.string,
    value,
  }));
}

export function subcommand(
  name: string,
  options: readonly Record<string, unknown>[],
  fields: Record<string, unknown>,
  resolved?: Record<string, unknown>,
): Record<string, unknown> {
  return commandPayload("task", fields, {
    options: [{ name, type: OPTION.subcommand, options }],
    ...(resolved === undefined ? {} : { resolved }),
  });
}

export interface Notice {
  channelId: string;
  content: string;
  allowed_mentions: { parse: string[]; users: string[] };
  flags: number;
  components: { components: { custom_id: string; label: string }[] }[];
}

/** A fake Discord that records what is posted, with any method replaced. */
export function fakeClient(overrides: Partial<DiscordClient> = {}) {
  const { discord, edits } = fakeDiscord();
  const notices: Notice[] = [];
  const client: DiscordClient = {
    ...discord,
    sendMessage: (target, body) => {
      notices.push({
        channelId:
          target.kind === "thread" ? target.threadId : target.channelId,
        ...(body.payload as Omit<Notice, "channelId">),
      });
      return Promise.resolve({ id: fakeId() });
    },
    ...overrides,
  };
  return { client, edits, notices };
}

export function pickerPayload(
  name: "assign" | "edit" | "delete" | "done",
  typed: unknown,
  fields: Record<string, unknown>,
) {
  return {
    ...commandPayload("task", fields),
    type: 4,
    data: {
      type: 1,
      name: "task",
      options: [
        {
          name,
          type: OPTION.subcommand,
          options: [
            {
              name: name === "assign" ? "event" : "task",
              type: OPTION.string,
              value: typed,
              focused: true,
            },
          ],
        },
      ],
    },
  };
}

/** The fixed refusal, whether it came straight back or after the acknowledgement. */
export function refusedWith(
  ran: { reply: { data?: Record<string, unknown> } },
  edits: readonly { content: string }[],
): unknown {
  return ran.reply.data?.content ?? edits[0]?.content;
}

export interface TaskWorld {
  backend: Backend;
  router: Router;
  fixture: GuildFixture;
  foreign: GuildFixture;
  foreignEventId: string;
  refreshOverview: Mock<RefreshOverview>;
  db: () => Backend["db"];
  today: () => DateOnly;
  /** Dependencies whose work after the reply runs `stage` once, just before that write. */
  racing: (
    client: DiscordClient,
    write: "insert" | "update" | "edit",
    stage: () => Promise<void>,
  ) => RouterDependencies;
  eventWithPost: () => Promise<{ eventId: string; threadId: string }>;
  inThread: (threadId: string) => Record<string, unknown>;
  newTask: (
    eventId: string,
    assigneeId: string,
    description?: string,
  ) => ReturnType<typeof createdTask>;
  row: (id: string) => Promise<TaskState | undefined>;
  tasksOn: (eventId: string) => Promise<TaskListing[]>;
}

interface TaskState {
  event_id: string;
  guild_id: string;
  assignee_id: string;
  description: string;
  due_date: string;
  status: string;
  created_by: string;
  deleted: boolean;
}

interface TaskListing {
  id: string;
  assignee_id: string;
  description: string;
  due_date: string;
  created_by: string;
}

async function createdTask(
  db: Backend["db"],
  eventId: string,
  assigneeId: string,
  description: string,
) {
  return unwrap(
    await createTask(db, {
      guildId: GUILD_ID,
      eventId,
      assigneeId,
      actorId: fakeId(),
      description,
      dueDate: date(FAR_DUE),
    }),
  );
}

/** Call once inside a describe. Fields are filled in by the time a test runs. */
export function useTaskWorld(): TaskWorld {
  const refreshOverview = mock<RefreshOverview>(() => Promise.resolve(true));
  const world = { refreshOverview } as TaskWorld;

  world.db = () => world.backend.db;
  world.today = () => todayInZone(new Date(), TIMEZONE);
  world.racing = (client, write, stage) => {
    let staged = false;
    const statement = {
      insert: /^insert into tasks/,
      update: /^update tasks/,
      // A change of text, date or person goes through this one function.
      edit: /^select public\.edit_task\(/,
    }[write];
    const db = world.backend.dbWith(async (text) => {
      if (!staged && statement.test(text)) {
        staged = true;
        // PGlite's clock can repeat within a millisecond, and real timestamps do not.
        await new Promise((resolve) => setTimeout(resolve, 5));
        await stage();
      }
    });
    return {
      db: () => world.backend.db,
      finishDb: () => db,
      discord: () => client,
    };
  };
  world.inThread = (threadId) => ({
    channel: { id: threadId, type: 11, parent_id: world.fixture.channelId },
  });
  world.eventWithPost = async () => {
    const eventId = await insertEvent(world.backend.connection, world.fixture);
    const threadId = fakeId();
    unwrap(
      await setEventThread(world.db(), {
        guildId: GUILD_ID,
        eventId,
        threadId,
      }),
    );
    return { eventId, threadId };
  };
  world.newTask = (eventId, assigneeId, description = "Book the room") =>
    createdTask(world.db(), eventId, assigneeId, description);
  world.row = async (id) => {
    const { rows } = await world.backend.connection.query<TaskState>(
      `SELECT event_id, guild_id, assignee_id, description, due_date::text AS due_date,
              status, created_by, deleted_at IS NOT NULL AS deleted
       FROM public.tasks WHERE id = $1`,
      [id],
    );
    return rows[0];
  };
  world.tasksOn = async (eventId) => {
    const { rows } = await world.backend.connection.query<TaskListing>(
      `SELECT id, assignee_id, description, due_date::text AS due_date, created_by
       FROM public.tasks WHERE event_id = $1`,
      [eventId],
    );
    return rows;
  };

  beforeAll(async () => {
    world.backend = await openBackend();
    const forum = fakeId();
    await queryAs(
      world.backend.connection,
      "bot_app",
      `SELECT public.apply_role_bindings($1, 0, $2, $3, $4, NULL, NULL, NULL, NULL)`,
      [GUILD_ID, fakeId(), OFFICER_ROLE, ADMIN_ROLE],
    );
    await queryAs(
      world.backend.connection,
      "bot_app",
      `SELECT public.apply_config_change($1, 1, $2, NULL, ARRAY[$3]::text[])`,
      [GUILD_ID, fakeId(), forum],
    );
    world.fixture = {
      guildId: GUILD_ID,
      officerRoleId: OFFICER_ROLE,
      adminRoleId: ADMIN_ROLE,
      channelId: forum,
    };
    world.foreign = await insertGuild(world.backend.connection);
    world.foreignEventId = await insertEvent(
      world.backend.connection,
      world.foreign,
    );
    world.router = createRouter([
      createTaskHandler({ refreshOverview }),
      mytasksHandler,
    ]);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await world.backend.close();
  });

  afterEach(() => {
    refreshOverview.mockReset();
    refreshOverview.mockImplementation(() => Promise.resolve(true));
  });

  return world;
}
