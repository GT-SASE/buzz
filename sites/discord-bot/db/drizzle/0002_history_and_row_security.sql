ALTER TABLE "discord_bot"."interaction_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Two statements, edited by hand from the generated one: a volatile default on ADD COLUMN
-- rewrites the table and stamps every existing history row with this transaction, which
-- could collide in the unique index below wherever a row came back to an earlier state.
-- Existing rows keep a null xid, and nulls never collide.
ALTER TABLE "discord_bot"."row_versions" ADD COLUMN "xid" text;--> statement-breakpoint
ALTER TABLE "discord_bot"."row_versions" ALTER COLUMN "xid" SET DEFAULT pg_current_xact_id()::text;--> statement-breakpoint
CREATE UNIQUE INDEX "row_versions_once_per_change_uq" ON "discord_bot"."row_versions" USING btree ("xid","source_table","row_id",md5("old_row"::text));--> statement-breakpoint
CREATE POLICY "interaction_claims_read" ON "discord_bot"."interaction_claims" AS PERMISSIVE FOR SELECT TO "bot_app" USING (true);--> statement-breakpoint
CREATE POLICY "interaction_claims_insert" ON "discord_bot"."interaction_claims" AS PERMISSIVE FOR INSERT TO "bot_app" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "interaction_claims_expire" ON "discord_bot"."interaction_claims" AS PERMISSIVE FOR DELETE TO "bot_app" USING ("discord_bot"."interaction_claims"."claimed_at" < now() - interval '1 day');