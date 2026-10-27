import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  status: "INACTIVE" as "ACTIVE" | "INACTIVE",
  query: vi.fn(),
  audit: vi.fn(),
  getMcpServers: vi.fn(),
  getSession: vi.fn(),
  request: vi.fn(),
}));

// Keep the real audit/override/filter middleware and real Drizzle SQL builder.
// Only the storage/transport/config boundaries are fake; never create a pg Pool.
vi.mock("../../../db/index", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  return { db: drizzle({ query: fake.query } as never) };
});
vi.mock("@/db/repositories/mcp-request-audit-logs.repo", () => ({
  mcpRequestAuditLogsRepository: { create: fake.audit },
}));
vi.mock("@/utils/logger", () => ({ default: { error: vi.fn() } }));
vi.mock("../../../lib/config.service", () => ({
  configService: {
    getMcpResetTimeoutOnProgress: async () => false,
    getMcpTimeout: async () => 1000,
    getMcpMaxTotalTimeout: async () => 1000,
  },
}));
vi.mock("../../../lib/metamcp/fetch-metamcp", () => ({
  getMcpServers: fake.getMcpServers,
}));
vi.mock("../../../lib/metamcp/mcp-server-pool", () => ({
  mcpServerPool: { getSession: fake.getSession },
}));
vi.mock("../../../lib/metamcp/utils", () => ({
  sanitizeName: (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, ""),
}));

import { createMiddlewareEnabledHandlers } from "./handlers";

const NAMESPACE = "synthetic-namespace";
const SERVER = "synthetic-server";
const PREFIX = "AlphaBridge";
const RAW = `${PREFIX}__raw`;
const ALIAS = `${PREFIX}__friendly`;
const result = { content: [{ type: "text", text: "synthetic result" }] };
const request = (name: string): CallToolRequest => ({
  method: "tools/call",
  params: { name, arguments: { value: "synthetic argument" } },
});
function handlers() {
  return createMiddlewareEnabledHandlers("synthetic-session", NAMESPACE, {
    endpointName: "synthetic-openapi",
    auth: { method: "api_key", apiKeyUuid: "synthetic-key" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.status = "INACTIVE";
  fake.audit.mockResolvedValue(undefined);
  fake.request.mockResolvedValue(result);
  fake.getMcpServers.mockResolvedValue({ [SERVER]: { name: "Alpha Bridge" } });
  fake.getSession.mockResolvedValue({
    client: {
      getServerCapabilities: () => ({ tools: {} }),
      getServerVersion: () => ({ name: "Alpha Bridge" }),
      request: fake.request,
    },
  });
  fake.query.mockImplementation(
    async (config: { text: string }, params: unknown[]) => {
      const sql = config.text;
      expect(sql).toMatch(/^select /);
      if (sql.includes('from "mcp_servers"')) {
        expect(sql).toContain('inner join "namespace_server_mappings"');
        expect(sql).toContain(
          '"namespace_server_mappings"."namespace_uuid" = $1',
        );
        expect(params).toEqual([NAMESPACE]);
        return { rows: [[SERVER, "Alpha Bridge", "ACTIVE"]] };
      }
      expect(sql).toContain('"namespace_tool_mappings"."namespace_uuid" = $1');
      expect(params[0]).toBe(NAMESPACE);
      expect(params.slice(2)).toEqual([SERVER, SERVER]);
      if (sql.includes('"namespace_tool_mappings"."override_name" =')) {
        expect(sql).toContain('"mcp_servers"."uuid" = $3');
        return {
          rows: params[1] === "friendly" ? [["raw", "Alpha Bridge"]] : [],
        };
      }
      expect(sql).toContain('"namespace_tool_mappings"."mcp_server_uuid" = $3');
      // The alias has no status mapping. Filtering it before override would
      // incorrectly default to ACTIVE, reproducing the original OpenAPI bypass.
      return { rows: params[1] === "raw" ? [[fake.status]] : [] };
    },
  );
});

describe("OpenAPI handler call pipeline", () => {
  it.each([RAW, ALIAS])(
    "blocks inactive tool %s before any upstream discovery or call",
    async (name) => {
      const { callToolWithMiddleware, handlerContext } = handlers();
      const response = await callToolWithMiddleware(
        request(name),
        handlerContext,
      );
      expect(response.isError).toBe(true);
      expect(fake.getMcpServers).not.toHaveBeenCalled();
      expect(fake.getSession).not.toHaveBeenCalled();
      expect(fake.request).not.toHaveBeenCalled();
      expect(fake.audit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          toolName: name,
          status: "ERROR",
          namespaceUuid: NAMESPACE,
          mcpServerUuid: SERVER,
          mcpServerName: PREFIX,
        }),
      );
    },
  );

  it("forwards the enabled alias as the original name while auditing the caller's alias", async () => {
    fake.status = "ACTIVE";
    const { callToolWithMiddleware, handlerContext } = handlers();
    const callerRequest = request(ALIAS);
    expect(await callToolWithMiddleware(callerRequest, handlerContext)).toEqual(
      result,
    );
    expect(fake.getMcpServers).toHaveBeenCalledExactlyOnceWith(NAMESPACE);
    expect(fake.request).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        method: "tools/call",
        params: expect.objectContaining({
          name: "raw",
          arguments: callerRequest.params.arguments,
        }),
      }),
      expect.anything(),
      expect.objectContaining({ timeout: 1000 }),
    );
    expect(callerRequest.params.name).toBe(ALIAS);
    expect(fake.audit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        toolName: ALIAS,
        status: "SUCCESS",
        endpointName: "synthetic-openapi",
        namespaceUuid: NAMESPACE,
        mcpServerUuid: SERVER,
        mcpServerName: PREFIX,
      }),
    );
  });
});
