-- Production drifted to bigint with this check dropped, and holds a hand-entered negative row. NOT VALID restores the check for every new or updated row without failing on rows already there.
ALTER TABLE "buzz_event_check_in" ALTER COLUMN "pointsEarned" SET DATA TYPE integer USING "pointsEarned"::integer;--> statement-breakpoint
ALTER TABLE "buzz_event_check_in" DROP CONSTRAINT IF EXISTS "buzz_check_in_points_earned_check";--> statement-breakpoint
ALTER TABLE "buzz_event_check_in" ADD CONSTRAINT "buzz_check_in_points_earned_check" CHECK ("buzz_event_check_in"."pointsEarned" >= 0) NOT VALID;
