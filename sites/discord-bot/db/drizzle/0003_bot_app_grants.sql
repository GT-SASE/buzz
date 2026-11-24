-- Grants only, which drizzle-kit cannot generate, and no logic. The bot now does in
-- TypeScript what its triggers did, so it needs the writes the triggers made on its behalf.

SET LOCAL lock_timeout = '3s';--> statement-breakpoint

-- The policies 0001 made by hand are replaced by the ones the schema declares.
DROP POLICY IF EXISTS interaction_claims_bot_read ON discord_bot.interaction_claims;--> statement-breakpoint
DROP POLICY IF EXISTS interaction_claims_bot_insert ON discord_bot.interaction_claims;--> statement-breakpoint
DROP POLICY IF EXISTS interaction_claims_bot_expire ON discord_bot.interaction_claims;--> statement-breakpoint

-- A new event gets its steps, and every change of a tracked row gets a history row.
GRANT INSERT ON TABLE discord_bot.event_steps, discord_bot.row_versions TO bot_app;--> statement-breakpoint
-- Read to skip a version a trigger already kept in the same transaction; P18b revokes it.
GRANT SELECT (xid, source_table, row_id, old_row) ON TABLE discord_bot.row_versions TO bot_app;--> statement-breakpoint

-- The quotas count what an officer has made and reassigned in a day.
GRANT SELECT ON TABLE discord_bot.task_reassignments TO bot_app;--> statement-breakpoint

-- updated_at moves with the row, which a trigger used to do.
GRANT UPDATE (updated_at) ON TABLE discord_bot.guild_config, discord_bot.managed_channels, discord_bot.event_steps TO bot_app;
