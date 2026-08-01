DELETE FROM "oauth_authorization_codes";--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ALTER COLUMN "code_challenge" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ALTER COLUMN "code_challenge_method" SET NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "oauth_access_tokens"
    WHERE "refresh_token" IS NOT NULL
    GROUP BY "refresh_token"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate non-null oauth_access_tokens.refresh_token values prevent unique index creation';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_access_tokens_refresh_token_unique_idx" ON "oauth_access_tokens" USING btree ("refresh_token") WHERE "oauth_access_tokens"."refresh_token" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_s256_only_check" CHECK ("oauth_authorization_codes"."code_challenge_method" = 'S256');
