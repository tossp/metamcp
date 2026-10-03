import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { ServerParameters } from "@repo/zod-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectedClient } from "./client";
import type {
  CallToolHandler,
  ListToolsHandler,
} from "./metamcp-middleware/functional-middleware";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), getServers: vi.fn() }));
vi.mock("./client", () => ({ connectMetaMcpClient: mocks.connect }));
vi.mock("./fetch-metamcp", () => ({ getMcpServers: mocks.getServers }));
vi.mock("../../db/repositories/oauth-sessions.repo", () => ({
  oauthSessionsRepository: {},
}));
vi.mock("@/utils/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./log-store", () => ({ metamcpLogStore: { addLog: vi.fn() } }));
vi.mock("./server-error-tracker", () => ({ serverErrorTracker: {} }));
vi.mock("../../db/repositories/namespaces.repo", () => ({
  namespacesRepository: { findByUuid: vi.fn().mockResolvedValue({}) },
}));
vi.mock("../../trpc/tools.impl", () => ({
  toolsImplementations: { sync: vi.fn() },
}));
vi.mock("../admin-mcp/tools-registry", () => ({
  isExposedAdminToolName: () => false,
}));
vi.mock("../config.service", () => ({
  configService: {
    getMcpResetTimeoutOnProgress: async () => false,
    getMcpTimeout: async () => 1000,
    getMcpMaxTotalTimeout: async () => 2000,
  },
}));
vi.mock("./metamcp-middleware/audit-requests.functional", () => ({
  createAuditCallToolMiddleware: () => (h: CallToolHandler) => h,
}));
vi.mock("./metamcp-middleware/filter-tools.functional", () => ({
  createFilterCallToolMiddleware: () => (h: CallToolHandler) => h,
  createFilterListToolsMiddleware: () => (h: ListToolsHandler) => h,
}));
vi.mock("./metamcp-middleware/tool-identity", () => ({
  resolveToolIdentity: vi.fn(),
}));
vi.mock("./metamcp-middleware/tool-overrides.functional", () => ({
  createToolOverridesCallToolMiddleware: () => (h: CallToolHandler) => h,
  createToolOverridesListToolsMiddleware: () => (h: ListToolsHandler) => h,
  mapOverrideNameToOriginal: async (name: string) => name,
}));

import { mcpServerPool } from "./mcp-server-pool";
import { createServer } from "./metamcp-proxy";

const params: ServerParameters = {
  description: "Recovery test backend",
  stderr: "pipe",
  created_at: "2026-10-03T00:00:00Z",
  status: "ACTIVE",
  uuid: "backend",
  name: "blinko",
  type: "STREAMABLE_HTTP",
  url: "https://backend.invalid/mcp",
  headers: { "x-static": "static" },
  forward_headers: { "x-user": "x-backend-user" },
};
const backendCalls = vi.fn();
const connections: ConnectedClient[] = [];
const frontends: Client[] = [];
const backendServers: Server[] = [];

