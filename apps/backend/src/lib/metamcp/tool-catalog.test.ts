import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  repository: {
    findByNamespace: vi.fn(),
    findByServerUuid: vi.fn(),
    findRevisionByServerUuid: vi.fn(),
    publish: vi.fn(),
  },
  servers: { findByUuid: vi.fn() },
  pool: {
    getSession: vi.fn(),
    cleanupSession: vi.fn(),
    invalidateServerConnection: vi.fn(),
  },
  logs: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  create: vi.fn(),
  convert: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("../../db/repositories/tool-catalog.repo", () => ({
  toolCatalogRepository: fakes.repository,
}));
vi.mock("../../db/repositories/mcp-servers.repo", () => ({
  mcpServersRepository: fakes.servers,
}));
vi.mock("./mcp-server-pool", () => ({ mcpServerPool: fakes.pool }));
vi.mock("./client", () => ({ createMetaMcpClient: fakes.create }));
vi.mock("./utils", () => ({ convertDbServerToParams: fakes.convert }));
vi.mock("./tool-catalog-events", () => ({
  notifyToolCatalogChanged: fakes.notify,
}));
vi.mock("@/utils/logger", () => ({ default: fakes.logs }));

const tool = (name: string): Tool => ({
  name,
  inputSchema: { type: "object" },
});
const source = () => ({
  uuid: "server",
  name: "Server",
  forward_headers: null as Record<string, string> | null,
  user_id: null,
  revision: 1,
  refreshedAt: new Date(),
});
function connection() {
  return {
    client: {
      getServerCapabilities: vi.fn(() => ({ tools: {} })),
      getServerVersion: vi.fn(() => ({ name: "fake-upstream", version: "1" })),
      request: vi.fn().mockResolvedValue({ tools: [tool("new")] }),
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    },
    transport: { close: vi.fn().mockResolvedValue(undefined) },
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

async function realUpstream(tools: unknown[]) {
  const server = new Server(
    { name: "synthetic-upstream", version: "1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  const client = new Client({ name: "synthetic-catalog", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const cleanup = async () => {
    await client.close();
    await server.close();
  };
  return { client, cleanup };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  const row = { source: source(), tools: [tool("old")] };
  fakes.repository.findByNamespace.mockResolvedValue([row]);
  fakes.repository.findByServerUuid.mockResolvedValue(row);
  fakes.repository.findRevisionByServerUuid.mockResolvedValue(1);
  fakes.repository.publish.mockResolvedValue(true);
  fakes.servers.findByUuid.mockResolvedValue({
    uuid: "server",
    tool_catalog_revision: 1,
  });
  fakes.convert.mockResolvedValue({
    uuid: "server",
    name: "Server",
    headers: { static: "fake-static" },
  });
  fakes.pool.cleanupSession.mockResolvedValue(undefined);
  fakes.pool.invalidateServerConnection.mockResolvedValue(undefined);
});

describe("tool catalog connection adapter", () => {
  it("listing only reads catalog metadata, not full saved config or upstream", async () => {
    const service = await import("./tool-catalog");
    expect((await service.listCatalogTools("ns"))[0]?.tool.name).toBe("old");
    expect(fakes.servers.findByUuid).not.toHaveBeenCalled();
    expect(fakes.convert).not.toHaveBeenCalled();
    expect(fakes.pool.getSession).not.toHaveBeenCalled();
    expect(fakes.create).not.toHaveBeenCalled();
  });

  it("uses random refresh-only sessions, paginates completely, then publishes and cleans up", async () => {
    const session = connection();
    session.client.request
      .mockResolvedValueOnce({ tools: [tool("a")], nextCursor: "next" })
      .mockResolvedValueOnce({ tools: [tool("b")] });
    fakes.pool.getSession.mockResolvedValue(session);
    const { refreshCatalogTools } = await import("./tool-catalog");
    expect(
      await refreshCatalogTools("server", { sessionId: "incoming-client" }),
    ).toEqual({ serverUuid: "server", success: true, count: 2 });
    const id = fakes.pool.getSession.mock.calls[0]?.[0];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(id).not.toBe("incoming-client");
    expect(session.client.request).toHaveBeenNthCalledWith(
      1,
      { method: "tools/list", params: {} },
      expect.any(Object),
    );
    expect(session.client.request).toHaveBeenNthCalledWith(
      2,
      { method: "tools/list", params: { cursor: "next" } },
      expect.any(Object),
    );
    expect(fakes.repository.publish).toHaveBeenCalledWith("server", 1, [
      tool("a"),
      tool("b"),
    ]);
    expect(fakes.pool.cleanupSession).toHaveBeenCalledWith(id);
    await refreshCatalogTools("server");
    expect(fakes.pool.getSession.mock.calls[1]?.[0]).not.toBe(id);
  });

  it("does not publish partial pages; repeated cursors fail safely and clean up", async () => {
    const session = connection();
    session.client.request.mockResolvedValue({
      tools: [tool("a")],
      nextCursor: "loop",
    });
    fakes.pool.getSession.mockResolvedValue(session);
    const { refreshCatalogTools } = await import("./tool-catalog");
    expect((await refreshCatalogTools("server")).success).toBe(false);
    expect(session.client.request).toHaveBeenCalledTimes(2);
    expect(fakes.repository.publish).not.toHaveBeenCalled();
    expect(fakes.pool.cleanupSession).toHaveBeenCalledTimes(1);
  });

  it("publishes successful [] without tools capability or when upstream returns empty", async () => {
    const session = connection();
    session.client.getServerCapabilities.mockReturnValue(
      {} as { tools: object },
    );
    fakes.pool.getSession.mockResolvedValue(session);
    const { refreshCatalogTools } = await import("./tool-catalog");
    expect((await refreshCatalogTools("server")).count).toBe(0);
    expect(session.client.request).not.toHaveBeenCalled();
    expect(fakes.repository.publish).toHaveBeenLastCalledWith("server", 1, []);
    session.client.getServerCapabilities.mockReturnValue({ tools: {} });
    session.client.request.mockResolvedValue({ tools: [] });
    expect((await refreshCatalogTools("server")).success).toBe(true);
    expect(fakes.repository.publish).toHaveBeenLastCalledWith("server", 1, []);
  });

  it.each(["connect", "page"])(
    "cleans up a failed pool %s and never returns credential-bearing errors",
    async (phase) => {
      const session = connection();
      const secret = new Error("https://fake:fake@example.test?token=FAKE");
      if (phase === "connect") fakes.pool.getSession.mockRejectedValue(secret);
      else {
        fakes.pool.getSession.mockResolvedValue(session);
        session.client.request.mockRejectedValue(secret);
      }
      const { refreshCatalogTools } = await import("./tool-catalog");
      expect((await refreshCatalogTools("server")).error).toBe(
        "Tool catalog refresh failed",
      );
      expect(fakes.pool.cleanupSession).toHaveBeenCalledTimes(1);
      expect(fakes.repository.publish).not.toHaveBeenCalled();
      expect(fakes.pool.invalidateServerConnection).not.toHaveBeenCalled();
    },
  );

  it("isolated clients connect and close without touching the pool or DB snapshot", async () => {
    const session = connection();
    const metadata = source();
    metadata.forward_headers = { "x-auth": "Authorization" };
    fakes.repository.findByServerUuid.mockResolvedValue({
      source: metadata,
      tools: [tool("wrong")],
    });
    fakes.create.mockReturnValue(session);
    const { refreshCatalogTools } = await import("./tool-catalog");
    expect(
      (
        await refreshCatalogTools("server", {
          headers: { "x-auth": "fake-forward" },
        })
      ).success,
    ).toBe(true);
    expect(fakes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { static: "fake-static", Authorization: "fake-forward" },
      }),
    );
    expect(session.client.connect).toHaveBeenCalledWith(session.transport);
    expect(session.client.close).toHaveBeenCalledTimes(1);
    expect(session.transport.close).toHaveBeenCalledTimes(1);
    expect(fakes.pool.getSession).not.toHaveBeenCalled();
    expect(fakes.repository.publish).not.toHaveBeenCalled();
  });

  it.each(["connect", "page"])(
    "closes isolated client and transport on %s failure",
    async (phase) => {
      const session = connection();
      const metadata = source();
      metadata.forward_headers = { "x-auth": "Authorization" };
      fakes.repository.findByServerUuid.mockResolvedValue({
        source: metadata,
        tools: [],
      });
      fakes.create.mockReturnValue(session);
      if (phase === "connect")
        session.client.connect.mockRejectedValue(new Error("fake credential"));
      else
        session.client.request.mockRejectedValue(
          new Error("Not connected; token=FAKE-CREDENTIAL"),
        );
      const { refreshCatalogTools } = await import("./tool-catalog");
      expect((await refreshCatalogTools("server")).success).toBe(false);
      expect(session.client.close).toHaveBeenCalledTimes(1);
      expect(session.transport.close).toHaveBeenCalledTimes(1);
      expect(fakes.create).toHaveBeenCalledTimes(1);
      expect(fakes.pool.getSession).not.toHaveBeenCalled();
      expect(fakes.pool.invalidateServerConnection).not.toHaveBeenCalled();
      expect(fakes.logs.warn).not.toHaveBeenCalled();
      expect(fakes.logs.error).not.toHaveBeenCalled();
    },
  );

  it("writes the baseline DB snapshot when forwarding is configured but has no effective values", async () => {
    const session = connection();
    const metadata = source();
    metadata.forward_headers = { "x-auth": "Authorization", cookie: "Cookie" };
    fakes.repository.findByServerUuid.mockResolvedValue({
      source: metadata,
      tools: [],
    });
    fakes.create.mockReturnValue(session);
    const { refreshCatalogTools } = await import("./tool-catalog");
    expect(
      (
        await refreshCatalogTools("server", {
          headers: { cookie: "fake-denied" },
        })
      ).success,
    ).toBe(true);
    expect(fakes.create).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { static: "fake-static" } }),
    );
    expect(fakes.repository.publish).toHaveBeenCalledWith("server", 1, [
      tool("new"),
    ]);
    expect(fakes.pool.getSession).not.toHaveBeenCalled();
    expect(session.client.close).toHaveBeenCalledTimes(1);
  });

  it("restarts every page once on a lost pooled session without logging raw credentials", async () => {
    const stale = connection();
    const fresh = connection();
    stale.client.request
      .mockResolvedValueOnce({
        tools: [tool("discard")],
        nextCursor: "old-page",
      })
      .mockRejectedValueOnce(
        new Error("Not connected; Authorization: Bearer FAKE-SECRET"),
      );
    fresh.client.request
      .mockResolvedValueOnce({
        tools: [tool("fresh-a")],
        nextCursor: "fresh-page",
      })
      .mockResolvedValueOnce({ tools: [tool("fresh-b")] });
    fakes.pool.getSession
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(fresh);
    const { refreshCatalogTools } = await import("./tool-catalog");
    expect(await refreshCatalogTools("server")).toEqual({
      serverUuid: "server",
      success: true,
      count: 2,
    });
    const id = fakes.pool.getSession.mock.calls[0]?.[0];
    expect(
      fakes.pool.invalidateServerConnection,
    ).toHaveBeenCalledExactlyOnceWith(id, "server", stale);
    expect(fakes.pool.getSession.mock.calls[1]).toEqual(
      fakes.pool.getSession.mock.calls[0],
    );
    expect(fresh.client.request).toHaveBeenNthCalledWith(
      1,
      { method: "tools/list", params: {} },
      expect.any(Object),
    );
    expect(fresh.client.request).toHaveBeenNthCalledWith(
      2,
      { method: "tools/list", params: { cursor: "fresh-page" } },
      expect.any(Object),
    );
    expect(fakes.repository.publish).toHaveBeenCalledExactlyOnceWith(
      "server",
      1,
      [tool("fresh-a"), tool("fresh-b")],
    );
    expect(fakes.pool.cleanupSession).toHaveBeenCalledExactlyOnceWith(id);
    expect(fakes.logs.warn).not.toHaveBeenCalled();
    expect(fakes.logs.error).not.toHaveBeenCalled();
  });

  it("stops after one read retry and never publishes either generation's partial pages", async () => {
    const stale = connection();
    const fresh = connection();
    stale.client.request.mockRejectedValueOnce(new Error("Not connected"));
    fresh.client.request
      .mockResolvedValueOnce({ tools: [tool("discard")], nextCursor: "page-2" })
      .mockRejectedValueOnce(new Error("Not connected; password=FAKE-SECRET"));
    fakes.pool.getSession
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(fresh);
    const { refreshCatalogTools } = await import("./tool-catalog");
    expect(await refreshCatalogTools("server")).toEqual({
      serverUuid: "server",
      success: false,
      count: 0,
      error: "Tool catalog refresh failed",
    });
    expect(fakes.pool.getSession).toHaveBeenCalledTimes(2);
    expect(fakes.pool.invalidateServerConnection).toHaveBeenCalledTimes(1);
    expect(fakes.repository.publish).not.toHaveBeenCalled();
    expect(fakes.pool.cleanupSession).toHaveBeenCalledTimes(1);
    expect(fakes.logs.warn).not.toHaveBeenCalled();
    expect(fakes.logs.error).not.toHaveBeenCalled();
  });

  it("cleans up when recovery cannot acquire a replacement session", async () => {
    const stale = connection();
    stale.client.request.mockRejectedValue(new Error("Not connected"));
    fakes.pool.getSession
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(undefined);
    const { refreshCatalogTools } = await import("./tool-catalog");
    expect(await refreshCatalogTools("server")).toEqual({
      serverUuid: "server",
      success: false,
      count: 0,
      error: "Tool catalog refresh failed",
    });
    expect(fakes.pool.getSession).toHaveBeenCalledTimes(2);
    expect(fakes.pool.invalidateServerConnection).toHaveBeenCalledTimes(1);
    expect(fakes.pool.cleanupSession).toHaveBeenCalledTimes(1);
    expect(fakes.repository.publish).not.toHaveBeenCalled();
  });

  it("preserves real SDK wire-level Tool and nested extensions without losing known fields", async () => {
    const definition = {
      name: "vendor-tool",
      title: "Vendor tool",
      description: "Synthetic test",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string", "x-vendor": { nested: true } } },
        required: ["value"],
        additionalProperties: false,
        "x-vendor": { input: true },
      },
      outputSchema: {
        type: "object",
        properties: { result: { type: "string" } },
        additionalProperties: false,
        "x-vendor": { output: true },
      },
      annotations: {
        title: "Hint",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        "x-vendor": { annotation: true },
      },
      execution: { taskSupport: "optional", "x-vendor": "execution" },
      _meta: { "vendor/key": { metadata: true } },
      "x-vendor": { top: true },
    };
    const session = await realUpstream([definition]);
    try {
      fakes.pool.getSession.mockResolvedValue(session);
      const { refreshCatalogTools } = await import("./tool-catalog");
      expect(await refreshCatalogTools("server")).toEqual({
        serverUuid: "server",
        success: true,
        count: 1,
      });
      expect(fakes.repository.publish).toHaveBeenCalledExactlyOnceWith(
        "server",
        1,
        [definition],
      );
      expect(fakes.pool.invalidateServerConnection).not.toHaveBeenCalled();
    } finally {
      await session.cleanup();
    }
  });

  it.each([
    { title: 7 },
    { inputSchema: { type: "string" } },
    { inputSchema: { type: "object", required: [3] } },
    { outputSchema: { type: "array" } },
    { annotations: { readOnlyHint: "yes" } },
  ])(
    "rejects invalid known fields through the real SDK: %j",
    async (invalid) => {
      const session = await realUpstream([
        { ...tool("invalid"), ...invalid, "x-vendor": "allowed" },
      ]);
      try {
        fakes.pool.getSession.mockResolvedValue(session);
        const { refreshCatalogTools } = await import("./tool-catalog");
        expect(await refreshCatalogTools("server")).toEqual({
          serverUuid: "server",
          success: false,
          count: 0,
          error: "Tool catalog refresh failed",
        });
        expect(fakes.repository.publish).not.toHaveBeenCalled();
        expect(fakes.pool.invalidateServerConnection).not.toHaveBeenCalled();
        expect(fakes.pool.cleanupSession).toHaveBeenCalledTimes(1);
      } finally {
        await session.cleanup();
      }
    },
  );

  it("rejects a saved configuration revision mismatch before connecting", async () => {
    fakes.servers.findByUuid.mockResolvedValue({
      uuid: "server",
      tool_catalog_revision: 2,
    });
    const { refreshCatalogTools } = await import("./tool-catalog");
    expect((await refreshCatalogTools("server")).success).toBe(false);
    expect(fakes.convert).not.toHaveBeenCalled();
    expect(fakes.pool.getSession).not.toHaveBeenCalled();
  });
});
