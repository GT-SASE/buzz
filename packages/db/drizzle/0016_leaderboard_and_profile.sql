CREATE TABLE "buzz_leaderboard_preference" (
	"userId" varchar(255) PRIMARY KEY NOT NULL,
	"hideName" boolean DEFAULT false NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buzz_member_profile" (
	"userId" varchar(255) PRIMARY KEY NOT NULL,
	"graduationYear" smallint,
	"updatedAt" timestamp with time zone NOT NULL,
	CONSTRAINT "buzz_member_profile_graduation_year_check" CHECK ("buzz_member_profile"."graduationYear" is null or "buzz_member_profile"."graduationYear" between 2000 and 2100)
);
--> statement-breakpoint
ALTER TABLE "buzz_leaderboard_preference" ADD CONSTRAINT "buzz_leaderboard_preference_userId_buzz_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_member_profile" ADD CONSTRAINT "buzz_member_profile_userId_buzz_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;