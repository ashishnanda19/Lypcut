ALTER TABLE "chapters" DROP COLUMN "source";--> statement-breakpoint
ALTER TABLE "transcripts" DROP COLUMN "chapters_hash";--> statement-breakpoint
ALTER TABLE "transcripts" DROP COLUMN "highlights_hash";--> statement-breakpoint
ALTER TABLE "transcripts" DROP COLUMN "content_hash";
