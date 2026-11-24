CREATE TABLE "buzz_page_image" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"contentType" varchar(16) NOT NULL,
	"byteSize" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" text NOT NULL,
	"etag" varchar(32) NOT NULL,
	"createdById" varchar(255),
	"createdAt" timestamp with time zone NOT NULL,
	CONSTRAINT "buzz_page_image_size_check" CHECK ("buzz_page_image"."byteSize" > 0 and "buzz_page_image"."byteSize" <= 1048576),
	CONSTRAINT "buzz_page_image_type_check" CHECK ("buzz_page_image"."contentType" = 'image/webp'),
	CONSTRAINT "buzz_page_image_dims_check" CHECK ("buzz_page_image"."width" between 1 and 1600 and "buzz_page_image"."height" between 1 and 10000)
);
--> statement-breakpoint
CREATE TABLE "buzz_page_redirect" (
	"fromSlug" varchar(60) PRIMARY KEY NOT NULL,
	"pageId" varchar(255) NOT NULL,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buzz_page_version" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"pageId" varchar(255) NOT NULL,
	"number" integer NOT NULL,
	"slug" varchar(60) NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" varchar(300) DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"restoredFrom" integer,
	"createdById" varchar(255),
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	"publishedAt" timestamp with time zone,
	"supersededAt" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "buzz_page_image" ADD CONSTRAINT "buzz_page_image_createdById_buzz_user_id_fk" FOREIGN KEY ("createdById") REFERENCES "public"."buzz_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_page_redirect" ADD CONSTRAINT "buzz_page_redirect_pageId_buzz_page_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."buzz_page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_page_version" ADD CONSTRAINT "buzz_page_version_pageId_buzz_page_id_fk" FOREIGN KEY ("pageId") REFERENCES "public"."buzz_page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buzz_page_version" ADD CONSTRAINT "buzz_page_version_createdById_buzz_user_id_fk" FOREIGN KEY ("createdById") REFERENCES "public"."buzz_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "buzz_page_redirect_page_idx" ON "buzz_page_redirect" USING btree ("pageId");--> statement-breakpoint
CREATE UNIQUE INDEX "buzz_page_version_number_idx" ON "buzz_page_version" USING btree ("pageId","number");--> statement-breakpoint
CREATE UNIQUE INDEX "buzz_page_version_open_idx" ON "buzz_page_version" USING btree ("pageId") WHERE "buzz_page_version"."publishedAt" is null and "buzz_page_version"."supersededAt" is null;--> statement-breakpoint
INSERT INTO "buzz_page_version" ("id", "pageId", "number", "slug", "title", "description", "body", "createdById", "createdAt", "updatedAt", "publishedAt")
SELECT gen_random_uuid()::text, "id", 1, "slug", "title", "description", "body", "createdById", "createdAt", "updatedAt",
  CASE WHEN "published" THEN "updatedAt" ELSE NULL END
FROM "buzz_page"
WHERE "slug" <> 'site-banner';
