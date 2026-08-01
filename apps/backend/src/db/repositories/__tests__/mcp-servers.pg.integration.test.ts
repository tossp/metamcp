import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schema from "../../schema";
import { McpServersRepository } from "../mcp-servers.repo";

vi.mock("../../index", () => ({ db: {} }));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePg = TEST_DATABASE_URL ? describe : describe.skip;

describePg("McpServersRepository PostgreSQL owner lifecycle", () => {
  const schemaName = `mcp_owner_lifecycle_test_${process.pid}_${Date.now()}`;
  const ownerA = "owner-a";
  const ownerB = "owner-b";
  const serverId = "00000000-0000-0000-0000-000000000201";
  let adminPool: Pool;
  let scopedPool: Pool;
  let repo: InstanceType<typeof McpServersRepository>;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required");

    adminPool = new Pool({ connectionString: TEST_DATABASE_URL });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    scopedPool = new Pool({
      connectionString: TEST_DATABASE_URL,
      options: `-c search_path=${schemaName}`,
    });
    await scopedPool.query(String.raw`
      CREATE TABLE users (id text PRIMARY KEY);
      CREATE TABLE mcp_servers (
        uuid uuid PRIMARY KEY,
        name text NOT NULL,
        description text,
        type text NOT NULL DEFAULT 'STDIO',
        command text,
        args text[] NOT NULL DEFAULT '{}',
        env jsonb NOT NULL DEFAULT '{}'::jsonb,
        url text,
        error_status text NOT NULL DEFAULT 'NONE',
        created_at timestamptz NOT NULL DEFAULT NOW(),
        bearer_token text,
        headers jsonb NOT NULL DEFAULT '{}'::jsonb,
        forward_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
        user_id text REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT mcp_servers_name_user_unique_idx UNIQUE (name, user_id),
        CONSTRAINT mcp_servers_name_regex_check
          CHECK (name ~ '^[a-zA-Z0-9_-]+$'),
        CONSTRAINT mcp_servers_url_check CHECK (
          (type = 'SSE' AND url IS NOT NULL AND command IS NULL AND url ~ '^https?://[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*(:[0-9]+)?(/[a-zA-Z0-9-._~:/?#\[\]@!$&''()*+,;=]*)?$') OR
          (type = 'STDIO' AND url IS NULL AND command IS NOT NULL) OR
          (type = 'STREAMABLE_HTTP' AND url IS NOT NULL AND command IS NULL AND url ~ '^https?://[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*(:[0-9]+)?(/[a-zA-Z0-9-._~:/?#\[\]@!$&''()*+,;=]*)?$')
        )
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
    `);
    await scopedPool.query("INSERT INTO users (id) VALUES ($1), ($2)", [
      ownerA,
      ownerB,
    ]);

    repo = new McpServersRepository(drizzle(scopedPool, { schema }) as never);
  });

  beforeEach(async () => {
    await scopedPool.query("TRUNCATE oauth_sessions, mcp_servers");
  });

  afterAll(async () => {
    await scopedPool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  });

  async function insertServer(owner: string | null) {
    await scopedPool.query(
      `INSERT INTO mcp_servers (uuid, name, command, user_id)
       VALUES ($1, 'owner_lifecycle', 'node', $2)`,
      [serverId, owner],
    );
  }

  async function insertSession(owner: string) {
    await scopedPool.query(
      `INSERT INTO oauth_sessions
        (mcp_server_uuid, owner_user_id, code_verifier)
       VALUES ($1, $2, 'original-verifier')`,
      [serverId, owner],
    );
  }

  async function readOwnerState() {
    const server = await scopedPool.query(
      "SELECT name, user_id FROM mcp_servers WHERE uuid = $1",
      [serverId],
    );
    const session = await scopedPool.query(
      `SELECT owner_user_id, code_verifier
       FROM oauth_sessions WHERE mcp_server_uuid = $1`,
      [serverId],
    );
    return { server: server.rows[0], session: session.rows[0] };
  }

  it("deletes the session when a private server changes owner", async () => {
    await insertServer(ownerA);
    await insertSession(ownerA);

    await expect(
      repo.update({ uuid: serverId, user_id: ownerB }),
    ).resolves.toMatchObject({ user_id: ownerB });

    expect(await readOwnerState()).toEqual({
      server: { name: "owner_lifecycle", user_id: ownerB },
      session: undefined,
    });
  });

  it("deletes the session when a private server becomes public", async () => {
    await insertServer(ownerA);
    await insertSession(ownerA);

    await expect(
      repo.update({ uuid: serverId, user_id: null }),
    ).resolves.toMatchObject({ user_id: null });

    expect(await readOwnerState()).toEqual({
      server: { name: "owner_lifecycle", user_id: null },
      session: undefined,
    });
  });

  it("keeps the session when an update does not change the owner", async () => {
    await insertServer(ownerA);
    await insertSession(ownerA);

    await repo.update({
      uuid: serverId,
      description: "owner unchanged",
      user_id: ownerA,
    });

    expect(await readOwnerState()).toEqual({
      server: { name: "owner_lifecycle", user_id: ownerA },
      session: {
        owner_user_id: ownerA,
        code_verifier: "original-verifier",
      },
    });
  });

  it("cascades session deletion when the server is deleted", async () => {
    await insertServer(ownerA);
    await insertSession(ownerA);

    await expect(repo.deleteByUuid(serverId)).resolves.toMatchObject({
      uuid: serverId,
      user_id: ownerA,
    });

    expect(await readOwnerState()).toEqual({
      server: undefined,
      session: undefined,
    });
  });

  it("does not recreate an old session when a public server becomes private", async () => {
    await insertServer(ownerA);
    await insertSession(ownerA);
    await repo.update({ uuid: serverId, user_id: null });

    await expect(
      repo.update({ uuid: serverId, user_id: ownerB }),
    ).resolves.toMatchObject({ user_id: ownerB });

    expect(await readOwnerState()).toEqual({
      server: { name: "owner_lifecycle", user_id: ownerB },
      session: undefined,
    });
  });

  it("keeps the original owner and session when an update rolls back", async () => {
    await insertServer(ownerA);
    await insertSession(ownerA);

    await expect(
      repo.update({
        uuid: serverId,
        name: "invalid name",
        user_id: ownerB,
      }),
    ).rejects.toThrow();

    expect(await readOwnerState()).toEqual({
      server: { name: "owner_lifecycle", user_id: ownerA },
      session: {
        owner_user_id: ownerA,
        code_verifier: "original-verifier",
      },
    });
  });
});
