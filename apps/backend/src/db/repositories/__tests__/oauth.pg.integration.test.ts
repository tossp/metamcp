import { createHash } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePg = TEST_DATABASE_URL ? describe : describe.skip;

describePg("OAuthRepository PostgreSQL token consumption", () => {
  const schemaName = `oauth_token_test_${process.pid}_${Date.now()}`;
  const clientId = "client-1";
  const userId = "user-1";
  const redirectUri = "https://client.example/callback";
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256")
    .update(Buffer.from(verifier, "utf8"))
    .digest("base64url");
  let adminPool: Pool;
  let scopedPool: Pool;
  let repo: InstanceType<typeof import("../oauth.repo").OAuthRepository>;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required");
    process.env.DATABASE_URL ??= TEST_DATABASE_URL;
    adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    scopedPool = new Pool({
      connectionString: TEST_DATABASE_URL,
      options: `-c search_path=${schemaName}`,
    });
    await scopedPool.query(`
      CREATE TABLE users (id text PRIMARY KEY);
      CREATE TABLE oauth_clients (
        client_id text PRIMARY KEY,
        client_secret text,
        client_name text NOT NULL,
        redirect_uris text[] NOT NULL DEFAULT '{}',
        grant_types text[] NOT NULL DEFAULT '{authorization_code,refresh_token}',
        response_types text[] NOT NULL DEFAULT '{code}',
        token_endpoint_auth_method text NOT NULL DEFAULT 'none',
        scope text DEFAULT 'admin',
        client_uri text,
        logo_uri text,
        contacts text[],
        tos_uri text,
        policy_uri text,
        software_id text,
        software_version text,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE TABLE oauth_authorization_codes (
        code text PRIMARY KEY,
        client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        redirect_uri text NOT NULL,
        scope text NOT NULL DEFAULT 'admin',
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_challenge text NOT NULL,
        code_challenge_method text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT oauth_authorization_codes_s256_only_check
          CHECK (code_challenge_method = 'S256')
      );
      CREATE TABLE oauth_access_tokens (
        access_token text PRIMARY KEY,
        client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope text NOT NULL DEFAULT 'admin',
        expires_at timestamptz NOT NULL,
        refresh_token text,
        refresh_token_expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX oauth_access_tokens_refresh_token_unique_idx
        ON oauth_access_tokens (refresh_token)
        WHERE refresh_token IS NOT NULL;
      INSERT INTO users (id) VALUES ('${userId}');
      INSERT INTO oauth_clients (client_id, client_name)
        VALUES ('${clientId}', 'integration client');
    `);

    const { OAuthRepository } = await import("../oauth.repo");
    repo = new OAuthRepository(drizzle(scopedPool) as never);
  });

  beforeEach(async () => {
    await scopedPool.query(
      "TRUNCATE oauth_authorization_codes, oauth_access_tokens",
    );
  });

  afterAll(async () => {
    await scopedPool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  });

  function replacement(suffix: string) {
    return {
      access_token: `access-${suffix}`,
      expires_at: Date.now() + 60_000,
      refresh_token: `refresh-${suffix}`,
      refresh_token_expires_at: Date.now() + 120_000,
    };
  }

  async function insertCode(
    code: string,
    overrides: { redirect?: string; challenge?: string; expires?: string } = {},
  ) {
    await scopedPool.query(
      `INSERT INTO oauth_authorization_codes
        (code, client_id, redirect_uri, scope, user_id, code_challenge, code_challenge_method, expires_at)
       VALUES ($1, $2, $3, 'admin', $4, $5, 'S256', $6)`,
      [
        code,
        clientId,
        overrides.redirect ?? redirectUri,
        userId,
        overrides.challenge ?? challenge,
        overrides.expires ?? "infinity",
      ],
    );
  }

  async function insertToken(
    accessToken: string,
    refreshToken: string,
    expires = "infinity",
  ) {
    await scopedPool.query(
      `INSERT INTO oauth_access_tokens
        (access_token, client_id, user_id, scope, expires_at, refresh_token, refresh_token_expires_at)
       VALUES ($1, $2, $3, 'admin', NOW() + INTERVAL '1 hour', $4, $5)`,
      [accessToken, clientId, userId, refreshToken, expires],
    );
  }

  it("allows exactly one concurrent authorization-code consumer", async () => {
    await insertCode("code-race");

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        repo.consumeAuthorizationCode(
          {
            code: "code-race",
            client_id: clientId,
            redirect_uri: redirectUri,
            code_challenge: challenge,
          },
          replacement(`code-${index}`),
        ),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await scopedPool.query(
      "SELECT access_token FROM oauth_access_tokens",
    );
    expect(rows.rowCount).toBe(1);
  });

  it("allows exactly one concurrent refresh-token rotation", async () => {
    await insertToken("access-old", "refresh-race");

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        repo.rotateRefreshToken(
          "refresh-race",
          clientId,
          replacement(`rotation-${index}`),
        ),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await scopedPool.query(
      "SELECT refresh_token FROM oauth_access_tokens",
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].refresh_token).not.toBe("refresh-race");
  });

  it("rolls back code and refresh consumption when replacement insert fails", async () => {
    await insertCode("code-rollback");
    await insertToken("access-collision", "refresh-collision");
    await insertToken("access-rotation-old", "refresh-rollback");

    await expect(
      repo.consumeAuthorizationCode(
        {
          code: "code-rollback",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: challenge,
        },
        { ...replacement("code-failure"), access_token: "access-collision" },
      ),
    ).rejects.toThrow();
    await expect(
      repo.rotateRefreshToken("refresh-rollback", clientId, {
        ...replacement("refresh-failure"),
        access_token: "access-collision",
      }),
    ).rejects.toThrow();

    const code = await scopedPool.query(
      "SELECT 1 FROM oauth_authorization_codes WHERE code = 'code-rollback'",
    );
    const refresh = await scopedPool.query(
      "SELECT 1 FROM oauth_access_tokens WHERE refresh_token = 'refresh-rollback'",
    );
    expect(code.rowCount).toBe(1);
    expect(refresh.rowCount).toBe(1);
  });

  it("does not consume on expiry, redirect, PKCE, or client predicate mismatch", async () => {
    await insertCode("code-expired", {
      expires: new Date(Date.now() - 1000).toISOString(),
    });
    await insertCode("code-redirect");
    await insertCode("code-pkce");
    await insertCode("code-client");
    await insertToken(
      "access-expired",
      "refresh-expired",
      new Date(Date.now() - 1000).toISOString(),
    );

    await expect(
      repo.consumeAuthorizationCode(
        {
          code: "code-expired",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: challenge,
        },
        replacement("expired"),
      ),
    ).resolves.toBeNull();
    await expect(
      repo.consumeAuthorizationCode(
        {
          code: "code-redirect",
          client_id: clientId,
          redirect_uri: "https://wrong.example/callback",
          code_challenge: challenge,
        },
        replacement("redirect"),
      ),
    ).resolves.toBeNull();
    await expect(
      repo.consumeAuthorizationCode(
        {
          code: "code-pkce",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: "wrong-challenge",
        },
        replacement("pkce"),
      ),
    ).resolves.toBeNull();
    await expect(
      repo.consumeAuthorizationCode(
        {
          code: "code-client",
          client_id: "wrong-client",
          redirect_uri: redirectUri,
          code_challenge: challenge,
        },
        replacement("client"),
      ),
    ).resolves.toBeNull();
    await expect(
      repo.rotateRefreshToken(
        "refresh-expired",
        "wrong-client",
        replacement("refresh-client"),
      ),
    ).resolves.toBeNull();
    await expect(
      repo.rotateRefreshToken(
        "refresh-expired",
        clientId,
        replacement("refresh-expired"),
      ),
    ).resolves.toBeNull();

    const remaining = await scopedPool.query(
      "SELECT (SELECT COUNT(*) FROM oauth_authorization_codes) AS codes, (SELECT COUNT(*) FROM oauth_access_tokens) AS tokens",
    );
    expect(remaining.rows[0]).toEqual({ codes: "4", tokens: "1" });
  });

  it("fails the migration precondition on duplicates and enforces the partial unique index", async () => {
    await scopedPool.query(
      "DROP INDEX oauth_access_tokens_refresh_token_unique_idx",
    );
    await insertToken("duplicate-a", "duplicate-refresh");
    await insertToken("duplicate-b", "duplicate-refresh");

    await expect(
      scopedPool.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM oauth_access_tokens
            WHERE refresh_token IS NOT NULL
            GROUP BY refresh_token HAVING COUNT(*) > 1
          ) THEN
            RAISE EXCEPTION 'duplicate non-null oauth_access_tokens.refresh_token values prevent unique index creation';
          END IF;
        END $$;
      `),
    ).rejects.toThrow(/duplicate non-null/);

    await scopedPool.query("TRUNCATE oauth_access_tokens");
    await scopedPool.query(`
      CREATE UNIQUE INDEX oauth_access_tokens_refresh_token_unique_idx
        ON oauth_access_tokens (refresh_token)
        WHERE refresh_token IS NOT NULL
    `);
    await insertToken("unique-a", "unique-refresh");
    await expect(insertToken("unique-b", "unique-refresh")).rejects.toThrow();
  });
});