async function newBackend() {
  const server = new Server(
    { name: "blinko", version: "1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "search", inputSchema: { type: "object" as const } },
      { name: "write", inputSchema: { type: "object" as const } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, backendCalls);
  const client = new Client({ name: "pool", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  const connection = {
    client,
    cleanup: vi.fn(async () => {
      await client.close();
    }),
  };
  connections.push(connection);
  backendServers.push(server);
  return connection;
}

async function frontend(id = "session") {
  // Warm through getSession so tools/list doesn't exercise unrelated startup.
  await mcpServerPool.getSession(id, params.uuid, params, "namespace");
  const { server } = await createServer("namespace", id, false, {
    "x-user": id,
  });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  frontends.push(client);
  await client.listTools();
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  connections.length = 0;
  backendCalls
    .mockReset()
    .mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  mocks.getServers.mockResolvedValue({ backend: params });
  mocks.connect.mockReset().mockImplementation(newBackend);
});
afterEach(async () => {
  await Promise.all(frontends.splice(0).map((c) => c.close()));
  await mcpServerPool.cleanupAll();
  await Promise.all(backendServers.splice(0).map((s) => s.close()));
});

describe("tool calls through the real SDK and pool", () => {
  it("recovers after discovery then local transport disconnection, preserving headers and metadata", async () => {
    const client = await frontend();
    await connections[0].client.close();
    const result = await client.callTool({
      name: "blinko__search",
      arguments: { query: "test" },
      _meta: { trace: "test" },
    });
    expect(result.isError).not.toBe(true);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(connections[0].cleanup).toHaveBeenCalledTimes(1);
    expect(mocks.connect.mock.calls[1][0].headers).toEqual({
      "x-static": "static",
      "x-backend-user": "session",
    });
    expect(backendCalls).toHaveBeenCalledTimes(1);
    expect(backendCalls.mock.calls[0][0].params).toMatchObject({
      name: "search",
      arguments: { query: "test" },
      _meta: { trace: "test" },
    });
  });

  it("uses the pool's replacement even when discovery held an older client", async () => {
    const client = await frontend();
    const stale = connections[0];
    await mcpServerPool.invalidateServerConnection(
      "session",
      params.uuid,
      stale,
    );
    const fresh = await mcpServerPool.getSession(
      "session",
      params.uuid,
      params,
    );
    const oldRequest = vi.spyOn(stale.client, "request");
    await client.callTool({ name: "blinko__search" });
    expect(oldRequest).not.toHaveBeenCalled();
    expect(fresh?.cleanup).not.toHaveBeenCalled();
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent recovery for different tools on the same backend", async () => {
    const client = await frontend();
    await connections[0].client.close();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        client.callTool({ name: i % 2 ? "blinko__search" : "blinko__write" }),
      ),
    );
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(connections[0].cleanup).toHaveBeenCalledTimes(1);
    expect(connections[1].cleanup).not.toHaveBeenCalled();
    expect(backendCalls).toHaveBeenCalledTimes(12);
  });

  it("keeps healthy sibling sessions and the replacement alive on late invalidation", async () => {
    const first = await frontend("first");
    const second = await frontend("second");
    const stale = connections[0];
    const healthy = connections[1];
    await stale.client.close();
    await first.callTool({ name: "blinko__search" });
    const fresh = connections[2];
    await mcpServerPool.invalidateServerConnection("first", params.uuid, stale);
    await second.callTool({ name: "blinko__search" });
    expect(healthy.cleanup).not.toHaveBeenCalled();
    expect(fresh.cleanup).not.toHaveBeenCalled();
    expect(stale.cleanup).toHaveBeenCalledTimes(1);
    expect(mocks.connect).toHaveBeenCalledTimes(3);
  });

  it.each([
    new McpError(-32603, "Not connected"),
    new McpError(-32603, "Internal error"),
    new McpError(-32001, "Business failure"),
    new Error("Not connected to billing after write"),
    new Error("Timeout"),
  ])("does not retry remote business errors: %s", async (error) => {
    const client = await frontend();
    backendCalls.mockRejectedValue(error);
    await expect(client.callTool({ name: "blinko__write" })).rejects.toThrow();
    expect(backendCalls).toHaveBeenCalledTimes(1);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(connections[0].cleanup).not.toHaveBeenCalled();
  });

  it("does not retry a tool isError result", async () => {
    const client = await frontend();
    backendCalls.mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "Not connected" }],
    });
    expect((await client.callTool({ name: "blinko__write" })).isError).toBe(
      true,
    );
    expect(backendCalls).toHaveBeenCalledTimes(1);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });

  it("stops after one retry when the replacement is also disconnected", async () => {
    const client = await frontend();
    await connections[0].client.close();
    mocks.connect.mockImplementationOnce(async () => {
      const c = await newBackend();
      await c.client.close();
      return c;
    });
    await expect(client.callTool({ name: "blinko__write" })).rejects.toThrow(
      "Not connected",
    );
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(backendCalls).not.toHaveBeenCalled();
  });

  it("recovers an explicit HTTP 404 session rejection once", async () => {
    const client = await frontend();
    vi.spyOn(connections[0].client, "request").mockRejectedValueOnce(
      new Error(
        'Error POSTing to endpoint (HTTP 404): {"error":{"code":-32600,"message":"Session not found"}}',
      ),
    );
    await client.callTool({ name: "blinko__search" });
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(backendCalls).toHaveBeenCalledTimes(1);
  });

  it("releases the acquisition guard when reconnect fails", async () => {
    const client = await frontend();
    await connections[0].client.close();
    mocks.connect.mockRejectedValueOnce(new Error("connect failed"));
    await expect(client.callTool({ name: "blinko__search" })).rejects.toThrow(
      "connect failed",
    );
    await client.callTool({ name: "blinko__search" });
    expect(mocks.connect).toHaveBeenCalledTimes(3);
    expect(backendCalls).toHaveBeenCalledTimes(1);
  });

  it("detaches all aliases of one failed client and cleans it only once", async () => {
    for (let i = 0; i < 6; i++) {
      await mcpServerPool.getSession(`alias-${i}`, params.uuid, params);
    }
    expect(mocks.connect).toHaveBeenCalledTimes(5);
    const failed = connections[0];
    expect(mcpServerPool.getSessionConnections("alias-5")?.[params.uuid]).toBe(
      failed,
    );
    await Promise.all([
      mcpServerPool.invalidateServerConnection("alias-0", params.uuid, failed),
      mcpServerPool.invalidateServerConnection("alias-5", params.uuid, failed),
    ]);
    expect(
      mcpServerPool.getSessionConnections("alias-0")?.[params.uuid],
    ).toBeUndefined();
    expect(
      mcpServerPool.getSessionConnections("alias-5")?.[params.uuid],
    ).toBeUndefined();
    expect(failed.cleanup).toHaveBeenCalledTimes(1);
    for (const healthy of connections.slice(1))
      expect(healthy.cleanup).not.toHaveBeenCalled();
  });

  it("does not call a removed backend through cached tool mappings", async () => {
    const client = await frontend();
    mocks.getServers.mockResolvedValue({});
    await expect(client.callTool({ name: "blinko__write" })).rejects.toThrow(
      "no longer present",
    );
    expect(backendCalls).not.toHaveBeenCalled();
  });
});
