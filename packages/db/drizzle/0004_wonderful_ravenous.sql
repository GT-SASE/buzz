CREATE TABLE "buzz_committee_cycle" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"closesAt" timestamp with time zone NOT NULL,
	"createdById" varchar(255),
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "buzz_election_candidate" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"positionId" varchar(255) NOT NULL,
	"userId" varchar(255) NOT NULL,
	"statement" varchar(1000) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	CONSTRAINT "buzz_election_candidate_unique" UNIQUE("positionId","userId"),
	CONSTRAINT "buzz_election_candidate_status_check" CHECK ("buzz_election_candidate"."status" in ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "buzz_election_position" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"electionId" varchar(255) NOT NULL,
	"title" varchar(80) NOT NULL,
	"sortOrder" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buzz_election_vote" (
	"positionId" varchar(255) NOT NULL,
	"voterId" varchar(255) NOT NULL,
	"candidateId" varchar(255) NOT NULL,
	"castAt" timestamp with time zone NOT NULL,
	CONSTRAINT "buzz_election_vote_positionId_voterId_pk" PRIMARY KEY("positionId","voterId")
);
--> statement-breakpoint
CREATE TABLE "buzz_election" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"year" varchar(9) NOT NULL,
	"title" varchar(120) NOT NULL,
	"phase" varchar(16) DEFAULT 'nominating' NOT NULL,
	"createdById" varchar(255),
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone,
	CONSTRAINT "buzz_election_phase_check" CHECK ("buzz_election"."phase" in ('nominating', 'voting', 'closed', 'published'))
);
--> statement-breakpoint
CREATE TABLE "buzz_kin_membership" (
	"userId" varchar(255) NOT NULL,
	"semester" varchar(16) NOT NULL,
	"groupId" varchar(255) NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"joinedAt" timestamp with time zone NOT NULL,
	CONSTRAINT "buzz_kin_membership_userId_semester_pk" PRIMARY KEY("userId","semester"),
	CONSTRAINT "buzz_kin_membership_points_check" CHECK ("buzz_kin_membership"."points" >= 0)
);
--> statement-breakpoint
ALTER TABLE "buzz_mentorship_enrollment" DROP CONSTRAINT "buzz_mentorship_enrollment_groupId_buzz_kin_group_id_fk";
--> statement-breakpoint
DROP INDEX "buzz_kin_group_year_name_idx";--> statement-breakpoint
DROP INDEX "buzz_mentorship_group_idx";--> statement-breakpoint
ALTER TABLE "buzz_kin_group" ADD COLUMN "semester" varchar(16);--> statement-breakpoint
UPDATE "buzz_kin_group" SET "semester" = 'fall-' || split_part("year", '-', 1) WHERE "semester" IS NULL;--> statement-breakpoint
ALTER TABLE "buzz_kin_group" ALTER COLUMN "semester" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "buzz_committee_cycle" ADD CONSTRAINT "buzz_committee_cycle_createdById_buzz_user_id_fk" FOREIGN KEY ("createdById") REFERENCES "public"."buzz_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_election_candidate" ADD CONSTRAINT "buzz_election_candidate_positionId_buzz_election_position_id_fk" FOREIGN KEY ("positionId") REFERENCES "public"."buzz_election_position"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_election_candidate" ADD CONSTRAINT "buzz_election_candidate_userId_buzz_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_election_position" ADD CONSTRAINT "buzz_election_position_electionId_buzz_election_id_fk" FOREIGN KEY ("electionId") REFERENCES "public"."buzz_election"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_election_vote" ADD CONSTRAINT "buzz_election_vote_positionId_buzz_election_position_id_fk" FOREIGN KEY ("positionId") REFERENCES "public"."buzz_election_position"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_election_vote" ADD CONSTRAINT "buzz_election_vote_voterId_buzz_user_id_fk" FOREIGN KEY ("voterId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_election_vote" ADD CONSTRAINT "buzz_election_vote_candidateId_buzz_election_candidate_id_fk" FOREIGN KEY ("candidateId") REFERENCES "public"."buzz_election_candidate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_election" ADD CONSTRAINT "buzz_election_createdById_buzz_user_id_fk" FOREIGN KEY ("createdById") REFERENCES "public"."buzz_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_kin_membership" ADD CONSTRAINT "buzz_kin_membership_userId_buzz_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_kin_membership" ADD CONSTRAINT "buzz_kin_membership_groupId_buzz_kin_group_id_fk" FOREIGN KEY ("groupId") REFERENCES "public"."buzz_kin_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "buzz_election_position_election_idx" ON "buzz_election_position" USING btree ("electionId");--> statement-breakpoint
CREATE INDEX "buzz_election_vote_candidate_idx" ON "buzz_election_vote" USING btree ("candidateId");--> statement-breakpoint
CREATE INDEX "buzz_election_year_idx" ON "buzz_election" USING btree ("year");--> statement-breakpoint
CREATE INDEX "buzz_kin_membership_group_idx" ON "buzz_kin_membership" USING btree ("groupId");--> statement-breakpoint
CREATE UNIQUE INDEX "buzz_kin_group_semester_name_idx" ON "buzz_kin_group" USING btree ("semester",lower("name"));--> statement-breakpoint
CREATE INDEX "buzz_kin_group_year_idx" ON "buzz_kin_group" USING btree ("year");--> statement-breakpoint
INSERT INTO "buzz_kin_membership" ("userId", "semester", "groupId", "points", "joinedAt")
SELECT e."userId", g."semester", e."groupId", 0, coalesce(e."enrolledAt", now())
FROM "buzz_mentorship_enrollment" e JOIN "buzz_kin_group" g ON g."id" = e."groupId"
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "buzz_mentorship_enrollment" DROP COLUMN "groupId";--> statement-breakpoint
INSERT INTO "buzz_committee_cycle" ("id", "closesAt", "createdAt") VALUES ('fall-2026', '2026-09-10T04:00:00.000Z', now()) ON CONFLICT DO NOTHING;