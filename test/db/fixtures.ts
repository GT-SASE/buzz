import { fakeId, queryAs, type Connection } from "./harness.ts";

/**
 * Runs bulk setup past the task quotas, which would otherwise refuse it and be far too
 * slow row by row. Needs the owner's connection, and turns them back on whatever happens.
 */
export async function withoutQuotas<T>(
  db: Connection,
  fn: () => Promise<T>,
): Promise<T> {
  await db.exec("ALTER TABLE public.tasks DISABLE TRIGGER tasks_require_quota");
  try {
    return await fn();
  } finally {
    await db.exec(
      "ALTER TABLE public.tasks ENABLE TRIGGER tasks_require_quota",
    );
  }
}

export const FIXTURE_DUE_DATE = "2030-01-10";

export interface GuildFixture {
  guildId: string;
  officerRoleId: string;
  adminRoleId: string;
  channelId: string;
}

/** Sets up a guild with one managed channel, the way the bot would. */
export async function insertGuild(db: Connection): Promise<GuildFixture> {
  const fixture = {
    guildId: fakeId(),
    officerRoleId: fakeId(),
    adminRoleId: fakeId(),
    channelId: fakeId(),
  };
  await queryAs(
    db,
    "service_role",
    `SELECT public.apply_role_bindings($1, 0, $2, $3, $4)`,
    [fixture.guildId, fakeId(), fixture.officerRoleId, fixture.adminRoleId],
  );
  await queryAs(
    db,
    "service_role",
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
    "service_role",
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
    "service_role",
    `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
     VALUES ($1, $2, $3, 'Book the room', '${FIXTURE_DUE_DATE}', $4)
     RETURNING id`,
    [eventId, guild.guildId, assigneeId, fakeId()],
  );
  return (rows[0] as { id: string }).id;
}
