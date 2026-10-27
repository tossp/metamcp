import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../index", () => ({ db: {} }));

const { ToolCatalogRepository } = await import("../tool-catalog.repo");
const { ToolsRepository } = await import("../tools.repo");

const SERVER = "00000000-0000-4000-8000-000000000001";
const NAMESPACE = "00000000-0000-4000-8000-000000000002";
const definition = {
  name: "lookup",
  title: "Lookup",
  description: "Full metadata",
  inputSchema: {
    type: "object",
    properties: { key: { type: "string" } },
    additionalProperties: false,
    $defs: { key: { type: "string" } },
  },
  outputSchema: { type: "object", additionalProperties: true },
  annotations: { readOnlyHint: true, custom: "kept" },
  _meta: { revision: "upstream" },
  vendorExtension: { nested: true },
} satisfies Tool & {
  annotations: NonNullable<Tool["annotations"]> & Record<string, unknown>;
  vendorExtension: Record<string, unknown>;
};

type Query = { text: string; params: unknown[] };
// Exercise real Drizzle SQL/transaction generation, but never instantiate a pg
// Pool or connect to a database. The client only records queries and returns rows.
function fixture(
  options: {
    revision?: number | null;
    rows?: unknown[][];
    failOn?: string;
  } = {},
) {
  const queries: Query[] = [];
  const client = {
    query: vi.fn(async (config: { text: string }, params: unknown[] = []) => {
      const text = config.text;
      queries.push({ text, params });
      if (options.failOn && text.startsWith(options.failOn)) {
        throw new Error("simulated driver failure");
      }
      if (text.includes("for update")) {
        return {
          rows: options.revision === null ? [] : [[options.revision ?? 7]],
        };
      }
      if (text.startsWith("select")) return { rows: options.rows ?? [] };
      return { rows: [] };
    }),
  };
  const database = drizzle(client as never);
  return {
    queries,
    catalog: new ToolCatalogRepository(database as never),
    tools: new ToolsRepository(database as never),
  };
}

function sourceRow(
  tool: Tool | null,
  server = SERVER,
  legacy = false,
): unknown[] {
  return [
    server,
    "upstream",
    {},
    null,
    7,
    "2026-10-27T00:00:00Z",
    tool?.name ?? null,
    tool?.description ?? null,
    tool?.inputSchema ?? null,
    legacy ? null : tool,
  ];
}

function queryAt(queries: Query[], index: number): Query {
  const query = queries[index];
  if (!query) throw new Error(`Missing query at ${index}`);
  return query;
}

function parseInsertedDefinitions(query: Query): unknown[] {
  return query.params
    .filter(
      (value): value is string =>
        typeof value === "string" && value.startsWith("{"),
    )
    .map((value) => JSON.parse(value))
    .filter((value) => "name" in value);
}

