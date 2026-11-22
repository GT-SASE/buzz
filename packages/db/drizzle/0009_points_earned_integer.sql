-- Production widened "pointsEarned" to bigint and dropped the non-negative
-- check. Joke values and the early-bird, streak, and catch-up bonuses are
-- not the event's points. Reset every check-in to that event's pointsValue
-- before narrowing the column, or the cast and the check both fail.
-- A database that already applied an earlier copy of this file (type change
-- and a NOT VALID check, leaving negatives in place) will not re-run it.
-- 0010 repeats the reset and replaces that check with one that is validated.
ALTER TABLE "buzz_event_check_in" DROP CONSTRAINT IF EXISTS "buzz_check_in_points_earned_check";--> statement-breakpoint
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint AS con
    INNER JOIN pg_class AS rel ON rel.oid = con.conrelid
    INNER JOIN pg_namespace AS nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'buzz_event_check_in'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%pointsEarned%'
  LOOP
    EXECUTE format(
      'ALTER TABLE "buzz_event_check_in" DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;--> statement-breakpoint
UPDATE "buzz_event_check_in" AS check_in
SET "pointsEarned" = event."pointsValue"
FROM "buzz_event" AS event
WHERE check_in."eventId" = event.id
  AND check_in."pointsEarned" IS DISTINCT FROM event."pointsValue";--> statement-breakpoint
ALTER TABLE "buzz_event_check_in" ALTER COLUMN "pointsEarned" SET DATA TYPE integer USING "pointsEarned"::integer;--> statement-breakpoint
ALTER TABLE "buzz_event_check_in" ADD CONSTRAINT "buzz_check_in_points_earned_check" CHECK ("buzz_event_check_in"."pointsEarned" >= 0);
