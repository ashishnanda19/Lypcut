CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "sentence_embeddings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transcript_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"first_sentence" integer NOT NULL,
	"last_sentence" integer NOT NULL,
	"start_sec" double precision NOT NULL,
	"end_sec" double precision NOT NULL,
	"embedding" vector(384) NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "embeddings_hash" text;--> statement-breakpoint
ALTER TABLE "sentence_embeddings" ADD CONSTRAINT "sentence_embeddings_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentence_embeddings" ADD CONSTRAINT "sentence_embeddings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sentence_embeddings_project_idx" ON "sentence_embeddings" USING btree ("project_id","first_sentence");--> statement-breakpoint
CREATE INDEX "sentence_embeddings_transcript_idx" ON "sentence_embeddings" USING btree ("transcript_id");