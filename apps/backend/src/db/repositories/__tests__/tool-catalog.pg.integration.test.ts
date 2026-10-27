import { readFile } from "node:fs/promises";

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
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

import { ToolCatalogRepository } from "../tool-catalog.repo";

vi.mock("../../index", () => ({ db: {} }));
const url = process.env.TEST_DATABASE_URL;
const describePg = url ? describe : describe.skip;
const server = "00000000-0000-4000-8000-000000000301";
const namespace = "00000000-0000-4000-8000-000000000302";
const definition: Tool = {
  name: "search",
  description: "Original",
  inputSchema: { type: "object", additionalProperties: false },
  outputSchema: { type: "object", properties: { result: { type: "string" } } },
  annotations: { readOnlyHint: true },
  _meta: { fixture: true },
};

describePg("tool catalog PostgreSQL migration and snapshots", () => {
  const schemaName = `tool_catalog_test_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let repo: ToolCatalogRepository;
  let migratedLegacy: Record<string, unknown>;

  beforeAll(async () => {
    if (!url) throw new Error("TEST_DATABASE_URL is required");
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schemaName}`,
    });
    // Pre-0021 tables: execute the committed migration, not a duplicate of it.
    await pool.query(`
      CREATE TABLE mcp_servers (
        uuid uuid PRIMARY KEY, name text NOT NULL, user_id text,
        forward_headers jsonb NOT NULL DEFAULT '{}'
      );
      CREATE TABLE namespaces (uuid uuid PRIMARY KEY, user_id text);
      CREATE TABLE namespace_server_mappings (
        uuid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        namespace_uuid uuid NOT NULL REFERENCES namespaces(uuid),
        mcp_server_uuid uuid NOT NULL REFERENCES mcp_servers(uuid),
        status text NOT NULL DEFAULT 'ACTIVE'
      );
      CREATE TABLE tools (
        uuid uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
        description text, tool_schema jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW(),
        mcp_server_uuid uuid NOT NULL REFERENCES mcp_servers(uuid),
        UNIQUE (mcp_server_uuid, name)
      );
      CREATE TABLE namespace_tool_mappings (
        uuid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        namespace_uuid uuid NOT NULL REFERENCES namespaces(uuid),
        tool_uuid uuid NOT NULL REFERENCES tools(uuid) ON DELETE CASCADE,
        mcp_server_uuid uuid NOT NULL REFERENCES mcp_servers(uuid),
        status text NOT NULL DEFAULT 'ACTIVE', override_name text,
        override_description text,
        UNIQUE(namespace_uuid, tool_uuid)
      );
    `);
    await pool.query(
      "INSERT INTO mcp_servers(uuid,name,user_id) VALUES ($1,'fixture','owner')",
      [server],
    );
    await pool.query(
      "INSERT INTO tools(name,tool_schema,mcp_server_uuid) VALUES ('legacy',$1,$2)",
      [{ type: "object" }, server],
    );
    const migration = await readFile(
      new URL("../../../../drizzle/0021_tool_catalog.sql", import.meta.url),
      "utf8",
    );
    await pool.query(migration);
    migratedLegacy = (
      await pool.query("SELECT name,catalog_revision,definition FROM tools")
    ).rows[0];
    repo = new ToolCatalogRepository(drizzle(pool) as never);
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE namespace_tool_mappings, namespace_server_mappings, tools, namespaces",
    );
    await pool.query(
      "UPDATE mcp_servers SET user_id='owner', tool_catalog_revision=0, tool_catalog_refreshed_at=NULL",
    );
    await pool.query(
      "INSERT INTO namespaces(uuid,user_id) VALUES ($1,'owner')",
      [namespace],
    );
    await pool.query(
      "INSERT INTO namespace_server_mappings(namespace_uuid,mcp_server_uuid) VALUES ($1,$2)",
      [namespace, server],
    );
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.end();
    }
  });

  it("migrates existing data without deleting or renaming it", () => {
    expect(migratedLegacy).toEqual({
      name: "legacy",
      catalog_revision: 0,
      definition: null,
    });
  });

  it("publishes full definitions and preserves UUIDs, disabled status and overrides", async () => {
    expect(await repo.publish(server, 0, [definition])).toBe(true);
    const original = (await pool.query("SELECT uuid FROM tools")).rows[0].uuid;
    await pool.query(
      "UPDATE namespace_tool_mappings SET status='INACTIVE', override_name='custom'",
    );
    const updated = {
      ...definition,
      description: "Updated",
      inputSchema: { type: "object" as const, required: ["query"] },
    };
    expect(await repo.publish(server, 0, [updated])).toBe(true);
    const [catalog] = await repo.findByNamespace(namespace);
    expect(catalog.tools).toEqual([updated]);
    expect(catalog.source.refreshedAt).toBeInstanceOf(Date);
    expect((await pool.query("SELECT uuid FROM tools")).rows[0].uuid).toBe(
      original,
    );
    expect(
      (
        await pool.query(
          "SELECT status,override_name FROM namespace_tool_mappings",
        )
      ).rows,
    ).toEqual([{ status: "INACTIVE", override_name: "custom" }]);
  });

  it("excludes inactive membership, changed owners and deleted namespaces", async () => {
    await repo.publish(server, 0, [definition]);
    await pool.query("UPDATE namespace_server_mappings SET status='INACTIVE'");
    expect(await repo.findByNamespace(namespace)).toEqual([]);
    expect((await repo.findByNamespace(namespace, true))[0].tools).toEqual([
      definition,
    ]);
    await pool.query("UPDATE mcp_servers SET user_id='different-owner'");
    expect(await repo.findByNamespace(namespace, true)).toEqual([]);
    await pool.query("UPDATE mcp_servers SET user_id=NULL");
    expect((await repo.findByNamespace(namespace, true))[0].tools).toEqual([
      definition,
    ]);
    await pool.query(
      "DELETE FROM namespace_tool_mappings; DELETE FROM namespace_server_mappings; DELETE FROM namespaces",
    );
    expect(await repo.findByNamespace(namespace, true)).toEqual([]);
  });

  it("rejects a refresh when a concurrent configuration transaction changes revision", async () => {
    await repo.publish(server, 0, [definition]);
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SELECT uuid FROM mcp_servers FOR UPDATE");
      const pending = repo.publish(server, 0, [
        { ...definition, description: "late" },
      ]);
      await connection.query(
        "UPDATE mcp_servers SET tool_catalog_revision=1,tool_catalog_refreshed_at=NULL",
      );
      await connection.query("COMMIT");
      expect(await pending).toBe(false);
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
    expect((await repo.findByNamespace(namespace))[0].tools).toEqual([]);
    expect(
      (await pool.query("SELECT description FROM tools")).rows[0].description,
    ).toBe("Original");
  });

  it("rolls back failed snapshots and removes obsolete mappings after successful empty refresh", async () => {
    await repo.publish(server, 0, [definition]);
    const before = await repo.findByServerUuid(server);
    expect(before).toBeDefined();
    await expect(
      repo.publish(server, 0, [{ ...definition, name: null } as never]),
    ).rejects.toThrow();
    expect(await repo.findByServerUuid(server)).toEqual(before);
    expect(await repo.publish(server, 0, [])).toBe(true);
    expect((await repo.findByNamespace(namespace))[0].tools).toEqual([]);
    expect(
      (await pool.query("SELECT count(*) FROM namespace_tool_mappings")).rows[0]
        .count,
    ).toBe("0");
  });
});
