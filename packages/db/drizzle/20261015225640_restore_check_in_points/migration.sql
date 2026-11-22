-- 0009 now resets points before it narrows the column. A database that
-- already applied an earlier 0009 (integer column and a NOT VALID check)
-- still has bonus and joke values. Drop that check, write each event's
-- pointsValue, and add the check so it is validated. A second run is a no-op
-- once every row already matches.
ALTER TABLE "buzz_event_check_in" DROP CONSTRAINT IF EXISTS "buzz_check_in_points_earned_check";--> statement-breakpoint
UPDATE "buzz_event_check_in" AS check_in
SET "pointsEarned" = event."pointsValue"
FROM "buzz_event" AS event
WHERE check_in."eventId" = event.id
  AND check_in."pointsEarned" IS DISTINCT FROM event."pointsValue";--> statement-breakpoint
ALTER TABLE "buzz_event_check_in" ADD CONSTRAINT "buzz_check_in_points_earned_check" CHECK ("buzz_event_check_in"."pointsEarned" >= 0);
