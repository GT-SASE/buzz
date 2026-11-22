CREATE TABLE IF NOT EXISTS "buzz_event_rsvp" (
	"eventId" varchar(255) NOT NULL,
	"userId" varchar(255) NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	CONSTRAINT "buzz_event_rsvp_eventId_userId_pk" PRIMARY KEY("eventId","userId")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "buzz_event_rsvp" ADD CONSTRAINT "buzz_event_rsvp_eventId_buzz_event_id_fk" FOREIGN KEY ("eventId") REFERENCES "public"."buzz_event"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "buzz_event_rsvp" ADD CONSTRAINT "buzz_event_rsvp_userId_buzz_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buzz_event_rsvp_user_idx" ON "buzz_event_rsvp" USING btree ("userId");
--> statement-breakpoint
UPDATE "buzz_event" SET "title" = 'SASExSpaceXAI' WHERE "title" = 'Vibecoding a personal website';
