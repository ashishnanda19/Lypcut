DELETE FROM "uploads" WHERE "project_id" IS NULL;--> statement-breakpoint
DELETE FROM "assets" WHERE "project_id" IS NULL;--> statement-breakpoint
ALTER TABLE "assets" DROP CONSTRAINT "assets_has_owner";--> statement-breakpoint
DROP INDEX "assets_user_kind_idx";--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "uploads" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
DROP TABLE "style_profiles";--> statement-breakpoint
DROP TABLE "reel_metrics";--> statement-breakpoint
DROP TABLE "reel_analysis";--> statement-breakpoint
DROP TABLE "reels";--> statement-breakpoint
DROP TABLE "oauth_states";--> statement-breakpoint
DROP TABLE "instagram_accounts";--> statement-breakpoint
DROP TYPE "public"."style_confidence";--> statement-breakpoint
DROP TYPE "public"."instagram_account_status";--> statement-breakpoint
DROP TYPE "public"."instagram_account_type";--> statement-breakpoint
DROP TYPE "public"."reel_status";--> statement-breakpoint
DROP TYPE "public"."reel_source";--> statement-breakpoint
DELETE FROM "jobs" WHERE "type" IN ('style_sync', 'style_analysis', 'style_refresh', 'style_deletion');--> statement-breakpoint
ALTER TYPE "public"."job_type" RENAME TO "job_type_old";--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('processing', 'export', 'otio', 'delete_project', 'delete_account', 'cleanup_uploads');--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "type" TYPE "public"."job_type" USING "type"::text::"public"."job_type";--> statement-breakpoint
DROP TYPE "public"."job_type_old";--> statement-breakpoint
DELETE FROM "llm_usage" WHERE "kind" = 'style';--> statement-breakpoint
ALTER TYPE "public"."llm_kind" RENAME TO "llm_kind_old";--> statement-breakpoint
CREATE TYPE "public"."llm_kind" AS ENUM('planner', 'highlights', 'chapters', 'embed');--> statement-breakpoint
ALTER TABLE "llm_usage" ALTER COLUMN "kind" TYPE "public"."llm_kind" USING "kind"::text::"public"."llm_kind";--> statement-breakpoint
DROP TYPE "public"."llm_kind_old";--> statement-breakpoint
ALTER TYPE "public"."asset_kind" RENAME TO "asset_kind_old";--> statement-breakpoint
CREATE TYPE "public"."asset_kind" AS ENUM('raw', 'scene_clip', 'proxy', 'export', 'thumbnail', 'audio');--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "kind" TYPE "public"."asset_kind" USING "kind"::text::"public"."asset_kind";--> statement-breakpoint
DROP TYPE "public"."asset_kind_old";
