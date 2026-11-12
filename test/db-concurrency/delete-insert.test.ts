import { describe, expect, it } from "vitest";
import { createEvent, softDeleteEvent } from "../../src/db/events.ts";
import { createTask } from "../../src/db/tasks.ts";
import type { DateOnly } from "../../src/lib/dates.ts";
import { insertEvent, insertGuild } from "../db/fixtures.ts";
import { fakeId } from "../db/harness.ts";
import { raceDatabase } from "./race.ts";

const PARENT_UNAVAILABLE = {
  ok: false,
  error: { category: "parent_unavailable", code: "CF410" },
};

/** A delete and an insert under it, in either order. Neither may leave an orphan. */
describe("a delete racing an insert", () => {
  const db = raceDatabase();

  it("an event's soft delete waits for a task being inserted, then deletes it too", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);

    const second = await db.race(
      [
        `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
         VALUES ($1, $2, $3, 'Book the room', '2030-01-10', $3)`,
        [eventId, guild.guildId, fakeId()],
      ],
      (bot) => softDeleteEvent(bot, { guildId: guild.guildId, eventId }),
    );

    expect(second).toEqual({ ok: true, value: 1 });
    const { rows } = await db.observer.query(
      "SELECT count(*)::int AS n FROM public.tasks WHERE event_id = $1 AND deleted_at IS NULL",
      [eventId],
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it("a task insert waits for its event's soft delete, then is refused", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);

    const second = await db.race(
      ["SELECT public.soft_delete_event($1, $2)", [eventId, guild.guildId]],
      (bot) =>
        createTask(bot, {
          guildId: guild.guildId,
          eventId,
          assigneeId: fakeId(),
          actorId: fakeId(),
          description: "Book the room",
          dueDate: "2030-01-10" as DateOnly,
        }),
    );

    expect(second).toEqual(PARENT_UNAVAILABLE);
  });

  it("an event insert waits for its channel's removal, then is refused", async () => {
    const guild = await insertGuild(db.connection);

    const second = await db.race(
      [
        "SELECT public.apply_config_change($1, 2, $2, NULL, NULL, ARRAY[$3]::text[])",
        [guild.guildId, fakeId(), guild.channelId],
      ],
      (bot) =>
        createEvent(bot, {
          guildId: guild.guildId,
          channelId: guild.channelId,
          actorId: fakeId(),
          name: "Social",
          eventDate: "2030-02-01" as DateOnly,
        }),
    );

    expect(second).toEqual(PARENT_UNAVAILABLE);
  });
});
