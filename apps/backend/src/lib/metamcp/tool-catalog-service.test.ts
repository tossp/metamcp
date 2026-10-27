import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import type { CatalogRecord } from "../../db/repositories/tool-catalog.repo";
import { createToolCatalogService } from "./tool-catalog-service";

vi.mock("@/utils/logger", () => ({ default: { debug: vi.fn() } }));

const tool = (name = "one"): Tool => ({
  name,
  inputSchema: { type: "object" },
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const record = (uuid = "server"): CatalogRecord => ({
  source: {
    uuid,
    name: uuid,
    forward_headers: null,
    user_id: null,
    revision: 1,
    refreshedAt: new Date(0),
  },
  tools: [tool()],
});
function harness(initial = [record()]) {
  let time = 1_000_000;
  const rows = new Map(
    initial.map((row) => [row.source.uuid, structuredClone(row)]),
  );
  const queue: (() => void)[] = [];
  const repository = {
    findByNamespace: vi.fn(async () => structuredClone([...rows.values()])),
    findByServerUuid: vi.fn(async (uuid: string) =>
      structuredClone(rows.get(uuid)),
    ),
    publish: vi.fn(async (uuid: string, revision: number, tools: Tool[]) => {
      const row = rows.get(uuid);
      if (!row || row.source.revision !== revision) return false;
      row.tools = structuredClone(tools);
      row.source.refreshedAt = new Date(time);
      return true;
    }),
  };
  const fetchTools = vi.fn(async () => [tool("new")]);
  const notify = vi.fn();
  const service = createToolCatalogService({
    repository,
    fetchTools,
    notify,
    now: () => time,
    defer: (task) => {
      queue.push(task);
    },
  });
  return {
    ...service,
    rows,
    repository,
    fetchTools,
    notify,
    queue,
    advance: (ms: number) => {
      time += ms;
    },
    run: async () => {
      queue.splice(0).forEach((task) => task());
      await Promise.resolve();
    },
  };
}

describe("tool catalog SWR", () => {
  it("returns stale/missing and healthy sources without awaiting slow upstream; deduplicates", async () => {
    const missing = record("missing");
    missing.tools = [];
    missing.source.refreshedAt = null;
    const h = harness([record(), missing]);
    const gate = deferred<Tool[]>();
    h.fetchTools.mockReturnValue(gate.promise);
    const listed = await h.listCatalogTools("ns");
    expect(listed).toEqual([
      { serverUuid: "server", serverName: "server", revision: 1, tool: tool() },
    ]);
    expect(h.fetchTools).not.toHaveBeenCalled();
    await h.listCatalogTools("ns");
    expect(h.queue).toHaveLength(2);
    await h.run();
    expect(h.fetchTools).toHaveBeenCalledTimes(2);
    expect(await h.listCatalogTools("ns")).toEqual(listed);
    const a = h.refreshCatalogTools("server");
    const b = h.refreshCatalogTools("server");
    gate.resolve([tool("done")]);
    expect((await a).success).toBe(true);
    expect((await b).success).toBe(true);
    expect(h.fetchTools).toHaveBeenCalledTimes(2);
  });

  it("fresh directories do not refresh; refresh:false suppresses all lazy work", async () => {
    const row = record();
    row.source.refreshedAt = new Date(1_000_000);
    const h = harness([row]);
    await h.listCatalogTools("ns");
    expect(h.queue).toHaveLength(0);
    h.advance(600_000);
    await h.listCatalogTools("ns", { refresh: false, includeInactive: true });
    expect(h.repository.findByNamespace).toHaveBeenLastCalledWith("ns", true);
    expect(h.queue).toHaveLength(0);
    await h.listCatalogTools("ns");
    expect(h.queue).toHaveLength(1);
    expect(h.fetchTools).not.toHaveBeenCalled();
  });

  it("preserves old tools on failure, applies 30s backoff and returns a fixed safe error", async () => {
    const h = harness();
    h.fetchTools.mockRejectedValue(
      new Error("Bearer FAKE-SECRET url?token=FAKE"),
    );
    await h.listCatalogTools("ns");
    await h.run();
    const failed = await h.refreshCatalogTools("server");
    expect(failed).toEqual({
      serverUuid: "server",
      success: false,
      count: 0,
      error: "Tool catalog refresh failed",
    });
    expect((await h.listCatalogTools("ns"))[0]?.tool).toEqual(tool());
    expect(h.queue).toHaveLength(0);
    h.advance(29_999);
    await h.listCatalogTools("ns");
    expect(h.queue).toHaveLength(0);
    h.advance(1);
    await h.listCatalogTools("ns");
    expect(h.queue).toHaveLength(1);
    h.fetchTools.mockResolvedValue([tool("recovered")]);
    expect((await h.refreshCatalogTools("server")).success).toBe(true);
    await h.run();
    expect(h.fetchTools).toHaveBeenCalledTimes(2);
    expect(h.repository.publish).toHaveBeenCalledTimes(1);
  });

  it("manual refresh bypasses backoff; successful empty replaces the snapshot", async () => {
    const h = harness();
    h.fetchTools.mockRejectedValueOnce(new Error("FAKE"));
    expect((await h.refreshCatalogTools("server")).success).toBe(false);
    h.fetchTools.mockResolvedValue([]);
    expect(await h.refreshCatalogTools("server")).toEqual({
      serverUuid: "server",
      success: true,
      count: 0,
    });
    expect(await h.listCatalogTools("ns")).toEqual([]);
    expect(h.queue).toHaveLength(0);
    expect(h.notify).toHaveBeenCalledTimes(1);
    await h.refreshCatalogTools("server");
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("compares all SDK fields and ignores JSON key/tool order", async () => {
    const h = harness();
    const updated: Tool = {
      ...tool(),
      description: "updated",
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
      _meta: { custom: "value" },
    };
    h.fetchTools.mockResolvedValue([updated, tool("two")]);
    await h.refreshCatalogTools("server");
    expect(h.notify).toHaveBeenCalledTimes(1);
    h.fetchTools.mockResolvedValue([
      tool("two"),
      { ...updated, inputSchema: { type: "object" } },
    ]);
    await h.refreshCatalogTools("server");
    expect(h.notify).toHaveBeenCalledTimes(1);
    h.fetchTools.mockResolvedValue([
      {
        ...updated,
        inputSchema: { type: "object", properties: { x: { type: "string" } } },
      },
    ]);
    await h.refreshCatalogTools("server");
    expect(h.notify).toHaveBeenCalledTimes(2);
    expect(h.repository.publish).toHaveBeenCalledTimes(3);
  });

  it("isolates nonempty identities, while absent effective values use the static-credential DB baseline", async () => {
    const row = record();
    row.source.forward_headers = { "x-key": "Authorization", cookie: "Cookie" };
    row.tools = [tool("private-DB-must-not-leak")];
    const h = harness([row]);
    expect(
      (await h.listCatalogTools("ns", { refresh: false }))[0]?.tool.name,
    ).toBe("private-DB-must-not-leak");
    const a = { "X-Key": "fake-A", cookie: "ignored", extra: "ignored" };
    expect(
      (await h.refreshCatalogTools("server", { headers: a })).success,
    ).toBe(true);
    expect(h.fetchTools).toHaveBeenLastCalledWith(row.source, {
      Authorization: "fake-A",
    });
    expect(h.repository.publish).not.toHaveBeenCalled();
    expect(
      await h.listCatalogTools("ns", {
        headers: { "x-key": "fake-A" },
        refresh: false,
      }),
    ).toHaveLength(1);
    expect(
      await h.listCatalogTools("ns", {
        headers: { "x-key": "fake-B" },
        refresh: false,
      }),
    ).toEqual([]);
    expect(
      (await h.listCatalogTools("ns", { refresh: false }))[0]?.tool.name,
    ).toBe("private-DB-must-not-leak");
    h.fetchTools.mockResolvedValue([tool("anonymous")]);
    await h.refreshCatalogTools("server");
    expect(
      (await h.listCatalogTools("ns", { refresh: false }))[0]?.tool.name,
    ).toBe("anonymous");
    expect(h.repository.publish).toHaveBeenCalledExactlyOnceWith("server", 1, [
      tool("anonymous"),
    ]);
    expect(
      (await h.listCatalogTools("ns", { headers: a, refresh: false }))[0]?.tool
        .name,
    ).toBe("new");
    const current = h.rows.get("server");
    if (!current) throw new Error("Missing test fixture");
    current.source.revision++;
    expect(
      await h.listCatalogTools("ns", { headers: a, refresh: false }),
    ).toEqual([]);
  });

  it("deduplicates only identical effective identities, not different users", async () => {
    const row = record();
    row.source.forward_headers = { "x-key": "X-Key" };
    const h = harness([row]);
    const gate = deferred<Tool[]>();
    h.fetchTools.mockReturnValue(gate.promise);
    const a = h.refreshCatalogTools("server", {
      headers: { "x-key": "fake-a" },
      sessionId: "a",
    });
    const b = h.refreshCatalogTools("server", {
      headers: { "x-key": "fake-a", ignored: "other" },
      sessionId: "b",
    });
    const c = h.refreshCatalogTools("server", {
      headers: { "x-key": "fake-b" },
      sessionId: "a",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.fetchTools).toHaveBeenCalledTimes(2);
    gate.resolve([]);
    await Promise.all([a, b, c]);
  });

  it.each([false, true])(
    "fences configuration changes and deletion (isolated=%s)",
    async (isolate) => {
      for (const deleted of [false, true]) {
        const row = record();
        if (isolate) row.source.forward_headers = { "x-key": "X-Key" };
        const h = harness([row]);
        const gate = deferred<Tool[]>();
        h.fetchTools.mockReturnValue(gate.promise);
        const headers = isolate ? { "x-key": "fake-private" } : undefined;
        const pending = h.refreshCatalogTools("server", { headers });
        await Promise.resolve();
        await Promise.resolve();
        if (deleted) h.rows.delete("server");
        else {
          const current = h.rows.get("server");
          if (!current) throw new Error("Missing test fixture");
          current.source.revision++;
          current.tools = [];
        }
        gate.resolve([tool("stale-result")]);
        expect((await pending).success).toBe(false);
        expect(h.repository.publish).not.toHaveBeenCalled();
        expect(h.notify).not.toHaveBeenCalled();
        expect(
          await h.listCatalogTools("ns", { refresh: false, headers }),
        ).toEqual([]);
      }
    },
  );

  it("does not notify when transactional revision CAS rejects publication", async () => {
    const h = harness();
    h.repository.publish.mockResolvedValue(false);
    expect((await h.refreshCatalogTools("server")).success).toBe(false);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("bounds identity cache at 512 entries and never falls back to shared DB after eviction", async () => {
    const row = record();
    row.source.forward_headers = { "x-key": "X-Key" };
    const h = harness([row]);
    for (let i = 0; i < 513; i++) {
      await h.refreshCatalogTools("server", {
        headers: { "x-key": `fake-${i}` },
      });
    }
    expect(
      await h.listCatalogTools("ns", {
        headers: { "x-key": "fake-0" },
        refresh: false,
      }),
    ).toEqual([]);
    expect(
      await h.listCatalogTools("ns", {
        headers: { "x-key": "fake-512" },
        refresh: false,
      }),
    ).toHaveLength(1);
    expect(h.repository.publish).not.toHaveBeenCalled();
  });

  it("does not allow returned tool mutation to corrupt an identity snapshot", async () => {
    const row = record();
    row.source.forward_headers = { "x-key": "X-Key" };
    const h = harness([row]);
    const headers = { "x-key": "fake-private" };
    await h.refreshCatalogTools("server", { headers });
    const list = await h.listCatalogTools("ns", { headers });
    if (!list[0]) throw new Error("Missing test catalog");
    list[0].tool.name = "mutated";
    expect((await h.listCatalogTools("ns", { headers }))[0]?.tool.name).toBe(
      "new",
    );
  });
});