describe("tool catalog reads", () => {
  it("checks the current revision without reading tools, launch data or credentials", async () => {
    const fake = fixture({ rows: [[7]] });
    expect(await fake.catalog.findRevisionByServerUuid(SERVER)).toBe(7);
    const query = queryAt(fake.queries, 0);
    expect(query.text.split(" from ")[0]).toBe(
      'select "tool_catalog_revision"',
    );
    expect(query.text).not.toContain("join");
    expect(
      await fixture().catalog.findRevisionByServerUuid(SERVER),
    ).toBeUndefined();
  });
  it("the single-server UI also reads only tools from the current credential revision", async () => {
    const fake = fixture();
    expect(await fake.tools.findByMcpServerUuid(SERVER)).toEqual([]);
    const query = queryAt(fake.queries, 0);
    expect(query.text).toContain(
      '"tools"."catalog_revision" = "mcp_servers"."tool_catalog_revision"',
    );
    expect(query.text.split(" from ")[0]).not.toContain('"mcp_servers"');
    expect(query.params).toEqual([SERVER]);
  });
  it("round-trips full metadata and keeps empty sources in one batched query", async () => {
    const fake = fixture({
      rows: [sourceRow(definition), sourceRow(null, NAMESPACE)],
    });
    const records = await fake.catalog.findByNamespace(NAMESPACE);
    expect(records).toHaveLength(2);
    expect(records[0]?.tools).toEqual([definition]);
    expect(records[0]?.source.refreshedAt).toEqual(
      new Date("2026-10-27T00:00:00Z"),
    );
    expect(records[1]?.tools).toEqual([]);
    expect(fake.queries).toHaveLength(1);
    const query = queryAt(fake.queries, 0);
    expect(query.text).toContain(
      '"tools"."catalog_revision" = "mcp_servers"."tool_catalog_revision"',
    );
    expect(query.text).toContain('"namespace_server_mappings"."status" =');
    expect(query.params).toEqual([NAMESPACE, "ACTIVE"]);
    for (const secret of [
      "env",
      "headers",
      "bearer_token",
      "url",
      "command",
      "args",
      "error_status",
    ]) {
      expect(query.text).not.toContain(`"mcp_servers"."${secret}"`);
    }
  });

  it("optionally includes inactive mappings without filtering runtime errors", async () => {
    const fake = fixture();
    await fake.catalog.findByNamespace(NAMESPACE, true);
    expect(fake.queries[0]?.params).toEqual([NAMESPACE]);
    expect(fake.queries[0]?.text).not.toContain('"status"');
    expect(fake.queries[0]?.text).not.toContain('"error_status"');
  });

  it.each([false, true])(
    "enforces current namespace existence and ownership even with includeInactiveServers=%s",
    async (includeInactiveServers) => {
      const fake = fixture();
      await fake.catalog.findByNamespace(NAMESPACE, includeInactiveServers);
      const query = queryAt(fake.queries, 0);
      expect(query.text).toContain(
        'inner join "namespaces" on "namespaces"."uuid" = "namespace_server_mappings"."namespace_uuid"',
      );
      // Public namespace: NULL equality cannot authorize a private server.
      // Private namespace: only public or currently same-owner servers pass.
      // Compare database columns, not cached ownership from a historical mapping.
      expect(query.text.split(" where ")[1]).toContain(
        '("mcp_servers"."user_id" is null or "mcp_servers"."user_id" = "namespaces"."user_id")',
      );
      expect(query.params).toEqual(
        includeInactiveServers ? [NAMESPACE] : [NAMESPACE, "ACTIVE"],
      );
      expect(query.text.split(" from ")[0]).toBe(
        'select "mcp_servers"."uuid", "mcp_servers"."name", "mcp_servers"."forward_headers", "mcp_servers"."user_id", "mcp_servers"."tool_catalog_revision", "mcp_servers"."tool_catalog_refreshed_at", "tools"."name", "tools"."description", "tools"."tool_schema", "tools"."definition"',
      );
    },
  );

  it("restores legacy rows from name/description/toolSchema", async () => {
    const fake = fixture({ rows: [sourceRow(definition, SERVER, true)] });
    expect((await fake.catalog.findByServerUuid(SERVER))?.tools).toEqual([
      {
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
      },
    ]);
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]?.params).toEqual([SERVER]);
    expect(fake.queries[0]?.text).not.toContain('"namespaces"');
    expect(fake.queries[0]?.text).not.toContain('"namespace_server_mappings"');
  });

  it("distinguishes a missing server from a server with no current tools", async () => {
    expect(await fixture().catalog.findByServerUuid(SERVER)).toBeUndefined();
    const empty = fixture({ rows: [sourceRow(null)] });
    expect((await empty.catalog.findByServerUuid(SERVER))?.tools).toEqual([]);
  });
});

