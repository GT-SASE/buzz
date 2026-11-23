CREATE TABLE "buzz_event_series_member" (
	"eventId" varchar(255) PRIMARY KEY NOT NULL,
	"seriesId" varchar(255) NOT NULL,
	"cadence" varchar(12) NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "buzz_event_series_member_cadence_check" CHECK ("buzz_event_series_member"."cadence" in ('weekly', 'biweekly')),
	CONSTRAINT "buzz_event_series_member_position_check" CHECK ("buzz_event_series_member"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "buzz_event_waitlist" (
	"eventId" varchar(255) NOT NULL,
	"userId" varchar(255) NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	CONSTRAINT "buzz_event_waitlist_eventId_userId_pk" PRIMARY KEY("eventId","userId")
);
--> statement-breakpoint
ALTER TABLE "buzz_event_series_member" ADD CONSTRAINT "buzz_event_series_member_eventId_buzz_event_id_fk" FOREIGN KEY ("eventId") REFERENCES "public"."buzz_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_event_waitlist" ADD CONSTRAINT "buzz_event_waitlist_eventId_buzz_event_id_fk" FOREIGN KEY ("eventId") REFERENCES "public"."buzz_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_event_waitlist" ADD CONSTRAINT "buzz_event_waitlist_userId_buzz_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "buzz_event_series_member_series_idx" ON "buzz_event_series_member" USING btree ("seriesId","position");--> statement-breakpoint
CREATE INDEX "buzz_event_waitlist_queue_idx" ON "buzz_event_waitlist" USING btree ("eventId","createdAt");--> statement-breakpoint
CREATE INDEX "buzz_event_waitlist_user_idx" ON "buzz_event_waitlist" USING btree ("userId");