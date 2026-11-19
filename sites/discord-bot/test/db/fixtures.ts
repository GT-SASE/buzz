import { fakeId, queryAs, type Connection } from "./harness.ts";

export const FIXTURE_DUE_DATE = "2030-01-10";

export interface GuildFixture {
  guildId: string;
  /** Shown as Events Directors. */
  officerRoleId: string;
  adminRoleId: string;
  channelId: string;
}

/** A guild with the four event workflow roles bound as well. */
export interface WorkflowGuildFixture extends GuildFixture {
  eboardRoleId: string;
  eventsCommitteeRoleId: string;
  treasuryRoleId: string;
  marketingRoleId: string;
}

/** Sets up a guild with all six roles and one managed channel, the way the bot would. */
export async function insertGuild(
  db: Connection,
): Promise<WorkflowGuildFixture> {
  const fixture = {
    guildId: fakeId(),
    officerRoleId: fakeId(),
    adminRoleId: fakeId(),
    eboardRoleId: fakeId(),
    eventsCommitteeRoleId: fakeId(),
    treasuryRoleId: fakeId(),
    marketingRoleId: fakeId(),
    channelId: fakeId(),
  };
  await queryAs(
    db,
    "bot_app",
    `SELECT public.apply_role_bindings($1, 0, $2, $3, $4, $5, $6, $7, $8)`,
    [
      fixture.guildId,
      fakeId(),
      fixture.officerRoleId,
      fixture.adminRoleId,
      fixture.eboardRoleId,
      fixture.eventsCommitteeRoleId,
      fixture.treasuryRoleId,
      fixture.marketingRoleId,
    ],
  );
  await queryAs(
    db,
    "bot_app",
    `SELECT public.apply_config_change($1, 1, $2, NULL, ARRAY[$3]::text[])`,
    [fixture.guildId, fakeId(), fixture.channelId],
  );
  return fixture;
}

export async function insertEvent(
  db: Connection,
  guild: GuildFixture,
): Promise<string> {
  const rows = await queryAs<{ id: string }>(
    db,
    "bot_app",
    `INSERT INTO public.events (guild_id, channel_id, name, event_date, created_by)
     VALUES ($1, $2, 'General meeting', '2030-01-15', $3)
     RETURNING id`,
    [guild.guildId, guild.channelId, fakeId()],
  );
  return (rows[0] as { id: string }).id;
}

export async function insertTask(
  db: Connection,
  guild: GuildFixture,
  eventId: string,
  assigneeId: string = fakeId(),
): Promise<string> {
  const rows = await queryAs<{ id: string }>(
    db,
    "bot_app",
    `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
     VALUES ($1, $2, $3, 'Book the room', '${FIXTURE_DUE_DATE}', $4)
     RETURNING id`,
    [eventId, guild.guildId, assigneeId, fakeId()],
  );
  return (rows[0] as { id: string }).id;
}

/**
 * Marks every workflow step of an event done, so the daily step reminder has nothing to
 * say about it. For tests about something else that would otherwise get that message.
 * Needs the owner's connection.
 */
export async function finishEventSteps(
  db: Connection,
  eventId: string,
): Promise<void> {
  await db.query(
    `UPDATE public.event_steps
     SET status = 'done', completed_at = now(), completed_by = $2
     WHERE event_id = $1`,
    [eventId, fakeId()],
  );
}
