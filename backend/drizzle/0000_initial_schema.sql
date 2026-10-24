-- Trigram indexes (fuzzy Hinglish matching) need this. It is a trusted extension, so the database owner can create it, including on RDS.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."asset_kind" AS ENUM('raw', 'scene_clip', 'proxy', 'export', 'thumbnail', 'audio');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."content_type" AS ENUM('youtuber', 'business', 'clipper');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('processing', 'export', 'otio', 'delete_project', 'delete_account', 'cleanup_uploads');--> statement-breakpoint
CREATE TYPE "public"."lang" AS ENUM('hi', 'hinglish', 'en');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('free', 'creator', 'studio');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('uploading', 'processing', 'ready', 'exported', 'failed');--> statement-breakpoint
CREATE TYPE "public"."stage_status" AS ENUM('pending', 'running', 'done', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('initiated', 'uploading', 'completing', 'completed', 'aborted', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."usage_kind" AS ENUM('upload', 'video_seconds', 'export');--> statement-breakpoint
CREATE TYPE "public"."version_author" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."word_lang" AS ENUM('hi', 'en');--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"language" "lang" DEFAULT 'hinglish' NOT NULL,
	"content_type" "content_type",
	"onboarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"plan" "plan" DEFAULT 'free' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "project_status" DEFAULT 'uploading' NOT NULL,
	"duration_sec" double precision,
	"source_language" "lang" DEFAULT 'hinglish' NOT NULL,
	"thumb_seed" text NOT NULL,
	"hooks_found" integer,
	"plan_limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_duration_nonneg" CHECK ("projects"."duration_sec" is null or "projects"."duration_sec" >= 0)
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"status" "asset_status" DEFAULT 'pending' NOT NULL,
	"storage_key" text NOT NULL,
	"label" text NOT NULL,
	"mime_type" text,
	"size_bytes" bigint,
	"duration_sec" double precision,
	"width" integer,
	"height" integer,
	"codec" text,
	"checksum" text,
	"scene_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_size_nonneg" CHECK ("assets"."size_bytes" is null or "assets"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "chapters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"title" text NOT NULL,
	"start_sec" double precision NOT NULL,
	"end_sec" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chapters_range" CHECK ("chapters"."end_sec" > "chapters"."start_sec")
);
--> statement-breakpoint
CREATE TABLE "highlights" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"title" text NOT NULL,
	"start_sec" double precision NOT NULL,
	"end_sec" double precision NOT NULL,
	"hook_score" integer NOT NULL,
	"reason" text NOT NULL,
	"thumb_seed" text NOT NULL,
	"source" text DEFAULT 'heuristic' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "highlights_score" CHECK ("highlights"."hook_score" between 0 and 100),
	CONSTRAINT "highlights_range" CHECK ("highlights"."end_sec" > "highlights"."start_sec")
);
--> statement-breakpoint
CREATE TABLE "scenes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"label" text NOT NULL,
	"start_sec" double precision NOT NULL,
	"end_sec" double precision NOT NULL,
	"score" real,
	"keyframes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"thumbnail_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scenes_range" CHECK ("scenes"."start_sec" >= 0 and "scenes"."end_sec" > "scenes"."start_sec")
);
--> statement-breakpoint
CREATE TABLE "silences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"start_sec" double precision NOT NULL,
	"end_sec" double precision NOT NULL,
	CONSTRAINT "silences_range" CHECK ("silences"."end_sec" > "silences"."start_sec")
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"declared_duration_sec" double precision,
	"storage_key" text NOT NULL,
	"s3_upload_id" text NOT NULL,
	"part_size" integer NOT NULL,
	"total_parts" integer NOT NULL,
	"parts_received" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "upload_status" DEFAULT 'initiated' NOT NULL,
	"checksum" text,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uploads_size_positive" CHECK ("uploads"."size_bytes" > 0),
	CONSTRAINT "uploads_parts_positive" CHECK ("uploads"."total_parts" > 0 and "uploads"."part_size" > 0)
);
--> statement-breakpoint
CREATE TABLE "transcript_sentences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transcript_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"speaker" text NOT NULL,
	"from_word" integer NOT NULL,
	"to_word" integer NOT NULL,
	"start_sec" double precision NOT NULL,
	"end_sec" double precision NOT NULL,
	"text" text NOT NULL,
	"dev" text NOT NULL,
	"norm" text NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("norm", '') || ' ' || coalesce("dev", ''))) STORED,
	CONSTRAINT "sentences_words" CHECK ("transcript_sentences"."to_word" > "transcript_sentences"."from_word")
);
--> statement-breakpoint
CREATE TABLE "transcript_words" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transcript_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"text" text NOT NULL,
	"dev" text NOT NULL,
	"norm" text NOT NULL,
	"start_sec" double precision NOT NULL,
	"end_sec" double precision NOT NULL,
	"speaker" text NOT NULL,
	"confidence" real,
	"language" "word_lang" NOT NULL,
	"filler" boolean DEFAULT false NOT NULL,
	CONSTRAINT "words_range" CHECK ("transcript_words"."start_sec" >= 0 and "transcript_words"."end_sec" >= "transcript_words"."start_sec")
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"language" "lang" NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"speakers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"word_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline_ops" (
	"id" uuid PRIMARY KEY NOT NULL,
	"timeline_id" uuid NOT NULL,
	"version_n" integer NOT NULL,
	"seq" integer NOT NULL,
	"actor" "version_author" NOT NULL,
	"op" jsonb NOT NULL,
	"inverse" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"timeline_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"parent_n" integer,
	"created_by" "version_author" NOT NULL,
	"label" text NOT NULL,
	"edit_id" text,
	"snapshot" jsonb NOT NULL,
	"op" jsonb NOT NULL,
	"inverse" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timelines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"last_version" integer DEFAULT 0 NOT NULL,
	"redo_stack" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_duration" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timelines_versions" CHECK ("timelines"."current_version" <= "timelines"."last_version")
);
--> statement-breakpoint
CREATE TABLE "job_stages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"status" "stage_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"project_id" uuid,
	"type" "job_type" NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"step" integer,
	"detail" text,
	"stage" text,
	"found" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"error_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_progress" CHECK ("jobs"."progress" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "usage_kind" NOT NULL,
	"amount" double precision NOT NULL,
	"project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_scene_id_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scenes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "highlights" ADD CONSTRAINT "highlights_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_thumbnail_asset_id_assets_id_fk" FOREIGN KEY ("thumbnail_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "silences" ADD CONSTRAINT "silences_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_sentences" ADD CONSTRAINT "transcript_sentences_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_sentences" ADD CONSTRAINT "transcript_sentences_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_words" ADD CONSTRAINT "transcript_words_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_words" ADD CONSTRAINT "transcript_words_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_ops" ADD CONSTRAINT "timeline_ops_timeline_id_timelines_id_fk" FOREIGN KEY ("timeline_id") REFERENCES "public"."timelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_versions" ADD CONSTRAINT "timeline_versions_timeline_id_timelines_id_fk" FOREIGN KEY ("timeline_id") REFERENCES "public"."timelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timelines" ADD CONSTRAINT "timelines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_stages" ADD CONSTRAINT "job_stages_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_family_idx" ON "sessions" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "projects_owner_updated_idx" ON "projects" USING btree ("owner_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "projects_owner_status_idx" ON "projects" USING btree ("owner_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_storage_key_uq" ON "assets" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "assets_project_kind_idx" ON "assets" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "assets_scene_idx" ON "assets" USING btree ("scene_id");--> statement-breakpoint
CREATE INDEX "chapters_project_start_idx" ON "chapters" USING btree ("project_id","start_sec");--> statement-breakpoint
CREATE INDEX "highlights_project_start_idx" ON "highlights" USING btree ("project_id","start_sec");--> statement-breakpoint
CREATE INDEX "scenes_project_start_idx" ON "scenes" USING btree ("project_id","start_sec");--> statement-breakpoint
CREATE UNIQUE INDEX "scenes_project_idx_uq" ON "scenes" USING btree ("project_id","idx");--> statement-breakpoint
CREATE INDEX "silences_project_start_idx" ON "silences" USING btree ("project_id","start_sec");--> statement-breakpoint
CREATE INDEX "uploads_user_status_idx" ON "uploads" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "uploads_project_idx" ON "uploads" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "uploads_status_expires_idx" ON "uploads" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "sentences_project_start_idx" ON "transcript_sentences" USING btree ("project_id","start_sec");--> statement-breakpoint
CREATE UNIQUE INDEX "sentences_transcript_idx_uq" ON "transcript_sentences" USING btree ("transcript_id","idx");--> statement-breakpoint
CREATE INDEX "sentences_search_idx" ON "transcript_sentences" USING gin ("search");--> statement-breakpoint
CREATE INDEX "sentences_norm_trgm_idx" ON "transcript_sentences" USING gin ("norm" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "words_project_start_idx" ON "transcript_words" USING btree ("project_id","start_sec");--> statement-breakpoint
CREATE UNIQUE INDEX "words_transcript_idx_uq" ON "transcript_words" USING btree ("transcript_id","idx");--> statement-breakpoint
CREATE INDEX "words_norm_trgm_idx" ON "transcript_words" USING gin ("norm" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "transcripts_project_uq" ON "transcripts" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "timeline_ops_version_seq_uq" ON "timeline_ops" USING btree ("timeline_id","version_n","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "timeline_versions_n_uq" ON "timeline_versions" USING btree ("timeline_id","n");--> statement-breakpoint
CREATE INDEX "timeline_versions_created_idx" ON "timeline_versions" USING btree ("timeline_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "timelines_project_uq" ON "timelines" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_stages_job_stage_uq" ON "job_stages" USING btree ("job_id","stage");--> statement-breakpoint
CREATE INDEX "jobs_project_type_idx" ON "jobs" USING btree ("project_id","type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "jobs_user_status_idx" ON "jobs" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "usage_user_kind_created_idx" ON "usage_events" USING btree ("user_id","kind","created_at");