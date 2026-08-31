CREATE TABLE IF NOT EXISTS "buzz_mentorship_enrollment" (
	"userId" varchar(255) PRIMARY KEY NOT NULL,
	"role" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'interested' NOT NULL,
	"note" varchar(400),
	"points" integer DEFAULT 0 NOT NULL,
	"enrolledAt" timestamp with time zone,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone,
	CONSTRAINT "buzz_mentorship_role_check" CHECK ("buzz_mentorship_enrollment"."role" in ('mentor', 'mentee')),
	CONSTRAINT "buzz_mentorship_status_check" CHECK ("buzz_mentorship_enrollment"."status" in ('interested', 'enrolled', 'withdrawn')),
	CONSTRAINT "buzz_mentorship_points_check" CHECK ("buzz_mentorship_enrollment"."points" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "buzz_mentorship_enrollment" ADD CONSTRAINT "buzz_mentorship_enrollment_userId_buzz_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buzz_mentorship_status_idx" ON "buzz_mentorship_enrollment" USING btree ("status");
