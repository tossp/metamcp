import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogRecord } from "../../db/repositories/tool-catalog.repo";
import { assertNoCatalogSelfReference } from "./tool-catalog-self-reference";
import { createToolCatalogService } from "./tool-catalog-service";

const defaults = vi.hoisted(() => ({ findByNamespace: vi.fn() }));
vi.mock("../../db/repositories/tool-catalog.repo", () => ({
  toolCatalogRepository: defaults,
}));
vi.mock("@/utils/logger", () => ({ default: { debug: vi.fn() } }));

const SOURCE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const LOCAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SAFE_ERROR = "Tool catalog self-reference check failed";
const tool = (name: string): Tool => ({
  name,
  inputSchema: { type: "object" },
});
const record = (uuid: string): CatalogRecord => ({
  source: {
    uuid,
    name: "user-chosen-label",
    forward_headers: null,
    user_id: null,
    revision: 1,
    refreshedAt: new Date(0),
  },
  tools: [tool("saved")],
});

async function upstream(
  name: string,
  list: () => Tool[] = () => [tool("remote")],
) {
  const server = new Server(
    { name, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const requested = vi.fn(async () => ({ tools: list() }));
  server.setRequestHandler(ListToolsRequestSchema, requested);
  const client = new Client({ name: "synthetic-refresh", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    requested,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

function catalogFixture(members: Array<{ uuid: string; active: boolean }>) {
  const current = record(SOURCE);
  const repository = {
    findByNamespace: vi.fn(
      async (namespace: string, includeInactive = false) => {
        if (namespace === LOCAL) return [structuredClone(current)];
        if (namespace !== TARGET) return [];
        return members
          .filter((member) => includeInactive || member.active)
          .map((member) =>
            member.uuid === SOURCE
              ? structuredClone(current)
              : record(member.uuid),
          );
      },
    ),
    findByServerUuid: vi.fn(async (uuid: string) =>
      uuid === SOURCE ? structuredClone(current) : undefined,
    ),
    publish: vi.fn(async (_uuid: string, _revision: number, tools: Tool[]) => {
      current.tools = structuredClone(tools);
      current.source.refreshedAt = new Date();
      return true;
    }),
  };
  const notify = vi.fn();
  const serviceFor = (client: Client) =>
    createToolCatalogService({
      repository,
      notify,
      fetchTools: async (source) => {
        await assertNoCatalogSelfReference(source.uuid, client, repository);
        return (await client.listTools()).tools;
      },
    });
  return { current, repository, notify, serviceFor };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("catalog direct self-reference guard", () => {
  it("uses real handshake identity and rejects repeated discovery without growing/publishing tools", async () => {
    const fixture = catalogFixture([{ uuid: SOURCE, active: true }]);
    // Were discovery allowed, each round would aggregate the previously saved
    // directory under another prefix and grow it. No fake getServerVersion here.
    const remote = await upstream(`metamcp-unified-${TARGET}`, () => [
      ...fixture.current.tools,
      ...fixture.current.tools.map((entry) => ({
        ...entry,
        name: `self__${entry.name}`,
      })),
    ]);
    try {
      expect(remote.client.getServerVersion()).toEqual({
        name: `metamcp-unified-${TARGET}`,
        version: "1.0.0",
      });
      const service = fixture.serviceFor(remote.client);
      for (let round = 0; round < 5; round++) {
        expect(await service.refreshCatalogTools(SOURCE)).toEqual({
          serverUuid: SOURCE,
          success: false,
          count: 0,
          error: "Tool catalog refresh failed",
        });
        expect(
          await service.listCatalogTools(LOCAL, { refresh: false }),
        ).toEqual([
          {
            serverUuid: SOURCE,
            serverName: "user-chosen-label",
            revision: 1,
            tool: tool("saved"),
          },
        ]);
      }
      expect(remote.requested).not.toHaveBeenCalled();
      expect(fixture.repository.publish).not.toHaveBeenCalled();
      expect(fixture.notify).not.toHaveBeenCalled();
      expect(fixture.current.tools).toEqual([tool("saved")]);
      expect(
        fixture.repository.findByNamespace.mock.calls.filter(
          ([namespace]) => namespace === TARGET,
        ),
      ).toEqual(Array.from({ length: 5 }, () => [TARGET, false]));
    } finally {
      await remote.cleanup();
    }
  });

  it("allows cross-namespace aggregation when active members do not contain this source", async () => {
    const fixture = catalogFixture([{ uuid: OTHER, active: true }]);
    const remote = await upstream(`metamcp-unified-${TARGET}`);
    try {
      expect(
        await fixture.serviceFor(remote.client).refreshCatalogTools(SOURCE),
      ).toEqual({ serverUuid: SOURCE, success: true, count: 1 });
      expect(
        fixture.repository.findByNamespace,
      ).toHaveBeenCalledExactlyOnceWith(TARGET, false);
      expect(fixture.repository.publish).toHaveBeenCalledExactlyOnceWith(
        SOURCE,
        1,
        [tool("remote")],
      );
      expect(remote.requested).toHaveBeenCalledTimes(1);
    } finally {
      await remote.cleanup();
    }
  });

  it("does not treat inactive membership as self-reference", async () => {
    const fixture = catalogFixture([
      { uuid: SOURCE, active: false },
      { uuid: OTHER, active: true },
    ]);
    const remote = await upstream(`metamcp-unified-${TARGET}`);
    try {
      expect(
        await fixture.serviceFor(remote.client).refreshCatalogTools(SOURCE),
      ).toEqual({ serverUuid: SOURCE, success: true, count: 1 });
      expect(
        fixture.repository.findByNamespace,
      ).toHaveBeenCalledExactlyOnceWith(TARGET, false);
      expect(fixture.repository.publish).toHaveBeenCalledTimes(1);
      expect(remote.requested).toHaveBeenCalledTimes(1);
    } finally {
      await remote.cleanup();
    }
  });

  it.each([
    "other-project",
    "metamcp-unified-not-a-uuid",
    `metamcp-unified-${TARGET}-suffix`,
  ])(
    "allows unrelated remote identity %s without any membership lookup",
    async (name) => {
      const fixture = catalogFixture([{ uuid: SOURCE, active: true }]);
      // Even a saved display name matching MetaMCP is not handshake evidence.
      fixture.current.source.name = `metamcp-unified-${TARGET}`;
      const remote = await upstream(name);
      try {
        expect(
          (await fixture.serviceFor(remote.client).refreshCatalogTools(SOURCE))
            .success,
        ).toBe(true);
        expect(fixture.repository.findByNamespace).not.toHaveBeenCalled();
        expect(fixture.repository.publish).toHaveBeenCalledTimes(1);
        expect(remote.requested).toHaveBeenCalledTimes(1);
      } finally {
        await remote.cleanup();
      }
    },
  );

  it("fails closed on membership query errors without exposing error/cause or publishing", async () => {
    const fixture = catalogFixture([]);
    fixture.repository.findByNamespace.mockRejectedValue(
      new Error("postgres://fake:FAKE-PASSWORD@invalid/db"),
    );
    const remote = await upstream(`metamcp-unified-${TARGET}`);
    try {
      await expect(
        assertNoCatalogSelfReference(SOURCE, remote.client, fixture.repository),
      ).rejects.toEqual(new Error(SAFE_ERROR));
      expect(
        await fixture.serviceFor(remote.client).refreshCatalogTools(SOURCE),
      ).toEqual({
        serverUuid: SOURCE,
        success: false,
        count: 0,
        error: "Tool catalog refresh failed",
      });
      expect(fixture.repository.publish).not.toHaveBeenCalled();
      expect(remote.requested).not.toHaveBeenCalled();
      expect(fixture.current.tools).toEqual([tool("saved")]);
    } finally {
      await remote.cleanup();
    }
  });

  it("defaults to the catalog repository and normalizes canonical UUID casing", async () => {
    defaults.findByNamespace.mockResolvedValue([record(SOURCE)]);
    const remote = await upstream(`metamcp-unified-${TARGET.toUpperCase()}`);
    try {
      await expect(
        assertNoCatalogSelfReference(SOURCE, remote.client),
      ).rejects.toEqual(new Error(SAFE_ERROR));
      expect(defaults.findByNamespace).toHaveBeenCalledExactlyOnceWith(
        TARGET,
        false,
      );
    } finally {
      await remote.cleanup();
    }
  });

  it("rechecks active membership each refresh rather than caching an old safe decision", async () => {
    const members = [{ uuid: SOURCE, active: false }];
    const fixture = catalogFixture(members);
    const remote = await upstream(`metamcp-unified-${TARGET}`);
    try {
      const service = fixture.serviceFor(remote.client);
      expect((await service.refreshCatalogTools(SOURCE)).success).toBe(true);
      members[0].active = true;
      expect((await service.refreshCatalogTools(SOURCE)).success).toBe(false);
      expect(fixture.repository.findByNamespace).toHaveBeenCalledTimes(2);
      expect(fixture.repository.publish).toHaveBeenCalledTimes(1);
      expect(remote.requested).toHaveBeenCalledTimes(1);
    } finally {
      await remote.cleanup();
    }
  });
});
