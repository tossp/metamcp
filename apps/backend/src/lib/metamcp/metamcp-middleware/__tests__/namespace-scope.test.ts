import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
// Real Drizzle SQL generation, fake pg client only: no Pool, config or DB access.
vi.mock("../../../../db/index", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  return { db: drizzle({ query } as never) };
});
vi.mock("@/utils/logger", () => ({ default: { error: vi.fn() } }));

import {
  createFilterCallToolMiddleware,
  createFilterListToolsMiddleware,
} from "../filter-tools.functional";
import type { MetaMCPHandlerContext } from "../functional-middleware";
import { resolveToolIdentity } from "../tool-identity";
import {
  createToolOverridesCallToolMiddleware,
  createToolOverridesListToolsMiddleware,
  mapOverrideNameToOriginal,
} from "../tool-overrides.functional";

type Server = { uuid: string; name: string; namespace: string; status: string };
type Mapping = {
  namespace: string;
  server: string;
  name: string;
  alias: string | null;
  status: string;
};
const servers: Server[] = [];
const mappings: Mapping[] = [];
const tool = (name: string): Tool => ({
  name,
  inputSchema: { type: "object" },
});
const context = (namespaceUuid = "ns-a"): MetaMCPHandlerContext => ({
  namespaceUuid,
  sessionId: "same-session",
  endpointName: "synthetic",
});
const request = (name: string) => ({
  method: "tools/call" as const,
  params: { name },
});
const listRequest = { method: "tools/list" as const };
function server(
  uuid = "a",
  name = "shared",
  namespace = "ns-a",
  status = "ACTIVE",
) {
  servers.push({ uuid, name, namespace, status });
}
function mapping(
  serverUuid = "a",
  name = "raw",
  alias: string | null = "alias",
  namespace = "ns-a",
  status = "ACTIVE",
) {
  mappings.push({ namespace, server: serverUuid, name, alias, status });
}
function installDriver() {
  query.mockImplementation(
    async (config: { text: string }, params: unknown[]) => {
      const sql = config.text;
      expect(sql.startsWith("select ")).toBe(true);
      for (const secret of [
        "env",
        "headers",
        "bearer_token",
        "url",
        "command",
        "args",
      ]) {
        expect(sql).not.toContain(`"mcp_servers"."${secret}"`);
      }
      // Assert scoping predicates rather than allowing fixtures to mask missing WHERE clauses.
      if (sql.includes("left join")) {
        expect(sql).toContain(
          'where "namespace_server_mappings"."namespace_uuid" = $1',
        );
        expect(sql).toContain(
          '"namespace_tool_mappings"."namespace_uuid" = "namespace_server_mappings"."namespace_uuid"',
        );
        return {
          rows: servers
            .filter((s) => s.namespace === params[0])
            .flatMap((s) => {
              const rows = mappings.filter(
                (m) => m.namespace === s.namespace && m.server === s.uuid,
              );
              return rows.length
                ? rows.map((m) => [
                    s.uuid,
                    s.name,
                    s.status,
                    m.name,
                    m.status,
                    m.alias,
                    null,
                    null,
                    null,
                  ])
                : [
                    [
                      s.uuid,
                      s.name,
                      s.status,
                      null,
                      null,
                      null,
                      null,
                      null,
                      null,
                    ],
                  ];
            }),
        };
      }
      if (sql.includes('from "mcp_servers"')) {
        expect(sql).toContain('inner join "namespace_server_mappings"');
        expect(sql).toContain(
          '"namespace_server_mappings"."namespace_uuid" = $1',
        );
        expect(sql).not.toContain('"mcp_servers"."name" =');
        expect(sql).not.toContain(" limit ");
        expect(params).toHaveLength(1);
        return {
          rows: servers
            .filter((s) => s.namespace === params[0])
            .map((s) => [s.uuid, s.name, s.status]),
        };
      }
      expect(sql).toContain('"namespace_tool_mappings"."namespace_uuid" = $1');
      if (sql.includes('"namespace_tool_mappings"."override_name" =')) {
        expect(sql).toContain('"mcp_servers"."uuid" = $3');
        return {
          rows: mappings
            .filter(
              (m) =>
                m.namespace === params[0] &&
                m.alias === params[1] &&
                m.server === params[2],
            )
            .map((m) => [
              m.name,
              servers.find((s) => s.uuid === m.server)?.name,
            ]),
        };
      }
      expect(sql).toContain('"namespace_tool_mappings"."mcp_server_uuid" = $3');
      return {
        rows: mappings
          .filter(
            (m) =>
              m.namespace === params[0] &&
              m.name === params[1] &&
              m.server === params[2],
          )
          .map((m) => [m.status]),
      };
    },
  );
}
async function list(names: string[], namespace = "ns-a", overrides = false) {
  const handler = async () => ({ tools: names.map(tool) });
  const middleware = overrides
    ? createToolOverridesListToolsMiddleware({
        cacheEnabled: true,
        persistentCacheOnListTools: true,
      })
    : createFilterListToolsMiddleware({ cacheEnabled: true });
  return middleware(handler)(listRequest, context(namespace));
}

