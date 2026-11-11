CREATE INDEX "changes_entity_id_idx" ON "changes" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "changes_merge_into_idx" ON "changes" USING btree (("payload"->>'into')) WHERE "changes"."op" = 'merge';--> statement-breakpoint
CREATE INDEX "changes_merge_inverse_into_idx" ON "changes" USING btree (("inverse"->>'into')) WHERE "changes"."op" = 'merge';