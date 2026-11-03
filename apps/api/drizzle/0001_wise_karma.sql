CREATE TABLE "auth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"account_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp (3) with time zone,
	"refresh_token_expires_at" timestamp (3) with time zone,
	"scope" text,
	"id_token" text,
	"password" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_passkeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp (3) with time zone DEFAULT now(),
	"aaguid" text
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"op" text NOT NULL,
	"kind" text NOT NULL,
	"entity_id" uuid,
	"relation_id" uuid,
	"payload" jsonb,
	"base" jsonb,
	"inverse" jsonb,
	"status" text NOT NULL,
	"reason" text,
	"depends_on" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"resubmit_of" uuid,
	"reviewed_by" uuid,
	"reviewed_at" timestamp (3) with time zone,
	"applied_at" timestamp (3) with time zone,
	"redacted_at" timestamp (3) with time zone,
	"redaction_reason" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creators" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"name_norm" text NOT NULL,
	"kind" text NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"merged_into_id" uuid,
	"removed_at" timestamp (3) with time zone,
	"field_sources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"title_norm" text NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid,
	"role" text,
	"position" integer,
	"link_type" text,
	"scheme" text,
	"value" text,
	"created_by_change" uuid NOT NULL,
	"removed_by_change" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "series" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"title_norm" text NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_user_id" uuid,
	"anon_hash" text,
	"note" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submissions_one_author" CHECK (("submissions"."author_user_id" IS NOT NULL) <> ("submissions"."anon_hash" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	CONSTRAINT "tags_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"image" text,
	"role" text DEFAULT 'contributor' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "works" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"media_type" text NOT NULL,
	"subtype" text,
	"title" text NOT NULL,
	"title_norm" text NOT NULL,
	"original_title" text,
	"description" text,
	"release_year" smallint,
	"release_month" smallint,
	"release_day" smallint,
	"lifecycle" text DEFAULT 'unknown' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title_norm, '') || ' ' || coalesce(original_title, ''))) STORED,
	CONSTRAINT "works_subtype" CHECK (("works"."media_type" = 'film_tv') = ("works"."subtype" IS NOT NULL)),
	CONSTRAINT "works_release_month_needs_year" CHECK ("works"."release_month" IS NULL OR "works"."release_year" IS NOT NULL),
	CONSTRAINT "works_release_day_needs_month" CHECK ("works"."release_day" IS NULL OR "works"."release_month" IS NOT NULL),
	CONSTRAINT "works_release_year_range" CHECK ("works"."release_year" BETWEEN 1 AND 9999),
	CONSTRAINT "works_release_month_range" CHECK ("works"."release_month" BETWEEN 1 AND 12),
	CONSTRAINT "works_release_day_valid" CHECK (CASE WHEN "works"."release_day" IS NULL THEN true
        WHEN "works"."release_year" NOT BETWEEN 1 AND 9999 OR "works"."release_month" NOT BETWEEN 1 AND 12 THEN false
        ELSE "works"."release_day" BETWEEN 1 AND extract(day FROM make_date("works"."release_year", "works"."release_month", 1) + interval '1 month - 1 day') END)
);
--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_passkeys" ADD CONSTRAINT "auth_passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_relation_id_relations_id_fk" FOREIGN KEY ("relation_id") REFERENCES "public"."relations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_resubmit_of_changes_id_fk" FOREIGN KEY ("resubmit_of") REFERENCES "public"."changes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creators" ADD CONSTRAINT "creators_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_merged_into_id_entities_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_from_id_entities_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_to_id_entities_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_created_by_change_changes_id_fk" FOREIGN KEY ("created_by_change") REFERENCES "public"."changes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_removed_by_change_changes_id_fk" FOREIGN KEY ("removed_by_change") REFERENCES "public"."changes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series" ADD CONSTRAINT "series_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_accounts_provider_account_key" ON "auth_accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "auth_accounts_user_idx" ON "auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_passkeys_user_idx" ON "auth_passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_passkeys_credential_idx" ON "auth_passkeys" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "changes_status_created_idx" ON "changes" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "relations_from_idx" ON "relations" USING btree ("from_id") WHERE "relations"."removed_by_change" IS NULL;--> statement-breakpoint
CREATE INDEX "relations_to_idx" ON "relations" USING btree ("to_id") WHERE "relations"."removed_by_change" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "relations_external_id_key" ON "relations" USING btree ("scheme","value") WHERE "relations"."type" = 'external_id' AND "relations"."removed_by_change" IS NULL;--> statement-breakpoint
CREATE INDEX "works_search_idx" ON "works" USING gin ("search");