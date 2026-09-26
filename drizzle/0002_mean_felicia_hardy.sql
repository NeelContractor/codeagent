CREATE TABLE "git_connections" (
	"project_id" serial PRIMARY KEY NOT NULL,
	"repo" text NOT NULL,
	"branch" text NOT NULL,
	"remote_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "git_connections_repo_idx" ON "git_connections" USING btree ("repo");