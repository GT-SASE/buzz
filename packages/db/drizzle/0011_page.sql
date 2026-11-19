CREATE TABLE "buzz_page" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"slug" varchar(60) NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" varchar(300) DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"createdById" varchar(255),
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "buzz_page" ADD CONSTRAINT "buzz_page_createdById_buzz_user_id_fk" FOREIGN KEY ("createdById") REFERENCES "public"."buzz_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "buzz_page_slug_idx" ON "buzz_page" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "buzz_page_updated_at_idx" ON "buzz_page" USING btree ("updatedAt");