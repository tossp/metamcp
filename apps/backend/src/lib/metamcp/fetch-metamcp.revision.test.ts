import { ServerParametersSchema } from "@repo/zod-types";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  oauth: vi.fn(),
  revision: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("../../db/index", () => ({ db: { select: mocks.select } }));
vi.mock("../../db/repositories/index", () => ({
  oauthSessionsRepository: { findByMcpServerUuid: mocks.oauth },
}));
vi.mock("../../db/repositories/oauth-sessions.repo", () => ({
  oauthSessionsRepository: { findByMcpServerUuid: mocks.oauth },
}));
vi.mock("../../db/repositories/tool-catalog.repo", () => ({
  toolCatalogRepository: { findRevisionByServerUuid: mocks.revision },
}));
vi.mock("./client", () => ({ connectMetaMcpClient: mocks.connect }));
vi.mock("../config.service", () => ({ configService: {} }));
vi.mock("./server-error-tracker", () => ({ serverErrorTracker: {} }));
vi.mock("./log-store", () => ({ metamcpLogStore: { addLog: vi.fn() } }));
vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("MAX_TOTAL_CONNECTIONS", "100");
  vi.resetAllMocks();
  vi.resetModules();
});
afterEach(async () => {
  const { mcpServerPool } = await import("./mcp-server-pool");
  await mcpServerPool.cleanupAll();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each([false, true])(
  "namespace projection preserves R1 through delayed OAuth conversion; pool rejects after R2 (forwarded=%s)",
  async (forwarded) => {
    let resume!: (value: undefined) => void;
    let started!: () => void;
    const paused = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.oauth.mockImplementation(() => {
      started();
      return new Promise<undefined>((resolve) => {
        resume = resolve;
      });
    });
    const row = {
      uuid: "server",
      name: "Server",
      description: "",
      type: "STREAMABLE_HTTP",
      url: "https://old.invalid/mcp",
      created_at: new Date(0),
      status: "ACTIVE",
      error_status: "NONE",
      user_id: "owner",
      headers: {},
      forward_headers: forwarded ? { "x-user": "x-user" } : {},
      tool_catalog_revision: 1,
    };
    mocks.select.mockImplementation((projection) => {
      const builder = {
        from: () => builder,
        innerJoin: () => builder,
        where: async () => [
          Object.fromEntries(
            Object.keys(projection).map((key) => [
              key,
              row[key as keyof typeof row],
            ]),
          ),
        ],
      };
      return builder;
    });
    const { getMcpServers } = await import("./fetch-metamcp");
    const { mcpServerPool } = await import("./mcp-server-pool");
    const fetching = getMcpServers("namespace");
    await paused;
    mocks.revision.mockResolvedValue(2);
    await mcpServerPool.invalidateServerConfiguration("server", 2);
    resume(undefined);
    const servers = await fetching;
    expect(servers.server?.tool_catalog_revision).toBe(1);
    expect(
      ServerParametersSchema.parse(servers.server).tool_catalog_revision,
    ).toBe(1);
    expect(
      await mcpServerPool.getSession("client", "server", servers.server),
    ).toBeUndefined();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.select).toHaveBeenCalledTimes(1);
  },
);
