import { describe, expect, it } from "vitest";
import {
  claimStepHandoff,
  completeEventStep,
} from "../../src/db/event-steps.ts";
import { markOwnTaskDone } from "../../src/db/tasks.ts";
import { insertEvent, insertGuild, insertTask } from "../db/fixtures.ts";
import { fakeId, queryAs } from "../db/harness.ts";
import { raceDatabase } from "./race.ts";

/** Two clicks on the same Done button, each handled by its own function instance. */
describe("a double click on Done", () => {
  const db = raceDatabase();

  it("marks a task done once, and the second click finds nothing to change", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const assignee = fakeId();
    const taskId = await insertTask(db.connection, guild, eventId, assignee);

    const second = await db.race(
      [
        `UPDATE public.tasks SET status = 'done', completed_at = now()
         WHERE id = $1 AND guild_id = $2 AND assignee_id = $3
           AND status = 'open' AND deleted_at IS NULL
         RETURNING id`,
        [taskId, guild.guildId, assignee],
      ],
      (bot) =>
        markOwnTaskDone(bot, {
          guildId: guild.guildId,
          taskId,
          assigneeId: assignee,
          now: new Date(),
        }),
    );

    expect(second).toEqual({
      ok: false,
      error: { category: "not_found", code: null },
    });
    const { rows } = await db.observer.query(
      "SELECT status FROM public.tasks WHERE id = $1",
      [taskId],
    );
    expect(rows).toEqual([{ status: "done" }]);
  });

  it("marks a step done once, and the second click is told it was done already", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);

    const second = await db.race(
      [
        "SELECT public.complete_event_step($1, $2, 'budget_sheet', $3)",
        [eventId, guild.guildId, fakeId()],
      ],
      (bot) =>
        completeEventStep(bot, {
          guildId: guild.guildId,
          eventId,
          kind: "budget_sheet",
          actorId: fakeId(),
        }),
    );

    expect(second).toEqual({ ok: true, value: false });
  });

  it("hands a finished step off once, so the next role is pinged once", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    await queryAs(
      db.connection,
      "bot_app",
      "SELECT public.complete_event_step($1, $2, 'budget_sheet', $3)",
      [eventId, guild.guildId, fakeId()],
    );

    const second = await db.race(
      [
        "SELECT public.claim_step_handoff($1, $2, 'budget_sheet')",
        [eventId, guild.guildId],
      ],
      (bot) =>
        claimStepHandoff(bot, {
          guildId: guild.guildId,
          eventId,
          kind: "budget_sheet",
        }),
    );

    expect(second).toEqual({ ok: true, value: false });
    const { rows } = await db.observer.query(
      `SELECT handoff_claimed_at IS NOT NULL AS claimed FROM public.event_steps
       WHERE event_id = $1 AND kind = 'budget_sheet'`,
      [eventId],
    );
    expect(rows).toEqual([{ claimed: true }]);
  });
});
