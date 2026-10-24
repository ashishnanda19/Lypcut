DROP TABLE "sentence_embeddings";--> statement-breakpoint
ALTER TABLE "transcripts" DROP COLUMN "embeddings_hash";--> statement-breakpoint
DROP EXTENSION IF EXISTS vector;
