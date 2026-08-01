ALTER TABLE "oauth_sessions" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "oauth_sessions" ADD COLUMN "expected_state_expires_at" timestamp with time zone;--> statement-breakpoint

DELETE FROM "oauth_sessions"
USING "mcp_servers"
WHERE "oauth_sessions"."mcp_server_uuid" = "mcp_servers"."uuid"
  AND "mcp_servers"."user_id" IS NULL;--> statement-breakpoint

UPDATE "oauth_sessions"
SET "owner_user_id" = "mcp_servers"."user_id"
FROM "mcp_servers"
WHERE "oauth_sessions"."mcp_server_uuid" = "mcp_servers"."uuid"
  AND "mcp_servers"."user_id" IS NOT NULL;--> statement-breakpoint

UPDATE "oauth_sessions"
SET "expected_state" = NULL,
    "expected_state_expires_at" = NULL;--> statement-breakpoint

ALTER TABLE "oauth_sessions" ALTER COLUMN "owner_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_sessions" ADD CONSTRAINT "oauth_sessions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_sessions" ADD CONSTRAINT "oauth_sessions_expected_state_expiry_check" CHECK ((
      (expected_state IS NULL AND expected_state_expires_at IS NULL) OR
      (expected_state IS NOT NULL AND expected_state_expires_at IS NOT NULL)
    ));--> statement-breakpoint
CREATE INDEX "oauth_sessions_owner_user_id_idx" ON "oauth_sessions" USING btree ("owner_user_id");
