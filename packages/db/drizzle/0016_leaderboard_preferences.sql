CREATE TABLE "buzz_leaderboard_preference" (
	"userId" varchar(255) PRIMARY KEY NOT NULL,
	"hideName" boolean DEFAULT false NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "buzz_leaderboard_preference" ADD CONSTRAINT "buzz_leaderboard_preference_userId_buzz_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;