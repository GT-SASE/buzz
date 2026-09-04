CREATE TABLE "buzz_committee_application" (
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
ALTER TABLE "buzz_committee_application" ADD CONSTRAINT "buzz_committee_application_userId_buzz_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "buzz_committee_app_cycle_status_idx" ON "buzz_committee_application" USING btree ("cycle","status");