CREATE TABLE "buzz_election_ballot" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"positionId" varchar(255) NOT NULL,
	"candidateId" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buzz_election_roll" (
	"electionId" varchar(255) NOT NULL,
	"userId" varchar(255) NOT NULL,
	CONSTRAINT "buzz_election_roll_electionId_userId_pk" PRIMARY KEY("electionId","userId")
);
--> statement-breakpoint
CREATE TABLE "buzz_election_voter" (
	"electionId" varchar(255) NOT NULL,
	"positionId" varchar(255) NOT NULL,
	"voterId" varchar(255) NOT NULL,
	CONSTRAINT "buzz_election_voter_positionId_voterId_pk" PRIMARY KEY("positionId","voterId")
);
--> statement-breakpoint
ALTER TABLE "buzz_election" ADD COLUMN "opensAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "buzz_election" ADD COLUMN "closesAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "buzz_election" ADD COLUMN "minCheckIns" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "buzz_election" ADD COLUMN "rollFrozenAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "buzz_election_ballot" ADD CONSTRAINT "buzz_election_ballot_positionId_buzz_election_position_id_fk" FOREIGN KEY ("positionId") REFERENCES "public"."buzz_election_position"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_election_ballot" ADD CONSTRAINT "buzz_election_ballot_candidateId_buzz_election_candidate_id_fk" FOREIGN KEY ("candidateId") REFERENCES "public"."buzz_election_candidate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_election_roll" ADD CONSTRAINT "buzz_election_roll_electionId_buzz_election_id_fk" FOREIGN KEY ("electionId") REFERENCES "public"."buzz_election"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_election_roll" ADD CONSTRAINT "buzz_election_roll_userId_buzz_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_election_voter" ADD CONSTRAINT "buzz_election_voter_electionId_buzz_election_id_fk" FOREIGN KEY ("electionId") REFERENCES "public"."buzz_election"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_election_voter" ADD CONSTRAINT "buzz_election_voter_positionId_buzz_election_position_id_fk" FOREIGN KEY ("positionId") REFERENCES "public"."buzz_election_position"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_election_voter" ADD CONSTRAINT "buzz_election_voter_voterId_buzz_user_id_fk" FOREIGN KEY ("voterId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "buzz_election_ballot_position_idx" ON "buzz_election_ballot" USING btree ("positionId");--> statement-breakpoint
CREATE INDEX "buzz_election_ballot_candidate_idx" ON "buzz_election_ballot" USING btree ("candidateId");--> statement-breakpoint
CREATE INDEX "buzz_election_voter_election_idx" ON "buzz_election_voter" USING btree ("electionId");--> statement-breakpoint
ALTER TABLE "buzz_election" ADD CONSTRAINT "buzz_election_min_check_ins_check" CHECK ("buzz_election"."minCheckIns" >= 1);
CREATE TABLE "buzz_board_photo" (
	"userId" varchar(255) PRIMARY KEY NOT NULL,
	"contentType" varchar(16) NOT NULL,
	"byteSize" integer NOT NULL,
	"bytes" text NOT NULL,
	"etag" varchar(32) NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	CONSTRAINT "buzz_board_photo_size_check" CHECK ("buzz_board_photo"."byteSize" > 0 and "buzz_board_photo"."byteSize" <= 204800),
	CONSTRAINT "buzz_board_photo_type_check" CHECK ("buzz_board_photo"."contentType" = 'image/webp')
);
--> statement-breakpoint
ALTER TABLE "buzz_board_photo" ADD CONSTRAINT "buzz_board_photo_userId_buzz_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."buzz_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Data move. Runs once: it only acts while the old table exists, and the
-- table is dropped in the same statement. Voters and ballots are written in
-- separate statements, ballots in random order, so storage order cannot pair
-- a ballot with its voter. Every ballot becomes exactly one row, so every
-- tally is unchanged.
DO $$
BEGIN
  IF to_regclass('public.buzz_election_vote') IS NOT NULL THEN
    INSERT INTO "buzz_election_voter" ("electionId", "positionId", "voterId")
      SELECT p."electionId", v."positionId", v."voterId"
      FROM "buzz_election_vote" v
      JOIN "buzz_election_position" p ON p."id" = v."positionId"
      ON CONFLICT DO NOTHING;
    INSERT INTO "buzz_election_ballot" ("id", "positionId", "candidateId")
      SELECT gen_random_uuid()::text, v."positionId", v."candidateId"
      FROM "buzz_election_vote" v
      ORDER BY random();
    -- Elections already past nominating get a voter list: everyone who voted,
    -- plus, for one still voting, every member with a counted check-in this
    -- school year (the rule that applied until now).
    INSERT INTO "buzz_election_roll" ("electionId", "userId")
      SELECT DISTINCT "electionId", "voterId" FROM "buzz_election_voter"
      ON CONFLICT DO NOTHING;
    INSERT INTO "buzz_election_roll" ("electionId", "userId")
      SELECT DISTINCT e."id", c."userId"
      FROM "buzz_election" e
      JOIN "buzz_event_check_in" c
        ON c."checkedInAt" >= make_timestamptz(
             CASE WHEN extract(month FROM now() AT TIME ZONE 'America/New_York') >= 8
                  THEN extract(year FROM now() AT TIME ZONE 'America/New_York')::int
                  ELSE extract(year FROM now() AT TIME ZONE 'America/New_York')::int - 1 END,
             8, 1, 0, 0, 0, 'America/New_York')
      JOIN "buzz_event" ev ON ev."id" = c."eventId" AND ev."archivedAt" IS NULL
      WHERE e."phase" = 'voting'
      ON CONFLICT DO NOTHING;
    UPDATE "buzz_election" SET "rollFrozenAt" = COALESCE("updatedAt", "createdAt")
      WHERE "phase" <> 'nominating' AND "rollFrozenAt" IS NULL;
    DROP TABLE "buzz_election_vote";
  END IF;
END
$$;
