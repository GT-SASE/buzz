CREATE TABLE "buzz_account" (
	"userId" varchar(255) NOT NULL,
	"type" varchar(255) NOT NULL,
	"provider" varchar(255) NOT NULL,
	"providerAccountId" varchar(255) NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" varchar(255),
	"scope" varchar(255),
	"id_token" text,
	"session_state" varchar(255),
	CONSTRAINT "buzz_account_provider_providerAccountId_pk" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
CREATE TABLE "buzz_event_check_in" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"eventId" varchar(255) NOT NULL,
	"userId" varchar(255) NOT NULL,
	"method" varchar(16) DEFAULT 'code' NOT NULL,
	"pointsEarned" integer NOT NULL,
	"actedByUserId" varchar(255),
	"checkedInAt" timestamp with time zone NOT NULL,
	CONSTRAINT "buzz_event_check_in_unique" UNIQUE("eventId","userId"),
	CONSTRAINT "buzz_check_in_method_check" CHECK ("buzz_event_check_in"."method" in ('code', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "buzz_event" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text,
	"location" varchar(200),
	"startsAt" timestamp with time zone NOT NULL,
	"pointsValue" integer DEFAULT 10 NOT NULL,
	"checkInCode" varchar(12) NOT NULL,
	"checkInEnabled" boolean DEFAULT true NOT NULL,
	"maxCheckIns" integer,
	"currentCheckIns" integer DEFAULT 0 NOT NULL,
	"archivedAt" timestamp with time zone,
	"createdById" varchar(255) NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "buzz_session" (
	"sessionToken" varchar(255) PRIMARY KEY NOT NULL,
	"userId" varchar(255) NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buzz_user" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" varchar(255),
	"email" varchar(255) NOT NULL,
	"emailVerified" timestamp with time zone,
	"image" varchar(255),
	"role" varchar(16) DEFAULT 'MEMBER' NOT NULL,
	CONSTRAINT "buzz_user_role_check" CHECK ("buzz_user"."role" in ('MEMBER', 'ADMIN'))
);
--> statement-breakpoint
CREATE TABLE "buzz_verification_token" (
	"identifier" varchar(255) NOT NULL,
	"token" varchar(255) NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "buzz_verification_token_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "buzz_account" ADD CONSTRAINT "buzz_account_userId_buzz_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_event_check_in" ADD CONSTRAINT "buzz_event_check_in_eventId_buzz_event_id_fk" FOREIGN KEY ("eventId") REFERENCES "public"."buzz_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_event_check_in" ADD CONSTRAINT "buzz_event_check_in_userId_buzz_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_event_check_in" ADD CONSTRAINT "buzz_event_check_in_actedByUserId_buzz_user_id_fk" FOREIGN KEY ("actedByUserId") REFERENCES "public"."buzz_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_event" ADD CONSTRAINT "buzz_event_createdById_buzz_user_id_fk" FOREIGN KEY ("createdById") REFERENCES "public"."buzz_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_session" ADD CONSTRAINT "buzz_session_userId_buzz_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "buzz_account_user_id_idx" ON "buzz_account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "buzz_event_check_in_event_checked_in_idx" ON "buzz_event_check_in" USING btree ("eventId","checkedInAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "buzz_event_check_in_user_checked_in_idx" ON "buzz_event_check_in" USING btree ("userId","checkedInAt" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "buzz_event_check_in_code_idx" ON "buzz_event" USING btree ("checkInCode");--> statement-breakpoint
CREATE INDEX "buzz_event_starts_at_idx" ON "buzz_event" USING btree ("startsAt");--> statement-breakpoint
CREATE INDEX "buzz_event_created_by_idx" ON "buzz_event" USING btree ("createdById");--> statement-breakpoint
CREATE INDEX "buzz_session_user_id_idx" ON "buzz_session" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "buzz_user_email_lower_idx" ON "buzz_user" USING btree (lower("email"));