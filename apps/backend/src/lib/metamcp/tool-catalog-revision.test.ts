import type { DatabaseMcpServer, ServerParameters } from "@repo/zod-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectedClient } from "./client";
import type { McpServerPool } from "./mcp-server-pool";

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  saved: vi.fn(),
  oauth: vi.fn(),
  connect: vi.fn(),
  publish: vi.fn(),
  create: vi.fn(),
}));
vi.mock("../../db/repositories/tool-catalog.repo", () => ({
  toolCatalogRepository: {
    findByServerUuid: mocks.metadata,
    findRevisionByServerUuid: async () =>
      (await mocks.metadata())?.source.revision,
    publish: mocks.publish,
  },
}));
vi.mock("../../db/repositories/mcp-servers.repo", () => ({
  mcpServersRepository: { findByUuid: mocks.saved },
}));
vi.mock("../../db/repositories/oauth-sessions.repo", () => ({
  oauthSessionsRepository: { findByMcpServerUuid: mocks.oauth },
}));
vi.mock("./client", () => ({
  connectMetaMcpClient: mocks.connect,
  createMetaMcpClient: mocks.create,
}));
vi.mock("../config.service", () => ({ configService: {} }));
vi.mock("./server-error-tracker", () => ({ serverErrorTracker: {} }));
vi.mock("./log-store", () => ({ metamcpLogStore: { addLog: vi.fn() } }));
vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function connection(revision: number) {
  return {
    client: {
      getServerCapabilities: () => ({ tools: {} }),
      getServerVersion: () => ({ name: "synthetic-upstream", version: "1" }),
      request: vi.fn().mockResolvedValue({
        tools: [
          {
            name: revision === 1 ? "OLD_TOOL" : "NEW_TOOL",
            inputSchema: { type: "object" },
          },
        ],
      }),
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConnectedClient["client"],
    cleanup: vi.fn().mockResolvedValue(undefined),
    transport: { close: vi.fn().mockResolvedValue(undefined) },
  };
}
let revision: number;
let forwarding: boolean;
let pool: McpServerPool;
function saved(): DatabaseMcpServer {
  return {
    uuid: "server",
    name: "Server",
    description: "",
    type: "STREAMABLE_HTTP",
    url: `https://r${revision}.invalid/mcp`,
    command: null,
    args: [],
    env: {},
    headers: {},
    bearerToken: null,
    forward_headers: forwarding ? { "x-user": "x-user" } : {},
    user_id: "owner",
    error_status: "NONE",
    created_at: new Date(0),
    tool_catalog_revision: revision,
  };
}
function metadata() {
  return {
    source: {
      uuid: "server",
      name: "Server",
      user_id: "owner",
      forward_headers: saved().forward_headers,
      revision,
      refreshedAt: null,
    },
    tools: [],
  };
}
async function params() {
  const { convertDbServerToParams } = await import("./utils");
  const result = await convertDbServerToParams(saved());
  if (!result) throw new Error("fixture conversion failed");
  return result;
}
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubEnv("MAX_TOTAL_CONNECTIONS", "100");
  vi.resetModules();
  vi.resetAllMocks();
  revision = 1;
  forwarding = false;
  mocks.metadata.mockImplementation(async () => metadata());
  mocks.saved.mockImplementation(async () => saved());
  mocks.oauth.mockResolvedValue(undefined);
  mocks.connect.mockImplementation(async (p: ServerParameters) =>
    connection(p.tool_catalog_revision ?? 0),
  );
  mocks.create.mockImplementation((p: ServerParameters) =>
    connection(p.tool_catalog_revision ?? 0),
  );
  mocks.publish.mockImplementation(
    async (_uuid, expected) => expected === revision,
  );
  pool = (await import("./mcp-server-pool")).mcpServerPool;
});
afterEach(async () => {
  await flush();
  await pool.cleanupAll();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("configuration revision across conversion, pool and catalog", () => {
  it.each([false, true])(
    "rejects R1 conversion resumed after R2 save; the next catalog cannot publish OLD_TOOL (forwarded=%s)",
    async (forward) => {
      forwarding = forward;
      const started = deferred<void>();
      const resume = deferred<undefined>();
      mocks.oauth.mockImplementationOnce(() => {
        started.resolve();
        return resume.promise;
      });
      const { refreshCatalogTools } = await import("./tool-catalog");
      const oldRefresh = refreshCatalogTools("server");
      await started.promise;
      revision = 2;
      await pool.invalidateServerConfiguration("server", 2);
      resume.resolve(undefined);
      expect((await oldRefresh).success).toBe(false);
      expect(mocks.connect).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
      expect((await refreshCatalogTools("server")).success).toBe(true);
      expect(mocks.publish).toHaveBeenCalledExactlyOnceWith("server", 2, [
        { name: "NEW_TOOL", inputSchema: { type: "object" } },
      ]);
    },
  );

  it.each([false, true])(
    "direct saved-parameter acquisition cannot bypass metadata fencing (forwarded=%s)",
    async (forward) => {
      forwarding = forward;
      const old = await params();
      revision = 2; // Deliberately omit the event; metadata must be authoritative.
      expect(await pool.getSession("client", "server", old)).toBeUndefined();
      expect(mocks.connect).not.toHaveBeenCalled();
      const current = await params();
      const client = await pool.getSession("client", "server", current);
      expect(client).toBeDefined();
      expect(
        mocks.connect.mock.calls.every(([p]) => p.tool_catalog_revision === 2),
      ).toBe(true);
    },
  );

  it("does not reuse old active/idle clients in the same session when metadata advances without an event", async () => {
    const old = await pool.getSession("client", "server", await params());
    await flush();
    revision = 2;
    const current = await pool.getSession("client", "server", await params());
    expect(current).toBeDefined();
    expect(current).not.toBe(old);
    await flush();
    expect(old?.cleanup).toHaveBeenCalledTimes(1);
    expect(current?.cleanup).not.toHaveBeenCalled();
    await pool.invalidateServerConfiguration("server", 2);
    expect(pool.getSessionConnections("client")?.server).toBe(current);
    expect(current?.cleanup).not.toHaveBeenCalled();
  });

  it.each([2, 3])(
    "late R2 events preserve R%s active, idle and in-flight connections",
    async (currentRevision) => {
      revision = currentRevision;
      const currentParams = await params();
      const started = deferred<void>();
      const finish = deferred<ConnectedClient>();
      const active = connection(currentRevision);
      const idle = connection(currentRevision);
      const idleStarted = deferred<void>();
      const idleFinish = deferred<ConnectedClient>();
      mocks.connect
        .mockImplementationOnce(() => {
          started.resolve();
          return finish.promise;
        })
        .mockImplementationOnce(() => {
          idleStarted.resolve();
          return idleFinish.promise;
        });
      const pending = pool.getSession("client", "server", currentParams);
      await started.promise;
      const { invalidateCatalogConnections } =
        await import("./tool-catalog-events");
      await invalidateCatalogConnections("server", 2);
      finish.resolve(active);
      expect(await pending).toBe(active);
      await idleStarted.promise;
      await invalidateCatalogConnections("server", 2);
      await invalidateCatalogConnections("server", 1);
      idleFinish.resolve(idle);
      await vi.waitFor(() => expect(pool.getPoolStatus().idle).toBe(1));
      const count = mocks.connect.mock.calls.length;
      await invalidateCatalogConnections("server", 2);
      await invalidateCatalogConnections("server", 1);
      expect(await pool.getSession("client", "server", currentParams)).toBe(
        active,
      );
      expect(pool.getPoolStatus().idle).toBe(1);
      expect(mocks.connect).toHaveBeenCalledTimes(count);
      expect(active.cleanup).not.toHaveBeenCalled();
      expect(idle.cleanup).not.toHaveBeenCalled();
    },
  );

  it("never lowers the revision floor when an older event and metadata reply arrive late", async () => {
    revision = 2;
    const oldParams = await params();
    const snapshot = metadata();
    const started = deferred<void>();
    const reply = deferred<ReturnType<typeof metadata>>();
    mocks.metadata.mockImplementationOnce(() => {
      started.resolve();
      return reply.promise;
    });
    const pending = pool.getSession("client", "server", oldParams);
    await started.promise;
    revision = 3;
    await pool.invalidateServerConfiguration("server", 3);
    await pool.invalidateServerConfiguration("server", 2);
    reply.resolve(snapshot);
    expect(await pending).toBeUndefined();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(
      await pool.getSession("client", "server", await params()),
    ).toBeDefined();
  });

  it("old acquisition and retry cannot refill or join a current-revision session", async () => {
    forwarding = true;
    const oldParams = await params();
    const started = deferred<void>();
    const finish = deferred<ConnectedClient>();
    const old = connection(1);
    mocks.connect.mockImplementationOnce(() => {
      started.resolve();
      return finish.promise;
    });
    const pending = pool.getSession("client", "server", oldParams);
    await started.promise;
    revision = 2;
    const current = await pool.getSession("client", "server", await params());
    finish.resolve(old);
    expect(await pending).toBeUndefined();
    expect(old.cleanup).toHaveBeenCalledTimes(1);
    expect(
      await pool.getSession("client", "server", oldParams),
    ).toBeUndefined();
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(pool.getSessionConnections("client")?.server).toBe(current);
  });

  it("one-read catalog recovery cannot respawn the previous revision", async () => {
    const old = connection(1);
    vi.mocked(old.client.request).mockImplementation(async () => {
      revision = 2;
      await pool.invalidateServerConfiguration("server", 2);
      throw new Error("Not connected");
    });
    mocks.connect.mockResolvedValueOnce(old);
    const { refreshCatalogTools } = await import("./tool-catalog");
    expect((await refreshCatalogTools("server")).success).toBe(false);
    expect(mocks.publish).not.toHaveBeenCalled();
    // Any background R1 connection has been fenced too; recovery cannot spawn R1 again.
    const oldSpawns = mocks.connect.mock.calls.length;
    expect((await refreshCatalogTools("server")).success).toBe(true);
    expect(
      mocks.connect.mock.calls
        .slice(oldSpawns)
        .every(([p]) => p.tool_catalog_revision === 2),
    ).toBe(true);
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith("server", 2, [
      { name: "NEW_TOOL", inputSchema: { type: "object" } },
    ]);
  });

  it("late idle completion and stale prewarm/refresh never clear or replace the new revision", async () => {
    const oldParams = await params();
    const started = deferred<void>();
    const finish = deferred<ConnectedClient>();
    const old = connection(1);
    mocks.connect.mockImplementationOnce(() => {
      started.resolve();
      return finish.promise;
    });
    const pending = pool.ensureIdleSessions({ server: oldParams });
    await started.promise;
    revision = 2;
    await pool.invalidateServerConfiguration("server", 2);
    const currentParams = await params();
    await pool.ensureIdleSessions({ server: currentParams });
    finish.resolve(old);
    await pending;
    expect(old.cleanup).toHaveBeenCalledTimes(1);
    const count = mocks.connect.mock.calls.length;
    await pool.ensureIdleSessionForNewServer("server", oldParams);
    await pool.invalidateIdleSession("server", oldParams);
    await pool.ensureIdleSessions({ server: oldParams });
    expect(mocks.connect).toHaveBeenCalledTimes(count);
    expect(pool.getPoolStatus().idle).toBe(1);
    const current = await pool.getSession("client", "server", currentParams);
    expect(current).toBeDefined();
    expect(current).not.toBe(old);
  });
});
