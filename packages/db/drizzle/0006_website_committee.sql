ALTER TABLE "buzz_committee_application" DROP CONSTRAINT IF EXISTS "buzz_committee_app_committee_check";--> statement-breakpoint
ALTER TABLE "buzz_committee_application" ADD COLUMN IF NOT EXISTS "wantsWebsite" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "buzz_committee_application" ADD COLUMN IF NOT EXISTS "websiteWhy" varchar(2000);--> statement-breakpoint
ALTER TABLE "buzz_committee_application" ADD COLUMN IF NOT EXISTS "websiteLinks" varchar(1000);--> statement-breakpoint
ALTER TABLE "buzz_committee_application" ADD CONSTRAINT "buzz_committee_app_committee_check" CHECK ("buzz_committee_application"."wantsEvents" or "buzz_committee_application"."wantsMarketing" or "buzz_committee_application"."wantsTreasury" or "buzz_committee_application"."wantsWebsite");
