import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  byServer: vi.fn(),
  byNamespace: vi.fn(),
  publish: vi.fn(),
  namespace: vi.fn(),
  tools: vi.fn(),
  refresh: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("../db/repositories", () => ({
  namespacesRepository: { findByUuid: mocks.namespace },
  toolsRepository: { findByMcpServerUuid: mocks.tools },
}));
vi.mock("../db/repositories/tool-catalog.repo", () => ({
  toolCatalogRepository: {
    findByServerUuid: mocks.byServer,
    findByNamespace: mocks.byNamespace,
    publish: mocks.publish,
  },
}));
vi.mock("../db/serializers", () => ({
  ToolsSerializer: { serializeToolList: (tools: unknown[]) => tools },
}));
vi.mock("../lib/metamcp/tool-catalog", () => ({
  refreshCatalogTools: mocks.refresh,
}));
vi.mock("../lib/metamcp/tool-catalog-events", () => ({
  notifyToolCatalogChanged: mocks.notify,
}));
vi.mock("@/utils/logger", () => ({ default: { error: vi.fn() } }));

import { createFrontendRouter } from "@repo/trpc";

import { toolsImplementations as api } from "./tools.impl";

const toolRouter = () =>
  createFrontendRouter({
    tools: api,
    mcpServers: {} as never,
    namespaces: {} as never,
    endpoints: {} as never,
    oauth: {} as never,
    apiKeys: {} as never,
    config: {} as never,
    logs: {} as never,
    mcpRequestAuditLogs: {} as never,
  }).tools;

const uuid = "00000000-0000-4000-8000-000000000039";
const ns = "00000000-0000-4000-8000-000000000040";
const existing = { name: "old", inputSchema: { type: "object" as const } };
function catalog(owner: string | null = "owner") {
  return {
    source: {
      uuid,
      name: "test",
      user_id: owner,
      revision: 4,
      forward_headers: null,
      refreshedAt: new Date(),
    },
    tools: [existing],
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.byServer.mockResolvedValue(catalog());
  mocks.byNamespace.mockResolvedValue([catalog()]);
  mocks.namespace.mockResolvedValue({ user_id: "owner" });
  mocks.publish.mockResolvedValue(true);
  mocks.tools.mockResolvedValue([]);
  mocks.refresh.mockResolvedValue({
    serverUuid: uuid,
    success: true,
    count: 2,
  });
});

describe("catalog RPC authorization and persistence", () => {
  it("rejects anonymous router calls before source lookup or refresh", async () => {
    const caller = toolRouter().createCaller({});
    await expect(caller.refresh({ mcpServerUuid: uuid })).rejects.toMatchObject(
      { code: "UNAUTHORIZED" },
    );
    expect(mocks.byServer).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("forwards the authenticated owner through the real router", async () => {
    const caller = toolRouter().createCaller({
      user: { id: "owner" },
      session: {},
    });
    expect(await caller.refresh({ mcpServerUuid: uuid })).toMatchObject({
      success: true,
      count: 2,
    });
    expect(mocks.refresh).toHaveBeenCalledWith(uuid);
  });

  it.each(["stranger", ""])(
    "rejects inaccessible private catalogs for actor %s",
    async (actor) => {
      expect((await api.refresh({ mcpServerUuid: uuid }, actor)).success).toBe(
        false,
      );
      expect(
        (await api.getByMcpServerUuid({ mcpServerUuid: uuid }, actor)).success,
      ).toBe(false);
      expect(
        (await api.sync({ mcpServerUuid: uuid, tools: [] }, actor)).success,
      ).toBe(false);
      expect(mocks.refresh).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.tools).not.toHaveBeenCalled();
    },
  );

  it("permits public discovery but never caller-supplied public catalog replacement", async () => {
    mocks.byServer.mockResolvedValue(catalog(null));
    expect((await api.refresh({ mcpServerUuid: uuid }, "reader")).success).toBe(
      true,
    );
    expect(
      (await api.sync({ mcpServerUuid: uuid, tools: [] }, "reader")).success,
    ).toBe(false);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("checks namespace ownership and all source owners before any discovery", async () => {
    mocks.namespace.mockResolvedValue({ user_id: "other" });
    expect((await api.refresh({ namespaceUuid: ns }, "owner")).success).toBe(
      false,
    );
    mocks.namespace.mockResolvedValue({ user_id: "owner" });
    mocks.byNamespace.mockResolvedValue([catalog("other")]);
    expect((await api.refresh({ namespaceUuid: ns }, "owner")).success).toBe(
      false,
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("reports partial namespace failure without disguising it as success", async () => {
    mocks.byNamespace.mockResolvedValue([
      catalog(),
      { ...catalog(), source: { ...catalog().source, uuid: "second" } },
    ]);
    mocks.refresh
      .mockResolvedValueOnce({ serverUuid: uuid, success: true, count: 2 })
      .mockResolvedValueOnce({
        serverUuid: "second",
        success: false,
        count: 0,
        error: "Tool catalog refresh failed",
      });
    const result = await api.refresh({ namespaceUuid: ns }, "owner");
    expect(result).toMatchObject({
      success: false,
      count: 2,
      results: [{ success: true }, { success: false }],
    });
    expect(result.error).toBeDefined();
  });

  it("publishes a successful empty snapshot using the current revision", async () => {
    expect(
      (await api.sync({ mcpServerUuid: uuid, tools: [] }, "owner")).success,
    ).toBe(true);
    expect(mocks.publish).toHaveBeenCalledWith(uuid, 4, []);
    expect(mocks.notify).toHaveBeenCalledWith(uuid);
  });

  it("preserves complete schema and MCP extension fields in an owner update", async () => {
    const tool = {
      name: "full",
      title: "Title",
      description: "v2",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object" as const, additionalProperties: false },
      outputSchema: { type: "object" as const },
      _meta: { version: 2 },
      "x-extra": true,
    };
    expect(
      (await api.sync({ mcpServerUuid: uuid, tools: [tool] }, "owner")).success,
    ).toBe(true);
    expect(mocks.publish).toHaveBeenCalledWith(uuid, 4, [tool]);
  });

  it("does not notify or claim success when a concurrent configuration update rejects publication", async () => {
    mocks.publish.mockResolvedValue(false);
    expect(
      (await api.sync({ mcpServerUuid: uuid, tools: [] }, "owner")).success,
    ).toBe(false);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("does not return credential-bearing repository exception details", async () => {
    mocks.byServer.mockRejectedValue(
      new Error("postgresql://fake:FAKE@invalid/db"),
    );
    const result = await api.refresh({ mcpServerUuid: uuid }, "owner");
    expect(JSON.stringify(result)).not.toContain("FAKE");
    expect(result.success).toBe(false);
  });
});