beforeEach(() => {
  servers.length = 0;
  mappings.length = 0;
  query.mockReset();
  installDriver();
});

describe("namespace scoped tool middleware", () => {
  it.each([
    ["shared", "shared"],
    ["Alpha Bridge", "AlphaBridge"],
  ])(
    "isolates raw server %s using public prefix %s across namespaces",
    async (rawName, prefix) => {
      // Foreign row comes first: a global-name lookup would select it incorrectly.
      server("b", rawName, "ns-b");
      server("a", rawName);
      mapping("b", "raw", "foreign", "ns-b", "INACTIVE");
      mapping();
      expect((await list([`${prefix}__raw`], "ns-a")).tools).toHaveLength(1);
      expect((await list([`${prefix}__raw`], "ns-b")).tools).toEqual([]);
      expect(
        (await list([`${prefix}__raw`], "ns-a", true)).tools[0]?.name,
      ).toBe(`${prefix}__alias`);
      expect(
        (await list([`${prefix}__raw`], "ns-b", true)).tools[0]?.name,
      ).toBe(`${prefix}__foreign`);
      expect(await resolveToolIdentity(`${prefix}__raw`, "ns-a")).toEqual({
        mcpServerUuid: "a",
        mcpServerName: prefix,
      });
      expect(await resolveToolIdentity(`${prefix}__raw`, "ns-b")).toEqual({
        mcpServerUuid: "b",
        mcpServerName: prefix,
      });
      expect(await resolveToolIdentity(`${prefix}__raw`)).toEqual({});
    },
  );

  it("does not mix the same alias suffix across servers or namespaces, even after list", async () => {
    server("a", "first");
    server("b", "second");
    server("c", "first", "ns-b");
    mapping("a", "one");
    mapping("b", "two");
    mapping("c", "three", "alias", "ns-b");
    await list(["first__one", "second__two"], "ns-a", true);
    expect(await mapOverrideNameToOriginal("first__alias", "ns-a", true)).toBe(
      "first__one",
    );
    expect(await mapOverrideNameToOriginal("second__alias", "ns-a", true)).toBe(
      "second__two",
    );
    expect(await mapOverrideNameToOriginal("first__alias", "ns-b", true)).toBe(
      "first__three",
    );
  });

  it.each([
    ["shared", "shared", "shared", "ACTIVE"],
    ["shared", "shared", "shared", "INACTIVE"],
    ["a.b", "ab", "ab", "ACTIVE"],
    ["a.b", "ab", "ab", "INACTIVE"],
  ])(
    "rejects namespace prefix collisions between %s and %s (%s, %s)",
    async (first, second, prefix, status) => {
      server("a", first);
      server("b", second, "ns-a", status);
      mapping();
      mapping("b", "raw", "foreign");
      expect((await list([`${prefix}__raw`])).tools).toEqual([]);
      expect((await list([`${prefix}__raw`], "ns-a", true)).tools).toEqual([]);
      await expect(
        resolveToolIdentity(`${prefix}__raw`, "ns-a"),
      ).rejects.toThrow("Ambiguous");
      await expect(
        mapOverrideNameToOriginal(`${prefix}__alias`, "ns-a"),
      ).rejects.toThrow("Ambiguous");
      const upstream = vi.fn(async () => ({ content: [] }));
      expect(
        (
          await createFilterCallToolMiddleware()(upstream)(
            request(`${prefix}__raw`),
            context(),
          )
        ).isError,
      ).toBe(true);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("rejects ambiguous aliases instead of selecting the first mapping", async () => {
    server();
    mapping();
    mapping("a", "other", "alias");
    await list(["shared__raw", "shared__other"], "ns-a", true);
    await expect(
      mapOverrideNameToOriginal("shared__alias", "ns-a", true),
    ).rejects.toThrow("Ambiguous");
    const upstream = vi.fn(async () => ({ content: [] }));
    expect(
      (
        await createToolOverridesCallToolMiddleware()(upstream)(
          request("shared__alias"),
          context(),
        )
      ).isError,
    ).toBe(true);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("composes override before filter so a disabled tool cannot be called via alias", async () => {
    server();
    mapping("a", "raw", "alias", "ns-a", "INACTIVE");
    const upstream = vi.fn(async () => ({ content: [] }));
    const handler = createToolOverridesCallToolMiddleware()(
      createFilterCallToolMiddleware()(upstream),
    );
    expect((await handler(request("shared__alias"), context())).isError).toBe(
      true,
    );
    expect((await handler(request("shared__raw"), context())).isError).toBe(
      true,
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ["shared", "shared"],
    ["Alpha Bridge", "AlphaBridge"],
  ])(
    "routes raw and alias calls for %s via public prefix %s",
    async (rawName, prefix) => {
      server("noise-1", "unrelated1");
      server("noise-2", "unrelated2");
      server("b", rawName, "ns-b");
      server("a", rawName);
      mapping("b", "foreign", "alias", "ns-b", "INACTIVE");
      mapping();
      const upstream = vi.fn(async () => ({ content: [] }));
      const handler = createToolOverridesCallToolMiddleware()(
        createFilterCallToolMiddleware()(upstream),
      );
      await handler(request(`${prefix}__alias`), context());
      expect(upstream).toHaveBeenCalledExactlyOnceWith(
        request(`${prefix}__raw`),
        context(),
      );
      await handler(request(`${prefix}__raw`), context());
      expect(upstream).toHaveBeenNthCalledWith(
        2,
        request(`${prefix}__raw`),
        context(),
      );
      expect(
        (await handler(request(`${prefix}__alias`), context("ns-b"))).isError,
      ).toBe(true);
      expect(upstream).toHaveBeenCalledTimes(2);
    },
  );

  it("retains default-active for a missing tool mapping, but not missing/inactive membership", async () => {
    server();
    server("b", "disabled", "ns-a", "INACTIVE");
    const names = ["shared__new", "foreign__raw", "disabled__raw"];
    expect((await list(names)).tools.map((t) => t.name)).toEqual([
      "shared__new",
    ]);
    expect((await list(names, "ns-a", true)).tools.map((t) => t.name)).toEqual([
      "shared__new",
    ]);
    const upstream = vi.fn(async () => ({ content: [] }));
    const handler = createFilterCallToolMiddleware()(upstream);
    expect((await handler(request("foreign__raw"), context())).isError).toBe(
      true,
    );
    expect((await handler(request("disabled__raw"), context())).isError).toBe(
      true,
    );
    await handler(request("shared__new"), context());
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("reads fresh policies and membership for reused sessions despite legacy cache options", async () => {
    server();
    mapping();
    await list(["shared__raw"], "ns-a", true);
    expect(await mapOverrideNameToOriginal("shared__alias", "ns-a", true)).toBe(
      "shared__raw",
    );
    const current = mappings[0];
    if (!current) throw new Error("Missing synthetic mapping");
    current.status = "INACTIVE";
    current.alias = "renamed";
    expect((await list(["shared__raw"])).tools).toEqual([]);
    expect((await list(["shared__raw"], "ns-a", true)).tools[0]?.name).toBe(
      "shared__renamed",
    );
    expect(await mapOverrideNameToOriginal("shared__alias", "ns-a", true)).toBe(
      "shared__alias",
    );
    const upstream = vi.fn(async () => ({ content: [] }));
    expect(
      (
        await createFilterCallToolMiddleware({ cacheEnabled: true })(upstream)(
          request("shared__raw"),
          context(),
        )
      ).isError,
    ).toBe(true);
    servers.splice(0);
    expect((await list(["shared__raw"], "ns-a", true)).tools).toEqual([]);
    await expect(
      mapOverrideNameToOriginal("shared__renamed", "ns-a", true),
    ).rejects.toThrow("not active");
  });

  it("fails closed when either membership or tool policy queries fail", async () => {
    server();
    mapping();
    const upstream = vi.fn(async () => ({ content: [] }));
    query.mockRejectedValue(
      new Error("synthetic query failure: password=FAKE"),
    );
    for (const [overrides, message] of [
      [false, "Unable to load namespace tool permissions"],
      [true, "Unable to apply namespace tool overrides"],
    ] as const) {
      const failed = list(["shared__raw"], "ns-a", overrides);
      await expect(failed).rejects.toThrow(new Error(message));
      await expect(failed).rejects.not.toHaveProperty("cause");
    }
    // A successful inner filter must not hide a subsequent override query failure.
    query.mockResolvedValueOnce({
      rows: [
        ["a", "shared", "ACTIVE", "raw", "ACTIVE", "alias", null, null, null],
      ],
    });
    const combined = createToolOverridesListToolsMiddleware()(
      createFilterListToolsMiddleware()(async () => ({
        tools: [tool("shared__raw")],
      })),
    );
    await expect(combined(listRequest, context())).rejects.toThrow(
      new Error("Unable to apply namespace tool overrides"),
    );
    expect(
      (
        await createFilterCallToolMiddleware()(upstream)(
          request("shared__raw"),
          context(),
        )
      ).isError,
    ).toBe(true);
    expect(
      (
        await createToolOverridesCallToolMiddleware()(upstream)(
          request("shared__alias"),
          context(),
        )
      ).isError,
    ).toBe(true);
    // Membership succeeds, the subsequent status lookup fails.
    query.mockResolvedValueOnce({ rows: [["a", "shared", "ACTIVE"]] });
    expect(
      (
        await createFilterCallToolMiddleware()(upstream)(
          request("shared__raw"),
          context(),
        )
      ).isError,
    ).toBe(true);
    query.mockResolvedValueOnce({ rows: [["a", "shared", "ACTIVE"]] });
    expect(
      (
        await createToolOverridesCallToolMiddleware()(upstream)(
          request("shared__alias"),
          context(),
        )
      ).isError,
    ).toBe(true);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("uses one batch per nonempty middleware list independent of tool count", async () => {
    server("a", "s.h.a.r.e.d");
    const names = Array.from({ length: 300 }, (_, i) => `shared__tool${i}`);
    for (let i = 0; i < names.length; i++)
      mapping("a", `tool${i}`, `alias${i}`);
    const filtered = await list(names);
    expect(filtered.tools).toHaveLength(300);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockClear();
    const overridden = await list(names, "ns-a", true);
    expect(overridden.tools).toHaveLength(300);
    expect(overridden.tools[299]?.name).toBe("shared__alias299");
    expect(query).toHaveBeenCalledTimes(1);
    query.mockClear();
    const combined = createToolOverridesListToolsMiddleware()(
      createFilterListToolsMiddleware()(async () => ({
        tools: names.map(tool),
      })),
    );
    expect((await combined(listRequest, context())).tools).toHaveLength(300);
    expect(query).toHaveBeenCalledTimes(2);
    query.mockClear();
    await list([]);
    await list([], "ns-a", true);
    expect(query).not.toHaveBeenCalled();
  });
});
