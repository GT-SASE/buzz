CREATE TABLE "buzz_notification_preference" (
	"userId" varchar(255) PRIMARY KEY NOT NULL,
	"eventEmails" boolean DEFAULT true NOT NULL,
	"electionEmails" boolean DEFAULT true NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "buzz_notification_preference" ADD CONSTRAINT "buzz_notification_preference_userId_buzz_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;