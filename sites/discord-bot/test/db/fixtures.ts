import { bindRoles, changeConfig } from "./bot-writes.ts";
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
  await bindRoles(db, {
    guildId: fixture.guildId,
    actorId: fakeId(),
    officerRoleId: fixture.officerRoleId,
    adminRoleId: fixture.adminRoleId,
    eboardRoleId: fixture.eboardRoleId,
    eventsCommitteeRoleId: fixture.eventsCommitteeRoleId,
    treasuryRoleId: fixture.treasuryRoleId,
    marketingRoleId: fixture.marketingRoleId,
  });
  await changeConfig(db, {
    guildId: fixture.guildId,
    actorId: fakeId(),
    addChannelIds: [fixture.channelId],
  });
  return fixture;
}

export async function insertEvent(
  db: Connection,
  guild: GuildFixture,
): Promise<string> {
  const rows = await queryAs<{ id: string }>(
    db,
    "bot_app",
    `INSERT INTO discord_bot.events (guild_id, channel_id, name, event_date, created_by)
     VALUES ($1, $2, 'General meeting', '2030-01-15', $3)
     RETURNING id`,
    [guild.guildId, guild.channelId, fakeId()],
  );
  const id = (rows[0] as { id: string }).id;
  // A new event has a step of every kind. A trigger made them once, and the bot makes
  // them itself now, so a row put in by hand gets them here, whichever has run.
  await queryAs(
    db,
    "bot_app",
    `INSERT INTO discord_bot.event_steps (event_id, guild_id, kind)
     SELECT $1, $2, kind FROM unnest(enum_range(NULL::discord_bot.event_step_kind)) AS kind
     ON CONFLICT DO NOTHING`,
    [id, guild.guildId],
  );
  return id;
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
    `INSERT INTO discord_bot.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
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
    `UPDATE discord_bot.event_steps
     SET status = 'done', completed_at = now(), completed_by = $2
     WHERE event_id = $1`,
    [eventId, fakeId()],
  );
}
