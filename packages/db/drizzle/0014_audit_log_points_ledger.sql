CREATE TABLE "buzz_audit_log" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"actorId" varchar(255) NOT NULL,
	"action" varchar(48) NOT NULL,
	"targetType" varchar(24) NOT NULL,
	"targetId" varchar(255),
	"targetLabel" varchar(255),
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buzz_points_ledger" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"userId" varchar(255) NOT NULL,
	"delta" integer NOT NULL,
	"reason" varchar(255) NOT NULL,
	"source" varchar(24) NOT NULL,
	"eventId" varchar(255),
	"actedByUserId" varchar(255),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buzz_points_ledger_source_check" CHECK ("buzz_points_ledger"."source" in ('check_in', 'manual_check_in', 'check_in_removed', 'kin_award', 'kin_group_award', 'opening_balance'))
);
--> statement-breakpoint
ALTER TABLE "buzz_points_ledger" ADD CONSTRAINT "buzz_points_ledger_userId_buzz_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_points_ledger" ADD CONSTRAINT "buzz_points_ledger_eventId_buzz_event_id_fk" FOREIGN KEY ("eventId") REFERENCES "public"."buzz_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_points_ledger" ADD CONSTRAINT "buzz_points_ledger_actedByUserId_buzz_user_id_fk" FOREIGN KEY ("actedByUserId") REFERENCES "public"."buzz_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "buzz_audit_log_at_idx" ON "buzz_audit_log" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "buzz_audit_log_actor_at_idx" ON "buzz_audit_log" USING btree ("actorId","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "buzz_audit_log_action_at_idx" ON "buzz_audit_log" USING btree ("action","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "buzz_points_ledger_user_at_idx" ON "buzz_points_ledger" USING btree ("userId","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "buzz_points_ledger_at_idx" ON "buzz_points_ledger" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "buzz_points_ledger_source_at_idx" ON "buzz_points_ledger" USING btree ("source","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "buzz_points_ledger_event_idx" ON "buzz_points_ledger" USING btree ("eventId");--> statement-breakpoint
-- Opening balances. Nothing is recomputed: each ledger row copies a number the
-- member already has, so every total reads the same before and after.
--
-- Attendance: one row per check-in, with the points snapshotted on it, dated
-- when it happened. Archived events are included; the roster drops them at
-- read time, as it always has, and the ledger leaves that to its reader.
INSERT INTO "buzz_points_ledger" ("id", "userId", "delta", "reason", "source", "eventId", "actedByUserId", "at")
SELECT
	gen_random_uuid()::text,
	check_in."userId",
	check_in."pointsEarned",
	left(
		CASE WHEN check_in."method" = 'manual' THEN 'Checked in by an officer: ' ELSE 'Checked in: ' END || event."title",
		255
	),
	CASE WHEN check_in."method" = 'manual' THEN 'manual_check_in' ELSE 'check_in' END,
	check_in."eventId",
	check_in."actedByUserId",
	check_in."checkedInAt"
FROM "buzz_event_check_in" AS check_in
INNER JOIN "buzz_event" AS event ON event."id" = check_in."eventId";--> statement-breakpoint
-- KIN points were only ever kept as a yearly total per member, never as
-- separate awards, so each non-zero total becomes one opening balance dated
-- at the row's last change. The per-semester copy on the group seat is part of
-- that total, not an addition to it, and is not copied.
INSERT INTO "buzz_points_ledger" ("id", "userId", "delta", "reason", "source", "at")
SELECT
	gen_random_uuid()::text,
	enrollment."userId",
	enrollment."points",
	'KIN points for ' || enrollment."year" || ', before the ledger',
	'opening_balance',
	COALESCE(enrollment."updatedAt", enrollment."createdAt")
FROM "buzz_mentorship_enrollment" AS enrollment
WHERE enrollment."points" <> 0;
