ALTER TABLE "buzz_event_check_in" ADD CONSTRAINT "buzz_check_in_points_earned_check" CHECK ("buzz_event_check_in"."pointsEarned" >= 0);--> statement-breakpoint
ALTER TABLE "buzz_event" ADD CONSTRAINT "buzz_event_points_value_check" CHECK ("buzz_event"."pointsValue" >= 0);--> statement-breakpoint
ALTER TABLE "buzz_event" ADD CONSTRAINT "buzz_event_max_check_ins_check" CHECK ("buzz_event"."maxCheckIns" is null or "buzz_event"."maxCheckIns" > 0);--> statement-breakpoint
ALTER TABLE "buzz_event" ADD CONSTRAINT "buzz_event_current_check_ins_check" CHECK ("buzz_event"."currentCheckIns" >= 0);