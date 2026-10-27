import type { ServerParameters } from "@repo/zod-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectedClient } from "./client";
import type { McpServerPool } from "./mcp-server-pool";

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("./client", () => ({ connectMetaMcpClient: mocks.connect }));
vi.mock("@/utils/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../config.service", () => ({ configService: {} }));
vi.mock("./server-error-tracker", () => ({ serverErrorTracker: {} }));
vi.mock("./log-store", () => ({ metamcpLogStore: { addLog: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function connection() {
  let closed = false;
  return {
    client: {
      ping: vi.fn(async () => {
        if (closed) throw new Error("Connection closed");
        return {};
      }),
    } as unknown as ConnectedClient["client"],
    cleanup: vi.fn(async () => {
      closed = true;
    }),
  };
}

const params: ServerParameters = {
  uuid: "catalog-server",
  name: "catalog",
  description: "",
  type: "STREAMABLE_HTTP",
  url: "https://catalog.invalid/mcp",
  status: "ACTIVE",
  stderr: "pipe",
  created_at: "2026-10-27T00:00:00Z",
};
const forwarded: ServerParameters = {
  ...params,
  forward_headers: { "x-user": "x-user" },
  headers: { "x-user": "alice" },
};
let pool: McpServerPool;

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubEnv("MAX_TOTAL_CONNECTIONS", "100");
  vi.resetModules();
  mocks.connect.mockReset().mockImplementation(async () => connection());
  pool = (await import("./mcp-server-pool")).mcpServerPool;
});
afterEach(async () => {
  await pool.cleanupAll();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("server configuration generation", () => {
  it("detaches active/idle refs synchronously and cleanup never touches replacements or other servers", async () => {
    const old = connection();
    const idle = connection();
    const other = connection();
    mocks.connect
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(idle)
      .mockResolvedValueOnce(other);
    await pool.getSession("session", params.uuid, params);
    await flush();
    const otherParams = { ...forwarded, uuid: "other-server" };
    await pool.getSession("session", otherParams.uuid, otherParams);
    const cleanup = deferred<void>();
    old.cleanup.mockImplementation(() => cleanup.promise);
    idle.cleanup.mockImplementation(() => cleanup.promise);

    const invalidation = pool.invalidateServerConfiguration(params.uuid);
    expect(
      pool.getSessionConnections("session")?.[params.uuid],
    ).toBeUndefined();
    expect(pool.getPoolStatus().idleServerUuids).not.toContain(params.uuid);
    expect(pool.getSessionConnections("session")?.[otherParams.uuid]).toBe(
      other,
    );
    const fresh = connection();
    const freshIdle = connection();
    mocks.connect.mockResolvedValueOnce(fresh).mockResolvedValueOnce(freshIdle);
    const updated = { ...params, url: "https://updated.invalid/mcp" };
    expect(await pool.getSession("session", params.uuid, updated)).toBe(fresh);
    await flush();
    expect(mocks.connect.mock.calls.at(-1)?.[0]).toBe(updated);

    cleanup.resolve();
    await invalidation;
    expect(pool.getSessionConnections("session")?.[params.uuid]).toBe(fresh);
    expect(await pool.getSession("new-session", params.uuid, updated)).toBe(
      freshIdle,
    );
    expect(old.cleanup).toHaveBeenCalledTimes(1);
    expect(idle.cleanup).toHaveBeenCalledTimes(1);
    expect(fresh.cleanup).not.toHaveBeenCalled();
    expect(freshIdle.cleanup).not.toHaveBeenCalled();
    expect(other.cleanup).not.toHaveBeenCalled();
    expect(pool.getSessionConnections("session")?.[otherParams.uuid]).toBe(
      other,
    );
  });

  it("does not join an old inflight acquisition and cleans its late result without storing it", async () => {
    const pending = deferred<ConnectedClient>();
    const stale = connection();
    const fresh = connection();
    mocks.connect
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(fresh);
    const first = pool.getSession("session", params.uuid, forwarded);
    const deduped = pool.getSession("session", params.uuid, forwarded);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    await pool.invalidateServerConfiguration(params.uuid);
    expect(await pool.getSession("session", params.uuid, forwarded)).toBe(
      fresh,
    );
    expect(mocks.connect).toHaveBeenCalledTimes(2);

    pending.resolve(stale);
    expect(await first).toBeUndefined();
    expect(await deduped).toBeUndefined();
    expect(stale.cleanup).toHaveBeenCalledTimes(1);
    expect(fresh.cleanup).not.toHaveBeenCalled();
    expect(pool.getSessionConnections("session")?.[params.uuid]).toBe(fresh);
  });

  it("keeps the new inflight dedup entry when an older acquisition settles", async () => {
    const oldPending = deferred<ConnectedClient>();
    const newPending = deferred<ConnectedClient>();
    const stale = connection();
    const fresh = connection();
    mocks.connect
      .mockReturnValueOnce(oldPending.promise)
      .mockReturnValueOnce(newPending.promise);
    const first = pool.getSession("session", params.uuid, forwarded);
    await pool.invalidateServerConfiguration(params.uuid);
    const second = pool.getSession("session", params.uuid, forwarded);
    oldPending.resolve(stale);
    expect(await first).toBeUndefined();
    const third = pool.getSession("session", params.uuid, forwarded);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    newPending.resolve(fresh);
    expect(await second).toBe(fresh);
    expect(await third).toBe(fresh);
  });

  it("fences already-resolved active reuse before getSession returns", async () => {
    const old = connection();
    mocks.connect.mockResolvedValueOnce(old);
    await pool.getSession("session", params.uuid, forwarded);
    const reuse = pool.getSession("session", params.uuid, forwarded);
    const invalidation = pool.invalidateServerConfiguration(params.uuid);
    expect(await reuse).toBeUndefined();
    await invalidation;
    expect(old.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each(["blocking", "background"])(
    "discards late %s idle creation without clearing the new idle guard",
    async (mode) => {
      const pending = deferred<ConnectedClient>();
      const replacement = deferred<ConnectedClient>();
      const stale = connection();
      const fresh = connection();
      if (mode === "background") {
        mocks.connect.mockResolvedValueOnce(connection());
      }
      mocks.connect
        .mockReturnValueOnce(pending.promise)
        .mockReturnValueOnce(replacement.promise);
      const oldTask =
        mode === "blocking"
          ? pool.ensureIdleSessions({ [params.uuid]: params })
          : pool.getSession("session", params.uuid, params);
      await flush();
      await pool.invalidateServerConfiguration(params.uuid);
      const newTask = pool.ensureIdleSessions({ [params.uuid]: params });
      pending.resolve(stale);
      await oldTask;
      await flush();
      expect(stale.cleanup).toHaveBeenCalledTimes(1);
      await pool.ensureIdleSessions({ [params.uuid]: params });
      expect(mocks.connect).toHaveBeenCalledTimes(mode === "blocking" ? 2 : 3);
      replacement.resolve(fresh);
      await newTask;
      expect(await pool.getSession("new-session", params.uuid, params)).toBe(
        fresh,
      );
      expect(fresh.cleanup).not.toHaveBeenCalled();
    },
  );
});

describe("session cleanup ownership", () => {
  it("keeps an at-cap static alias active and recycles only its final owner", async () => {
    const oldest = await pool.getSession("client", params.uuid, params);
    const cap = pool.getPoolStatus().maxConnectionsPerServer ?? 0;
    expect(cap).toBeGreaterThan(0);
    for (let i = 1; i < cap; i++) {
      vi.advanceTimersByTime(1);
      await pool.getSession(`session-${i}`, params.uuid, params);
      await flush();
    }
    expect(await pool.getSession("refresh", params.uuid, params)).toBe(oldest);
    await pool.cleanupSession("refresh");
    expect(pool.getSessionConnections("refresh")).toBeUndefined();
    expect(pool.getPoolStatus().idle).toBe(0);
    expect(oldest?.cleanup).not.toHaveBeenCalled();
    expect(await pool.getSession("client", params.uuid, params)).toBe(oldest);
    await expect(oldest?.client.ping()).resolves.toEqual({});

    await pool.cleanupSession("client");
    await pool.cleanupSession("client");
    expect(pool.getPoolStatus().idle).toBe(1);
    expect(oldest?.cleanup).not.toHaveBeenCalled();
    expect(await pool.getSession("next", params.uuid, params)).toBe(oldest);
  });

  it("does not close an instance that is already idle", async () => {
    const shared = connection();
    mocks.connect.mockResolvedValueOnce(shared).mockResolvedValueOnce(shared);
    await pool.getSession("client", params.uuid, params);
    await flush();
    await pool.cleanupSession("client");
    expect(shared.cleanup).not.toHaveBeenCalled();
    expect(pool.getPoolStatus().idle).toBe(1);
    expect(await pool.getSession("next", params.uuid, params)).toBe(shared);
  });

  it("closes forwarded sessions without pooling them or affecting another identity", async () => {
    const alice = await pool.getSession("alice", params.uuid, forwarded);
    const bob = await pool.getSession("bob", params.uuid, {
      ...forwarded,
      headers: { "x-user": "bob" },
    });
    await pool.cleanupSession("alice");
    expect(alice?.cleanup).toHaveBeenCalledTimes(1);
    expect(pool.getPoolStatus().idle).toBe(0);
    expect(pool.getSessionConnections("bob")?.[params.uuid]).toBe(bob);
    expect(bob?.cleanup).not.toHaveBeenCalled();
    await expect(bob?.client.ping()).resolves.toEqual({});
    await pool.cleanupSession("bob");
    expect(bob?.cleanup).toHaveBeenCalledTimes(1);
    expect(pool.getPoolStatus().idle).toBe(0);
  });

  it("decides all ownership before awaiting and preserves a new session with the same ID", async () => {
    const slow = connection();
    const recyclable = connection();
    const cleanup = deferred<void>();
    slow.cleanup.mockImplementation(() => cleanup.promise);
    mocks.connect
      .mockResolvedValueOnce(slow)
      .mockResolvedValueOnce(recyclable)
      .mockResolvedValueOnce(undefined);
    await pool.getSession("session", params.uuid, forwarded);
    const otherParams = { ...params, uuid: "other-server" };
    await pool.getSession("session", otherParams.uuid, otherParams);
    await flush();
    const cleaning = pool.cleanupSession("session");
    expect(pool.getSessionConnections("session")).toBeUndefined();
    expect(pool.getSessionAge("session")).toBeUndefined();
    expect(pool.getPoolStatus().idleServerUuids).toContain(otherParams.uuid);
    const fresh = await pool.getSession("session", params.uuid, forwarded);
    cleanup.resolve();
    await cleaning;
    expect(pool.getSessionConnections("session")?.[params.uuid]).toBe(fresh);
    expect(pool.getSessionAge("session")).toBeDefined();
    expect(fresh?.cleanup).not.toHaveBeenCalled();
    expect(slow.cleanup).toHaveBeenCalledTimes(1);
    expect(recyclable.cleanup).not.toHaveBeenCalled();
  });

  it.each(["cleanup-first", "invalidation-first"])(
    "cleans exactly once across configuration invalidation (%s)",
    async (order) => {
      const old = connection();
      const cleanup = deferred<void>();
      old.cleanup.mockImplementation(() => cleanup.promise);
      mocks.connect.mockResolvedValueOnce(old);
      await pool.getSession("session", params.uuid, forwarded);
      const tasks =
        order === "cleanup-first"
          ? [
              pool.cleanupSession("session"),
              pool.invalidateServerConfiguration(params.uuid),
            ]
          : [
              pool.invalidateServerConfiguration(params.uuid),
              pool.cleanupSession("session"),
            ];
      tasks.push(pool.invalidateServerConnection("session", params.uuid, old));
      const fresh = await pool.getSession("session", params.uuid, forwarded);
      cleanup.resolve();
      await Promise.all(tasks);
      expect(old.cleanup).toHaveBeenCalledTimes(1);
      expect(fresh?.cleanup).not.toHaveBeenCalled();
      expect(pool.getSessionConnections("session")?.[params.uuid]).toBe(fresh);
      expect(pool.getPoolStatus().idle).toBe(0);
    },
  );
});

describe("per-server cap identity boundary", () => {
  it("refuses cross-client forwarded identity reuse at cap but preserves same-session reuse", async () => {
    const alice = await pool.getSession("alice", params.uuid, forwarded);
    const cap = pool.getPoolStatus().maxConnectionsPerServer ?? 0;
    expect(cap).toBeGreaterThan(0);
    for (let i = 1; i < cap; i++) {
      await pool.getSession(`user-${i}`, params.uuid, forwarded);
    }
    const count = mocks.connect.mock.calls.length;
    expect(
      await pool.getSession("bob", params.uuid, {
        ...forwarded,
        headers: { "x-user": "bob" },
      }),
    ).toBeUndefined();
    expect(await pool.getSession("alice", params.uuid, forwarded)).toBe(alice);
    expect(mocks.connect).toHaveBeenCalledTimes(count);
    expect(pool.getSessionConnections("bob")?.[params.uuid]).toBeUndefined();
  });

  it("preserves static at-cap reuse and cleans a shared connection only once", async () => {
    const oldest = await pool.getSession("oldest", params.uuid, params);
    const cap = pool.getPoolStatus().maxConnectionsPerServer ?? 0;
    expect(cap).toBeGreaterThan(0);
    for (let i = 1; i < cap; i++) {
      vi.advanceTimersByTime(1);
      await pool.getSession(`session-${i}`, params.uuid, params);
      await flush();
    }
    const count = mocks.connect.mock.calls.length;
    expect(await pool.getSession("at-cap", params.uuid, params)).toBe(oldest);
    expect(mocks.connect).toHaveBeenCalledTimes(count);
    const first = pool.invalidateServerConfiguration(params.uuid);
    const second = pool.invalidateServerConfiguration(params.uuid);
    await Promise.all([first, second]);
    expect(oldest?.cleanup).toHaveBeenCalledTimes(1);
    expect(pool.getPoolStatus().active).toBe(0);
    expect(pool.getPoolStatus().idle).toBe(0);
  });
});
