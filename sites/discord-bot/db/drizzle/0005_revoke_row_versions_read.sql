-- Takes back the read of the row history that the release which still had the triggers
-- gave the bot, to skip a version a trigger had kept. The triggers are gone and so is that
-- check, so the bot only adds rows to row_versions again.
-- Fail fast rather than queue behind live bot writes.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
REVOKE SELECT (xid, source_table, row_id, old_row) ON TABLE discord_bot.row_versions FROM bot_app;
