ALTER TABLE "works" ADD COLUMN "original_title_norm" text;--> statement-breakpoint
-- Backfill: the same form as normalizeTitle (accents stripped, lowercased, whitespace collapsed).
-- Caveat: it strips only U+0300-036F, while normalizeTitle strips every \p{M} (PG regex has no \p).
UPDATE "works" SET "original_title_norm" = btrim(regexp_replace(lower(regexp_replace(normalize("original_title", NFKD), '[̀-ͯ]', '', 'g')), '\s+', ' ', 'g')) WHERE "original_title" IS NOT NULL;--> statement-breakpoint
-- Dropping the column drops works_search_idx with it.
ALTER TABLE "works" DROP COLUMN "search";--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title_norm, '') || ' ' || coalesce(original_title_norm, ''))) STORED;--> statement-breakpoint
CREATE INDEX "works_search_idx" ON "works" USING gin ("search");
