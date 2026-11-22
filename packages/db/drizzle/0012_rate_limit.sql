CREATE TABLE "buzz_rate_limit" (
	"key" varchar(255) NOT NULL,
	"windowStart" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "buzz_rate_limit_key_windowStart_pk" PRIMARY KEY("key","windowStart")
);
--> statement-breakpoint
CREATE INDEX "buzz_rate_limit_window_start_idx" ON "buzz_rate_limit" USING btree ("windowStart");