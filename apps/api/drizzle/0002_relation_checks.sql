-- Column rules per relation type (a value list kept as text, so the rules live here, not in an ENUM).
ALTER TABLE "relations" ADD CONSTRAINT "relations_type_columns" CHECK (
  CASE "type"
    WHEN 'work_creator' THEN "to_id" IS NOT NULL AND "role" IS NOT NULL
    WHEN 'series_work' THEN "to_id" IS NOT NULL AND "position" IS NOT NULL
    WHEN 'work_link' THEN "to_id" IS NOT NULL AND "link_type" IS NOT NULL
    WHEN 'property_work' THEN "to_id" IS NOT NULL
    WHEN 'work_tag' THEN "to_id" IS NOT NULL
    WHEN 'external_id' THEN "to_id" IS NULL AND "scheme" IS NOT NULL AND "value" IS NOT NULL
    ELSE false
  END
);
