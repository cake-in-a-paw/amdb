CREATE UNIQUE INDEX "relations_one_parent" ON "relations" USING btree ("to_id") WHERE "relations"."type" = 'work_part' AND "relations"."removed_by_change" IS NULL;--> statement-breakpoint
CREATE INDEX "relations_parts_idx" ON "relations" USING btree ("from_id","position") WHERE "relations"."type" = 'work_part' AND "relations"."removed_by_change" IS NULL;--> statement-breakpoint
-- Allow the new type in the column rules (hand SQL from 0002, which drizzle doesn't model). The other arms are verbatim.
ALTER TABLE "relations" DROP CONSTRAINT "relations_type_columns";--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_type_columns" CHECK (
  CASE "type"
    WHEN 'work_creator' THEN "to_id" IS NOT NULL AND "role" IS NOT NULL
    WHEN 'series_work' THEN "to_id" IS NOT NULL AND "position" IS NOT NULL
    WHEN 'work_link' THEN "to_id" IS NOT NULL AND "link_type" IS NOT NULL
    WHEN 'property_work' THEN "to_id" IS NOT NULL
    WHEN 'work_tag' THEN "to_id" IS NOT NULL
    WHEN 'work_part' THEN "to_id" IS NOT NULL
    WHEN 'external_id' THEN "to_id" IS NULL AND "scheme" IS NOT NULL AND "value" IS NOT NULL
    ELSE false
  END
);
