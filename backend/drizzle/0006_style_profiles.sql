CREATE TYPE "public"."instagram_account_status" AS ENUM('active', 'reauth_required');--> statement-breakpoint
CREATE TYPE "public"."instagram_account_type" AS ENUM('business', 'creator');--> statement-breakpoint
CREATE TYPE "public"."reel_source" AS ENUM('instagram', 'upload');--> statement-breakpoint
CREATE TYPE "public"."reel_status" AS ENUM('pending', 'analysing', 'analysed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."style_confidence" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
ALTER TYPE "public"."asset_kind" ADD VALUE 'style_reel';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'style_sync';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'style_analysis';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'style_refresh';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'style_deletion';--> statement-breakpoint
ALTER TYPE "public"."llm_kind" ADD VALUE 'style';--> statement-breakpoint
CREATE TABLE "instagram_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"ig_user_id" text NOT NULL,
	"handle" text NOT NULL,
	"account_type" "instagram_account_type" NOT NULL,
	"token_envelope" text NOT NULL,
	"key_id" text NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"token_refreshed_at" timestamp with time zone,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "instagram_account_status" DEFAULT 'active' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reel_analysis" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reel_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"algo_version" text NOT NULL,
	"duration_sec" double precision NOT NULL,
	"hook_timing_sec" double precision,
	"cut_pace" double precision NOT NULL,
	"speech_rate_wpm" double precision,
	"caption_style_id" text,
	"caption_style_source" text,
	"fonts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"colors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"engagement_score" double precision,
	"analysed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reel_analysis_ranges" CHECK ("reel_analysis"."duration_sec" > 0 and "reel_analysis"."cut_pace" >= 0
        and ("reel_analysis"."hook_timing_sec" is null or "reel_analysis"."hook_timing_sec" >= 0)
        and ("reel_analysis"."engagement_score" is null or ("reel_analysis"."engagement_score" >= 0 and "reel_analysis"."engagement_score" <= 100)))
);
--> statement-breakpoint
CREATE TABLE "reel_metrics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reel_id" uuid NOT NULL,
	"origin" "reel_source" NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"views" bigint,
	"reach" bigint,
	"likes" bigint,
	"comments" bigint,
	"saves" bigint,
	"shares" bigint,
	"avg_watch_sec" double precision,
	"avg_watch_pct" double precision,
	"skip_rate" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reel_metrics_counts_nonneg" CHECK (coalesce("reel_metrics"."views", 0) >= 0 and coalesce("reel_metrics"."reach", 0) >= 0 and coalesce("reel_metrics"."likes", 0) >= 0
        and coalesce("reel_metrics"."comments", 0) >= 0 and coalesce("reel_metrics"."saves", 0) >= 0 and coalesce("reel_metrics"."shares", 0) >= 0),
	CONSTRAINT "reel_metrics_ranges" CHECK (("reel_metrics"."avg_watch_sec" is null or "reel_metrics"."avg_watch_sec" >= 0)
        and ("reel_metrics"."avg_watch_pct" is null or ("reel_metrics"."avg_watch_pct" >= 0 and "reel_metrics"."avg_watch_pct" <= 100))
        and ("reel_metrics"."skip_rate" is null or ("reel_metrics"."skip_rate" >= 0 and "reel_metrics"."skip_rate" <= 1)))
);
--> statement-breakpoint
CREATE TABLE "reels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid,
	"source" "reel_source" NOT NULL,
	"external_id" text,
	"asset_id" uuid,
	"thumbnail_asset_id" uuid,
	"label" text NOT NULL,
	"duration_sec" double precision,
	"posted_at" timestamp with time zone,
	"status" "reel_status" DEFAULT 'pending' NOT NULL,
	"failure_code" text,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reels_source_shape" CHECK (("reels"."source" = 'instagram') = ("reels"."account_id" is not null and "reels"."external_id" is not null)),
	CONSTRAINT "reels_duration_positive" CHECK ("reels"."duration_sec" is null or "reels"."duration_sec" > 0)
);
--> statement-breakpoint
CREATE TABLE "style_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"profile" jsonb NOT NULL,
	"confidence" "style_confidence" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "uploads" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "instagram_accounts" ADD CONSTRAINT "instagram_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reel_analysis" ADD CONSTRAINT "reel_analysis_reel_id_reels_id_fk" FOREIGN KEY ("reel_id") REFERENCES "public"."reels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reel_metrics" ADD CONSTRAINT "reel_metrics_reel_id_reels_id_fk" FOREIGN KEY ("reel_id") REFERENCES "public"."reels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reels" ADD CONSTRAINT "reels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reels" ADD CONSTRAINT "reels_account_id_instagram_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."instagram_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reels" ADD CONSTRAINT "reels_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reels" ADD CONSTRAINT "reels_thumbnail_asset_id_assets_id_fk" FOREIGN KEY ("thumbnail_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "style_profiles" ADD CONSTRAINT "style_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "instagram_accounts_user_uq" ON "instagram_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "instagram_accounts_ig_user_idx" ON "instagram_accounts" USING btree ("ig_user_id");--> statement-breakpoint
CREATE INDEX "instagram_accounts_expiry_idx" ON "instagram_accounts" USING btree ("status","token_expires_at");--> statement-breakpoint
CREATE INDEX "instagram_accounts_key_idx" ON "instagram_accounts" USING btree ("key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_states_hash_uq" ON "oauth_states" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "oauth_states_expires_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_states_user_idx" ON "oauth_states" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reel_analysis_reel_uq" ON "reel_analysis" USING btree ("reel_id");--> statement-breakpoint
CREATE INDEX "reel_analysis_hash_idx" ON "reel_analysis" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "reel_metrics_reel_read_idx" ON "reel_metrics" USING btree ("reel_id","read_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reels_user_posted_idx" ON "reels" USING btree ("user_id","posted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reels_user_status_idx" ON "reels" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "reels_account_idx" ON "reels" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reels_user_source_external_uq" ON "reels" USING btree ("user_id","source","external_id") WHERE "reels"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "style_profiles_user_uq" ON "style_profiles" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_user_kind_idx" ON "assets" USING btree ("user_id","kind");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_has_owner" CHECK ("assets"."project_id" is not null or "assets"."user_id" is not null);