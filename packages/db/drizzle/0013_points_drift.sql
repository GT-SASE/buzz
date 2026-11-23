-- Production ran earlier drafts of 0009 and 0010 (see their comments), so it
-- lacks the non-negative checks on "buzz_event_check_in"."pointsEarned" and
-- "buzz_mentorship_enrollment"."points", and "points" is bigint there. Values
-- the app cannot produce were then written to both tables. Repair the rows,
-- then restore what schema.ts declares. Every step is a no-op on a database
-- built from 0000-0012: the checks exist, "points" is integer, and no row is
-- negative.
-- A negative check-in is reset to its event's pointsValue, the same value 0009
-- and 0010 give every check-in. A negative mentorship balance becomes 0.
UPDATE "buzz_event_check_in" AS check_in
SET "pointsEarned" = event."pointsValue"
FROM "buzz_event" AS event
WHERE check_in."eventId" = event.id
  AND check_in."pointsEarned" < 0;--> statement-breakpoint
UPDATE "buzz_mentorship_enrollment" SET "points" = 0 WHERE "points" < 0;--> statement-breakpoint
ALTER TABLE "buzz_mentorship_enrollment" ALTER COLUMN "points" SET DATA TYPE integer USING "points"::integer;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'buzz_event_check_in'::regclass
      AND conname = 'buzz_check_in_points_earned_check'
  ) THEN
    ALTER TABLE "buzz_event_check_in" ADD CONSTRAINT "buzz_check_in_points_earned_check" CHECK ("buzz_event_check_in"."pointsEarned" >= 0);
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'buzz_mentorship_enrollment'::regclass
      AND conname = 'buzz_mentorship_points_check'
  ) THEN
    ALTER TABLE "buzz_mentorship_enrollment" ADD CONSTRAINT "buzz_mentorship_points_check" CHECK ("buzz_mentorship_enrollment"."points" >= 0);
  END IF;
END $$;
