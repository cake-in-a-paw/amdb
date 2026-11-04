ALTER TABLE "users" ADD COLUMN "handle" "citext";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_handle_unique" UNIQUE("handle");