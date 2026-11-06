CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"params" jsonb NOT NULL,
	"license_url" text NOT NULL,
	"status" text NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp (3) with time zone,
	CONSTRAINT "import_runs_status" CHECK ("import_runs"."status" IN ('running', 'finished', 'failed', 'capped')),
	CONSTRAINT "import_runs_finished" CHECK (("import_runs"."status" = 'running') = ("import_runs"."finished_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "submissions" DROP CONSTRAINT "submissions_one_author";--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "import_run_id" uuid;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_import_run_id_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."import_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_one_author" CHECK (num_nonnulls("submissions"."author_user_id", "submissions"."anon_hash", "submissions"."import_run_id") = 1);