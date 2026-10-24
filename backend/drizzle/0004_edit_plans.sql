CREATE TYPE "public"."plan_status" AS ENUM('proposed', 'previewing', 'applied', 'undone');--> statement-breakpoint
CREATE TABLE "edit_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"base_version" integer NOT NULL,
	"op" jsonb NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"strip" jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	"focus" real,
	"status" "plan_status" DEFAULT 'proposed' NOT NULL,
	"applied_version" integer,
	"undone_by_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "edit_plans" ADD CONSTRAINT "edit_plans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_plans" ADD CONSTRAINT "edit_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edit_plans_project_created_idx" ON "edit_plans" USING btree ("project_id","created_at");