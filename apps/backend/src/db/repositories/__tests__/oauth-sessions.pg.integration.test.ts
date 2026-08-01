import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePg = TEST_DATABASE_URL ? describe : describe.skip;

describePg("OAuthSessionsRepository PostgreSQL isolation", () => {
  const schemaName = `oauth_session_test_${process.pid}_${Date.now()}`;
  const ownerId = "owner-1";
  const otherId = "owner-2";
  const privateServer = "00000000-0000-0000-0000-000000000101";
  const publicServer = "00000000-0000-0000-0000-000000000102";
  let adminPool: Pool;
  let scopedPool: Pool;
  let repo: InstanceType<
    typeof import("../oauth-sessions.repo").OAuthSessionsRepository
  >;

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
      CREATE TABLE users (
        id text PRIMARY KEY
      );
      CREATE TABLE mcp_servers (
        uuid uuid PRIMARY KEY,
        user_id text REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE oauth_sessions (
        uuid uuid PRIMARY KEY DEFAULT (md5(random()::text || clock_timestamp()::text)::uuid),
        mcp_server_uuid uuid NOT NULL UNIQUE REFERENCES mcp_servers(uuid) ON DELETE CASCADE,
        owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_information jsonb NOT NULL DEFAULT '{}'::jsonb,
        tokens jsonb,
        code_verifier text,
        expected_state text,
        expected_state_expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT oauth_sessions_expected_state_expiry_check CHECK (
          (expected_state IS NULL AND expected_state_expires_at IS NULL) OR
          (expected_state IS NOT NULL AND expected_state_expires_at IS NOT NULL)
        )
      );
      INSERT INTO users (id) VALUES ('${ownerId}'), ('${otherId}');
      INSERT INTO mcp_servers (uuid, user_id) VALUES
        ('${privateServer}', '${ownerId}'),
        ('${publicServer}', NULL);
    `);

    const { OAuthSessionsRepository } = await import("../oauth-sessions.repo");
    repo = new OAuthSessionsRepository(drizzle(scopedPool) as never);
  });

  afterAll(async () => {
    await scopedPool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  });

  it("rejects public and non-owner access", async () => {
    await expect(
      repo.upsert(
        { mcp_server_uuid: publicServer, code_verifier: "public-verifier" },
        ownerId,
      ),
    ).resolves.toBeUndefined();

    await repo.upsert(
      { mcp_server_uuid: privateServer, code_verifier: "private-verifier" },
      ownerId,
    );
    await expect(
      repo.findByMcpServerUuid(privateServer, otherId),
    ).resolves.toBeUndefined();
  });

  it("keeps only the latest active state", async () => {
    await repo.upsert(
      { mcp_server_uuid: privateServer, expected_state: "state-old" },
      ownerId,
    );
    await repo.upsert(
      { mcp_server_uuid: privateServer, expected_state: "state-new" },
      ownerId,
    );

    await expect(
      repo.consumeExpectedState(privateServer, ownerId, "state-old"),
    ).resolves.toBeUndefined();
    await expect(
      repo.consumeExpectedState(privateServer, ownerId, "state-new"),
    ).resolves.toMatchObject({ expected_state: null });
  });

  it("atomically permits only one concurrent state consumer", async () => {
    await repo.upsert(
      { mcp_server_uuid: privateServer, expected_state: "state-race" },
      ownerId,
    );

    const results = await Promise.all([
      repo.consumeExpectedState(privateServer, ownerId, "state-race"),
      repo.consumeExpectedState(privateServer, ownerId, "state-race"),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("fails closed for NULL and expired state", async () => {
    await expect(
      repo.consumeExpectedState(privateServer, ownerId, "missing-state"),
    ).resolves.toBeUndefined();

    await repo.upsert(
      { mcp_server_uuid: privateServer, expected_state: "expired-state" },
      ownerId,
    );
    await scopedPool.query(
      `UPDATE oauth_sessions
       SET expected_state_expires_at = NOW() - INTERVAL '1 second'
       WHERE mcp_server_uuid = $1`,
      [privateServer],
    );

    await expect(
      repo.consumeExpectedState(privateServer, ownerId, "expired-state"),
    ).resolves.toBeUndefined();
  });
});
