ALTER TABLE "file_snapshots" ADD COLUMN "bytes" integer;--> statement-breakpoint
ALTER TABLE "file_snapshots" ADD COLUMN "file_count" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "tool_call_id" text;