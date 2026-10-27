ALTER TABLE "mcp_servers" ADD COLUMN "tool_catalog_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "tool_catalog_refreshed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "catalog_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "definition" jsonb;