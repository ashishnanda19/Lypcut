ALTER TABLE "chapters" ADD COLUMN "source" text DEFAULT 'heuristic' NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "highlights_hash" text;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "chapters_hash" text;