import type { ServerParameters } from "@repo/zod-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real repository SQL, OAuth renewal helper, SDK Client/Server handshake, pool,
// revision fence and catalog adapter. Only pg's query boundary, token HTTP and
// the HTTP transport are synthetic. Never load env files or open a DB/socket.
const h = vi.hoisted(() => ({
  query: vi.fn(),
  refreshToken: vi.fn(),
  attempts: [] as string[],
  handshakes: [] as string[],
  discoveries: [] as string[],
  links: [] as Array<{
    token: string;
    closed: boolean;
    close: () => Promise<void>;
  }>,
}));
vi.mock("../../db/index", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  return { db: drizzle({ query: h.query } as never) };
});
vi.mock("@/utils/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../config.service", () => ({ configService: {} }));
vi.mock("./log-store", () => ({ metamcpLogStore: { addLog: vi.fn() } }));
vi.mock("./server-error-tracker", () => ({
  serverErrorTracker: {
    getServerMaxAttempts: async () => 1,
    isServerInErrorState: async () => false,
    resetServerErrorState: async () => {},
  },
}));
vi.mock("../stdio-transport/process-managed-transport", () => ({
  ProcessManagedStdioTransport: class {},
}));
vi.mock("../oauth-upstream/token-exchange", () => ({
  discoverAuthorizationServerMetadata: async () => ({}),
  resolveTokenEndpoint: () => "https://synthetic.invalid/token",
  resolveTokenEndpointAuthMethod: () => "none",
  refreshAccessToken: h.refreshToken,
  redactToken: () => "[synthetic-redacted]",
  isUpstreamUnauthorizedError: (error: unknown) =>
    error instanceof Error && error.message === "Synthetic upstream 401",
  UpstreamTokenError: class extends Error {},
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", async () => {
  const { InMemoryTransport } =
    await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { ListToolsRequestSchema } =
    await import("@modelcontextprotocol/sdk/types.js");
  type Transport =
    import("@modelcontextprotocol/sdk/shared/transport.js").Transport;
  class SyntheticHttpTransport implements Transport {
    private pair = InMemoryTransport.createLinkedPair();
    private upstream = new Server(
      { name: "synthetic-oauth-upstream", version: "1" },
      { capabilities: { tools: {} } },
    );
    private link: (typeof h.links)[number];

    constructor(_url: URL, options: { requestInit?: RequestInit }) {
      const token =
        new Headers(options.requestInit?.headers).get("authorization") ?? "";
      this.link = { token, closed: false, close: () => this.close() };
      h.links.push(this.link);
      this.upstream.setRequestHandler(ListToolsRequestSchema, async () => {
        h.discoveries.push(token);
        return {
          tools: [
            {
              name: "read",
              description: "Fresh synthetic directory",
              inputSchema: { type: "object" as const },
            },
          ],
        };
      });
    }

    get onmessage() {
      return this.pair[0].onmessage;
    }
    set onmessage(value: Transport["onmessage"]) {
      this.pair[0].onmessage = value;
    }
    get onerror() {
      return this.pair[0].onerror;
    }
    set onerror(value: Transport["onerror"]) {
      this.pair[0].onerror = value;
    }
    get onclose() {
      return this.pair[0].onclose;
    }
    set onclose(value: Transport["onclose"]) {
      this.pair[0].onclose = value;
    }

    async start() {
      h.attempts.push(this.link.token);
      if (this.link.token === "Bearer synthetic-expired") {
        throw new Error("Synthetic upstream 401");
      }
      await this.upstream.connect(this.pair[1]);
      await this.pair[0].start();
    }

    async send(...args: Parameters<Transport["send"]>) {
      const [message] = args;
      if ("method" in message && message.method === "initialize") {
        h.handshakes.push(this.link.token);
      }
      await this.pair[0].send(...args);
    }

    async close() {
      if (this.link.closed) return;
      this.link.closed = true;
      await this.pair[0].close();
      await this.upstream.close();
    }
  }
  return { StreamableHTTPClientTransport: SyntheticHttpTransport };
});

const SERVER = "00000000-0000-4000-8000-000000000039";
const NS = "00000000-0000-4000-8000-000000000040";
const OWNER = "synthetic-owner";
const stamp = "2026-10-27T00:00:00.000Z";
type Tokens = {
  access_token: string;
  token_type: string;
  refresh_token: string;
  scope?: string;
};
const renewed = (scope?: string): Tokens => ({
  access_token: "synthetic-fresh",
  refresh_token: "synthetic-rotated",
  token_type: "Bearer",
  ...(scope === undefined ? {} : { scope }),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function databaseFixture() {
  const server: Record<string, unknown> = {
    uuid: SERVER,
    name: "synthetic",
    description: "Synthetic only",
    type: "STREAMABLE_HTTP",
    url: "https://synthetic.invalid/mcp",
    user_id: OWNER,
    created_at: stamp,
    error_status: "NONE",
    command: null,
    args: [],
    env: {},
    headers: {},
    forward_headers: {},
    bearer_token: null,
    tool_catalog_revision: 7,
    tool_catalog_refreshed_at: stamp,
  };
  const oauth: Record<string, unknown> = {
    uuid: "00000000-0000-4000-8000-000000000041",
    mcp_server_uuid: SERVER,
    owner_user_id: OWNER,
    client_information: { client_id: "synthetic-client" },
    tokens: {
      access_token: "synthetic-expired",
      refresh_token: "synthetic-grant",
      token_type: "Bearer",
      scope: "read calendar",
    } satisfies Tokens,
    code_verifier: null,
    expected_state: null,
    expected_state_expires_at: null,
    created_at: stamp,
    updated_at: stamp,
  };
  let tools: Array<Record<string, unknown>> = [
    {
      uuid: "00000000-0000-4000-8000-000000000042",
      mcp_server_uuid: SERVER,
      name: "read",
      description: "Last successful directory",
      tool_schema: { type: "object" },
      definition: {
        name: "read",
        description: "Last successful directory",
        inputSchema: { type: "object" },
      },
      catalog_revision: 7,
      created_at: stamp,
      updated_at: stamp,
    },
  ];
  const publications: number[] = [];
  const oauthWrites: Tokens[] = [];
  const queries: string[] = [];

  // Model only the statements used by these actual repositories. Unknown SQL
  // fails the test. Other SQL-shape/permission tests live with the repositories.
  const projected = (text: string, tool?: Record<string, unknown>) => {
    const from = /from "([^"]+)"/.exec(text)?.[1];
    const projection = text.slice("select ".length, text.indexOf(" from "));
    return [...projection.matchAll(/(?:"([^"]+)"\.)?"([^"]+)"/g)].map(
      ([, table, column]) => {
        const rows: Record<string, Record<string, unknown> | undefined> = {
          mcp_servers: server,
          oauth_sessions: oauth,
          tools: tool,
        };
        return rows[table ?? from ?? ""]?.[column] ?? null;
      },
    );
  };
  h.query.mockImplementation(
    async (config: { text: string }, parameters: unknown[] = []) => {
      const text = config.text;
      queries.push(text);
      if (["begin", "commit", "rollback"].includes(text)) return { rows: [] };
      if (text.startsWith("select ")) {
        if (text.includes('left join "tools"')) {
          const current = tools.filter(
            (tool) => tool.catalog_revision === server.tool_catalog_revision,
          );
          return {
            rows: current.length
              ? current.map((tool) => projected(text, tool))
              : [projected(text)],
          };
        }
        if (
          text.includes('from "mcp_servers"') ||
          text.includes('from "oauth_sessions"')
        ) {
          return { rows: [projected(text)] };
        }
      }
      if (text.startsWith('update "mcp_servers"')) {
        if (text.includes('"tool_catalog_revision" =')) {
          server.tool_catalog_revision =
            Number(server.tool_catalog_revision) + 1;
          server.tool_catalog_refreshed_at = null;
        } else {
          server.tool_catalog_refreshed_at = stamp;
          publications.push(Number(server.tool_catalog_revision));
        }
        return { rows: [] };
      }
      if (text.startsWith('insert into "oauth_sessions"')) {
        const tokens = parameters
          .filter((value): value is string => typeof value === "string")
          .filter((value) => value.startsWith("{"))
          .map((value) => JSON.parse(value) as Record<string, unknown>)
          .find((value) => "access_token" in value) as Tokens | undefined;
        if (tokens) {
          oauth.tokens = tokens;
          oauthWrites.push(tokens);
        }
        const fields = text.slice(
          text.indexOf(" returning ") + " returning ".length,
        );
        return {
          rows: [...fields.matchAll(/"([^"]+)"/g)].length
            ? [
                [...fields.matchAll(/"([^"]+)"/g)].map(
                  ([, column]) => oauth[column] ?? null,
                ),
              ]
            : [],
        };
      }
      if (text.startsWith('insert into "tools"')) {
        const definitions = parameters
          .filter((value): value is string => typeof value === "string")
          .filter((value) => value.startsWith("{"))
          .map((value) => JSON.parse(value) as Record<string, unknown>)
          .filter((value) => "name" in value && "inputSchema" in value);
        expect(definitions.length).toBeGreaterThan(0);
        tools = definitions.map((definition) => ({
          uuid: "00000000-0000-4000-8000-000000000042",
          mcp_server_uuid: SERVER,
          name: definition.name,
          description: definition.description,
          tool_schema: definition.inputSchema,
          definition,
          catalog_revision: server.tool_catalog_revision,
        }));
        return { rows: [] };
      }
      if (text.startsWith('delete from "tools"')) {
        if (!text.includes("not in")) tools = [];
        return { rows: [] };
      }
      if (text.startsWith('insert into "namespace_tool_mappings"'))
        return { rows: [] };
      throw new Error(`Unexpected synthetic SQL: ${text}`);
    },
  );
  return { server, oauth, publications, oauthWrites, queries };
}

let fixture: ReturnType<typeof databaseFixture>;
let pool: typeof import("./mcp-server-pool").mcpServerPool;
let catalog: typeof import("./tool-catalog");
let oauthRepo: typeof import("../../db/repositories/oauth-sessions.repo").oauthSessionsRepository;
let refresh: typeof import("../oauth-upstream/refresh-on-401").tryRefreshUpstreamTokens;
let params: () => Promise<ServerParameters>;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv("MAX_TOTAL_CONNECTIONS", "100");
  vi.stubEnv("TRANSFORM_LOCALHOST_TO_DOCKER_INTERNAL", "false");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network forbidden in synthetic test");
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  h.attempts.length =
    h.handshakes.length =
    h.discoveries.length =
    h.links.length =
      0;
  h.query.mockReset();
  h.refreshToken.mockReset().mockResolvedValue(renewed());
  fixture = databaseFixture();
  ({ oauthSessionsRepository: oauthRepo } =
    await import("../../db/repositories/oauth-sessions.repo"));
  ({ tryRefreshUpstreamTokens: refresh } =
    await import("../oauth-upstream/refresh-on-401"));
  ({ mcpServerPool: pool } = await import("./mcp-server-pool"));
  catalog = await import("./tool-catalog");
  const { mcpServersRepository } =
    await import("../../db/repositories/mcp-servers.repo");
  const { convertDbServerToParams } = await import("./utils");
  params = async () => {
    const saved = await mcpServersRepository.findByUuid(SERVER);
    if (!saved) throw new Error("Missing synthetic source");
    const converted = await convertDbServerToParams(saved);
    if (!converted) throw new Error("Invalid synthetic source");
    return converted;
  };
});
afterEach(async () => {
  await pool?.cleanupAll();
  await Promise.all(h.links.map((link) => link.close()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const list = () => catalog.listCatalogTools(NS, { refresh: false });

describe("OAuth → handshake → pool → persisted tool catalog", () => {
  it.each([undefined, "calendar read read"])(
    "same-grant 401 renewal (%s scope) keeps the directory and completes discovery",
    async (scope) => {
      h.refreshToken.mockResolvedValue(renewed(scope));
      expect(await list()).toHaveLength(1);
      expect(h.attempts).toEqual([]);
      expect(await catalog.refreshCatalogTools(SERVER)).toEqual({
        serverUuid: SERVER,
        success: true,
        count: 1,
      });
      expect(h.attempts[0]).toBe("Bearer synthetic-expired");
      expect(h.handshakes).toContain("Bearer synthetic-fresh");
      expect(h.discoveries).toEqual(["Bearer synthetic-fresh"]);
      expect(h.refreshToken).toHaveBeenCalledTimes(1);
      expect(fixture.server.tool_catalog_revision).toBe(7);
      expect(fixture.publications).toEqual([7]);
      expect((await list())[0]?.tool.description).toBe(
        "Fresh synthetic directory",
      );
      expect(
        h.links.some(
          (link) => link.token === "Bearer synthetic-fresh" && !link.closed,
        ),
      ).toBe(true);
    },
  );

  it.each([true, false])(
    "late renewal cannot overwrite explicit authorization even with the same refresh token (caller revision=%s)",
    async (withRevision) => {
      const started = deferred<void>();
      const grant = deferred<Tokens>();
      h.refreshToken.mockImplementation(() => {
        started.resolve();
        return grant.promise;
      });
      const source = await params();
      const pending = refresh(
        withRevision
          ? source
          : {
              uuid: source.uuid,
              name: source.name,
              url: source.url,
              user_id: source.user_id,
            },
      );
      await started.promise;
      await oauthRepo.upsert(
        {
          mcp_server_uuid: SERVER,
          tokens: {
            access_token: "synthetic-other-authorization",
            token_type: "Bearer",
            refresh_token: "synthetic-grant",
            scope: "read calendar",
          },
        },
        OWNER,
      );
      grant.resolve(renewed());
      expect((await pending).status).toBe("no_session");
      expect(fixture.oauth.tokens).toHaveProperty(
        "access_token",
        "synthetic-other-authorization",
      );
      expect(fixture.oauthWrites).toHaveLength(1);
      expect(fixture.server.tool_catalog_revision).toBe(8);
      expect(await list()).toEqual([]);
    },
  );

  it("scope-changing renewal hides the old identity directory and requires current-revision discovery", async () => {
    h.refreshToken.mockResolvedValue(renewed("read"));
    expect(await list()).toHaveLength(1);
    expect((await catalog.refreshCatalogTools(SERVER)).success).toBe(false);
    expect(fixture.server.tool_catalog_revision).toBe(8);
    expect(fixture.publications).toEqual([]);
    expect(await list()).toEqual([]);
    expect(
      h.links
        .filter((link) => link.token === "Bearer synthetic-fresh")
        .every((link) => link.closed),
    ).toBe(true);
    expect((await catalog.refreshCatalogTools(SERVER)).success).toBe(true);
    expect(fixture.publications).toEqual([8]);
    expect(await list()).toHaveLength(1);
  });

  it("late version invalidation does not close a newly acquired current-revision connection", async () => {
    fixture.server.tool_catalog_revision = 8;
    fixture.oauth.tokens = renewed("read");
    const current = await params();
    const connection = await pool.getSession(
      "synthetic-session",
      SERVER,
      current,
    );
    expect(connection).toBeDefined();
    const { invalidateCatalogConnections } =
      await import("./tool-catalog-events");
    await invalidateCatalogConnections(SERVER, 8);
    await invalidateCatalogConnections(SERVER, 7);
    expect(pool.getSessionConnections("synthetic-session")?.[SERVER]).toBe(
      connection,
    );
    expect(await pool.getSession("synthetic-session", SERVER, current)).toBe(
      connection,
    );
    expect(
      h.links
        .filter((link) => link.token === "Bearer synthetic-fresh")
        .every((link) => !link.closed),
    ).toBe(true);
  });
});