describe("tool catalog publication", () => {
  it.each([6, null])(
    "rejects obsolete/deleted source %s before touching tools",
    async (revision) => {
      const fake = fixture({ revision });
      expect(await fake.catalog.publish(SERVER, 7, [definition])).toBe(false);
      expect(fake.queries.map((query) => query.text.split(" ")[0])).toEqual([
        "begin",
        "select",
        "commit",
      ]);
      expect(fake.queries[1]?.text).toContain("for update");
      expect(fake.queries[1]?.params).toEqual([SERVER]);
    },
  );

  it("locks, upserts full definitions preserving UUIDs, removes obsolete rows, then commits", async () => {
    const fake = fixture();
    expect(await fake.catalog.publish(SERVER, 7, [definition])).toBe(true);
    expect(fake.queries.map((query) => query.text.split(" ")[0])).toEqual([
      "begin",
      "select",
      "insert",
      "delete",
      "insert",
      "update",
      "commit",
    ]);
    const insert = queryAt(fake.queries, 2);
    expect(parseInsertedDefinitions(insert)).toEqual([definition]);
    expect(insert.params).toContain(7);
    expect(insert.text).toContain(
      'on conflict ("mcp_server_uuid","name") do update set',
    );
    const updates = insert.text
      .split("do update set")[1]
      ?.split(" returning ")[0];
    expect(updates).toContain('"definition" = excluded.definition');
    expect(updates).toContain('"catalog_revision" = excluded.catalog_revision');
    expect(updates).not.toContain('"uuid" =');
    expect(fake.queries[3]?.text).toContain("not in");
    expect(fake.queries[3]?.params).toEqual([SERVER, definition.name]);
    const mappings = queryAt(fake.queries, 4);
    expect(mappings.text).toContain('insert into "namespace_tool_mappings"');
    expect(mappings.text).toContain('from "namespace_server_mappings"');
    expect(mappings.text).toContain(
      'on conflict ("namespace_uuid", "tool_uuid") do nothing',
    );
    expect(mappings.text).not.toContain("do update");
    expect(mappings.text).not.toContain('"namespace_server_mappings"."status"');
    expect(mappings.params).toContain(SERVER);
    expect(fake.queries[5]?.text).toContain('"tool_catalog_refreshed_at"');
  });

  it("treats a successful empty result as delete-all plus a successful timestamp", async () => {
    const fake = fixture();
    expect(await fake.catalog.publish(SERVER, 7, [])).toBe(true);
    expect(fake.queries.map((query) => query.text.split(" ")[0])).toEqual([
      "begin",
      "select",
      "delete",
      "update",
      "commit",
    ]);
    expect(fake.queries[2]?.text).not.toContain("not in");
    expect(fake.queries[2]?.params).toEqual([SERVER]);
  });

  it.each([
    "insert",
    "delete",
    'insert into "namespace_tool_mappings"',
    "update",
    "commit",
  ])("rejects and rolls back when %s fails", async (failOn) => {
    const fake = fixture({ failOn });
    await expect(
      fake.catalog.publish(SERVER, 7, [definition]),
    ).rejects.toThrow();
    expect(fake.queries.at(-1)?.text).toBe("rollback");
    if (failOn !== "commit")
      expect(fake.queries.map((query) => query.text)).not.toContain("commit");
  });
});

describe("ToolsRepository compatibility", () => {
  it("syncTools uses the same transaction and complete metadata", async () => {
    const fake = fixture();
    await fake.tools.syncTools({ mcpServerUuid: SERVER, tools: [definition] });
    expect(parseInsertedDefinitions(queryAt(fake.queries, 2))).toEqual([
      definition,
    ]);
    expect(fake.queries.at(-1)?.text).toBe("commit");
  });

  it("syncTools does not skip successful empty arrays", async () => {
    const fake = fixture();
    expect(
      await fake.tools.syncTools({ mcpServerUuid: SERVER, tools: [] }),
    ).toEqual({ upserted: [], deleted: [] });
    expect(fake.queries.some((query) => query.text.startsWith("delete"))).toBe(
      true,
    );
    expect(fake.queries.some((query) => query.text.startsWith("update"))).toBe(
      true,
    );
  });

  it("normalizes legacy input and deduplicates names without discarding extensions", async () => {
    const fake = fixture();
    await fake.tools.syncTools({
      mcpServerUuid: SERVER,
      tools: [
        { name: "lookup", description: "old" },
        {
          name: "lookup",
          description: null,
          inputSchema: { additionalProperties: false },
          title: "Legacy",
          vendor: 1,
        },
      ],
    });
    expect(parseInsertedDefinitions(queryAt(fake.queries, 2))).toEqual([
      {
        name: "lookup",
        title: "Legacy",
        vendor: 1,
        inputSchema: { type: "object", additionalProperties: false },
      },
    ]);
  });

  it("does not mark bulk-only upserts as a complete refresh", async () => {
    const fake = fixture();
    await fake.tools.bulkUpsert({ mcpServerUuid: SERVER, tools: [definition] });
    expect(fake.queries.map((query) => query.text.split(" ")[0])).toEqual([
      "begin",
      "select",
      "insert",
      "commit",
    ]);
  });

  it("syncTools rolls back on failure and rejects deleted servers", async () => {
    const fake = fixture({ failOn: "delete" });
    await expect(
      fake.tools.syncTools({ mcpServerUuid: SERVER, tools: [definition] }),
    ).rejects.toThrow();
    expect(fake.queries.at(-1)?.text).toBe("rollback");
    await expect(
      fixture({ revision: null }).tools.syncTools({
        mcpServerUuid: SERVER,
        tools: [],
      }),
    ).rejects.toThrow("MCP server not found");
  });
});
