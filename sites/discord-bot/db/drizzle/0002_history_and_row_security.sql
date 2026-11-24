-- Fail fast rather than queue behind live bot writes while holding a lock they would wait on.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "discord_bot"."interaction_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Two statements, edited by hand from the generated one: a volatile default on ADD COLUMN
-- rewrites the table and stamps every existing history row with this transaction.
-- Existing rows keep a null xid.
ALTER TABLE "discord_bot"."row_versions" ADD COLUMN "xid" text;--> statement-breakpoint
ALTER TABLE "discord_bot"."row_versions" ALTER COLUMN "xid" SET DEFAULT pg_current_xact_id()::text;--> statement-breakpoint
CREATE INDEX "row_versions_change_idx" ON "discord_bot"."row_versions" USING btree ("xid","source_table","row_id");--> statement-breakpoint
CREATE POLICY "interaction_claims_read" ON "discord_bot"."interaction_claims" AS PERMISSIVE FOR SELECT TO "bot_app" USING (true);--> statement-breakpoint
CREATE POLICY "interaction_claims_insert" ON "discord_bot"."interaction_claims" AS PERMISSIVE FOR INSERT TO "bot_app" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "interaction_claims_expire" ON "discord_bot"."interaction_claims" AS PERMISSIVE FOR DELETE TO "bot_app" USING ("discord_bot"."interaction_claims"."claimed_at" < now() - interval '1 day');