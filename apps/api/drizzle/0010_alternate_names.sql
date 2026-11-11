ALTER TABLE "creators" ADD COLUMN "alternate_names" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "creators" ADD COLUMN "alternate_names_norm" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "alternate_titles" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "alternate_titles_norm" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "alt_search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', alternate_titles_norm)) STORED;--> statement-breakpoint
CREATE INDEX "works_alt_search_idx" ON "works" USING gin ("alt_search");