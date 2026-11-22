CREATE TABLE IF NOT EXISTS "buzz_committee_application" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"userId" varchar(255) NOT NULL,
	"cycle" varchar(32) NOT NULL,
	"wantsEvents" boolean DEFAULT false NOT NULL,
	"wantsMarketing" boolean DEFAULT false NOT NULL,
	"wantsTreasury" boolean DEFAULT false NOT NULL,
	"discordHandle" varchar(80) NOT NULL,
	"eventsWhy" varchar(2000),
	"eventsCollabs" varchar(1000),
	"marketingWhy" varchar(2000),
	"marketingConnections" varchar(1000),
	"treasuryWhy" varchar(2000),
	"otherOrgs" varchar(1000),
	"comments" varchar(1000),
	"status" varchar(16) DEFAULT 'submitted' NOT NULL,
	"officerNotes" varchar(4000),
	"submittedAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone,
	CONSTRAINT "buzz_committee_app_user_cycle" UNIQUE("userId","cycle"),
	CONSTRAINT "buzz_committee_app_status_check" CHECK ("buzz_committee_application"."status" in ('submitted', 'interviewing', 'accepted', 'declined', 'withdrawn')),
	CONSTRAINT "buzz_committee_app_committee_check" CHECK ("buzz_committee_application"."wantsEvents" or "buzz_committee_application"."wantsMarketing" or "buzz_committee_application"."wantsTreasury")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "buzz_kin_group" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"year" varchar(9) NOT NULL,
	"name" varchar(80) NOT NULL,
	"description" varchar(600),
	"capacity" integer,
	"isOpen" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone,
	CONSTRAINT "buzz_kin_group_capacity_check" CHECK ("buzz_kin_group"."capacity" is null or "buzz_kin_group"."capacity" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "buzz_resume" (
	"userId" varchar(255) PRIMARY KEY NOT NULL,
	"fileName" varchar(180) NOT NULL,
	"mimeType" varchar(80) NOT NULL,
	"byteSize" integer NOT NULL,
	"fileBytes" text NOT NULL,
	"uploadedAt" timestamp with time zone NOT NULL,
	CONSTRAINT "buzz_resume_size_check" CHECK ("buzz_resume"."byteSize" > 0 and "buzz_resume"."byteSize" <= 2097152),
	CONSTRAINT "buzz_resume_mime_check" CHECK ("buzz_resume"."mimeType" = 'application/pdf')
);
--> statement-breakpoint
ALTER TABLE "buzz_mentorship_enrollment" ADD COLUMN IF NOT EXISTS "year" varchar(9);--> statement-breakpoint
UPDATE "buzz_mentorship_enrollment" SET "year" = '2026-2027' WHERE "year" IS NULL;--> statement-breakpoint
ALTER TABLE "buzz_mentorship_enrollment" ALTER COLUMN "year" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "buzz_mentorship_enrollment" DROP CONSTRAINT IF EXISTS "buzz_mentorship_enrollment_pkey";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "buzz_mentorship_enrollment" ADD CONSTRAINT "buzz_mentorship_enrollment_userId_year_pk" PRIMARY KEY("userId","year");
EXCEPTION
 WHEN invalid_table_definition THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "buzz_mentorship_enrollment" ADD COLUMN IF NOT EXISTS "groupId" varchar(255);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "buzz_committee_application" ADD CONSTRAINT "buzz_committee_application_userId_buzz_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "buzz_resume" ADD CONSTRAINT "buzz_resume_userId_buzz_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buzz_committee_app_cycle_status_idx" ON "buzz_committee_application" USING btree ("cycle","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "buzz_kin_group_year_name_idx" ON "buzz_kin_group" USING btree ("year",lower("name"));--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "buzz_mentorship_enrollment" ADD CONSTRAINT "buzz_mentorship_enrollment_groupId_buzz_kin_group_id_fk" FOREIGN KEY ("groupId") REFERENCES "public"."buzz_kin_group"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buzz_mentorship_year_idx" ON "buzz_mentorship_enrollment" USING btree ("year");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buzz_mentorship_group_idx" ON "buzz_mentorship_enrollment" USING btree ("groupId");