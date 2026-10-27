import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer, Server } from "node:http";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import express from "express";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  findByUuid: vi.fn(),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock the central repository boundary: never load a database or auth runtime.
vi.mock("../../db/repositories", () => ({
  mcpServersRepository: { findByUuid: mocks.findByUuid },
}));
vi.mock("@/utils/logger", () => ({ default: mocks.logger }));
vi.mock("../../lib/metamcp/client", () => ({
  transformDockerUrl: (url: string) => url,
}));
vi.mock("../../middleware/better-auth-mcp.middleware", () => ({
  betterAuthMcpMiddleware: (
    req: express.Request & { user?: { id: string } },
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const actor = req.get("x-test-actor");
    if (actor) req.user = { id: actor };
    next();
  },
}));

import { getInspectorStdioLaunchDetails } from "../../lib/metamcp/inspector-stdio-launch";
import { ProcessManagedStdioTransport } from "../../lib/stdio-transport/process-managed-transport";
import serverRouter from "./server";

const actorId = "inspector-route-owner";
const fixture = fileURLToPath(
  new URL("./server.stdio.fixture.cjs", import.meta.url),
);
// Call-through spy: observe the narrow process boundary without faking launch.
const startSpy = vi.spyOn(ProcessManagedStdioTransport.prototype, "start");
const clients: Client[] = [];
let server: Server;
let baseUrl: string;
let requests: { method: string; path: string; queryKeys: string[] }[];

function startedChildren(): ProcessManagedStdioTransport[] {
  return startSpy.mock.contexts as ProcessManagedStdioTransport[];
}

function savedServer(overrides: Record<string, unknown> = {}) {
  return {
    uuid: randomUUID(),
    name: "virtual_inspector_route_fixture",
    type: "STDIO",
    user_id: actorId,
    command: process.execPath,
    args: [fixture, "two words", "'quoted'", "semi;colon", "$CANARY"],
    env: { INSPECTOR_FIXTURE_PASSWORD: "virtual-only-route-password" },
    ...overrides,
  };
}

function routeUrl(path: string, query: Record<string, string>): URL {
  const url = new URL(`/mcp-proxy/server${path}`, baseUrl);
  url.search = new URLSearchParams(query).toString();
  return url;
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Route test timed out")),
          4000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

beforeEach(async () => {
  mocks.findByUuid.mockReset();
  vi.clearAllMocks();
  vi.stubEnv("INSPECTOR_ROUTE_HOST_CANARY", "host-only-virtual-canary");
  requests = [];
  const app = express();
  app.use((req, _res, next) => {
    requests.push({
      method: req.method,
      path: req.path,
      queryKeys: Object.keys(req.query).sort(),
    });
    next();
  });
  // Deliberately no express.json(): /message must consume the real raw stream.
  app.use("/mcp-proxy/server", serverRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No TCP address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  try {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    // Safety net on assertion failures; success cases separately prove SSE close
    // performs cleanup without invoking this fallback.
    await Promise.allSettled(
      startedChildren().map((transport) => transport.close()),
    );
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

afterAll(() => startSpy.mockRestore());

describe("saved STDIO Inspector real browser SSE route", () => {
  it.each([
    ["own private", actorId, false],
    ["public", null, false],
    ["private config with malformed credential-bearing stdout", actorId, true],
  ])(
    "connects %s config and reaps the real MCP child on disconnect",
    async (_label, owner, malformedStdout) => {
      const config = savedServer({
        user_id: owner,
        env: {
          INSPECTOR_FIXTURE_PASSWORD: "virtual-only-route-password",
          ...(malformedStdout
            ? { INSPECTOR_FIXTURE_MALFORMED_STDOUT: "1" }
            : {}),
        },
      });
      mocks.findByUuid.mockResolvedValue(config);
      const client = new Client({
        name: "browser-route-test",
        version: "1.0.0",
      });
      clients.push(client);
      const transport = new SSEClientTransport(
        routeUrl("/stdio", { configId: config.uuid, transportType: "STDIO" }),
        {
          eventSourceInit: {
            fetch: (url, init) =>
              fetch(url, { ...init, headers: { "x-test-actor": actorId } }),
          },
          requestInit: { headers: { "x-test-actor": actorId } },
        },
      );

      await bounded(client.connect(transport, { timeout: 3000 }));
      expect(client.getServerVersion()?.name).toBe("inspector-stdio-fixture");
      await expect(client.ping({ timeout: 3000 })).resolves.toEqual({});
      const tools = await client.listTools({}, { timeout: 3000 });
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "environment_probe",
      ]);
      const probe = await client.callTool(
        { name: "environment_probe", arguments: {} },
        undefined,
        { timeout: 3000 },
      );
      expect(probe.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            initialized: true,
            savedCredentialPresent: true,
            hostCanaryAbsent: true,
            literalArgvPreserved: true,
            privateDirectoriesPresent: true,
          }),
        },
      ]);
      expect(mocks.findByUuid).toHaveBeenCalledWith(config.uuid);
      expect(startSpy).toHaveBeenCalledOnce();
      expect(requests[0]).toEqual({
        method: "GET",
        path: "/mcp-proxy/server/stdio",
        queryKeys: ["configId", "transportType"],
      });
      expect(requests.slice(1)).toHaveLength(5);
      expect(requests.slice(1)).toEqual(
        Array.from({ length: 5 }, () => ({
          method: "POST",
          path: "/mcp-proxy/server/message",
          queryKeys: ["sessionId"],
        })),
      );

      const child = startedChildren()[0];
      if (!child) throw new Error("No child transport captured");
      const pid = child.pid;
      const details = getInspectorStdioLaunchDetails(child);
      expect(pid).toBeTypeOf("number");
      expect(details).toBeDefined();
      if (pid === null || !details)
        throw new Error("Missing child lifecycle details");
      await access(details.homeDirectory);
      await access(details.tempDirectory);
      await client.close();
      await bounded(child.waitForClose());
      expect(child.pid).toBeNull();
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(access(details.rootDirectory)).rejects.toThrow();

      // A boolean assertion avoids printing even the virtual password on failure.
      const logged = Object.values(mocks.logger)
        .flatMap((method) => method.mock.calls)
        .flat()
        .map((value) =>
          value instanceof Error
            ? `${value.name}: ${value.message}\n${value.stack}`
            : JSON.stringify(value),
        )
        .join("\n");
      if (malformedStdout) {
        expect(mocks.logger.error).toHaveBeenCalledTimes(2);
        for (const [, error] of mocks.logger.error.mock.calls) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe("Invalid MCP STDIO message");
          expect((error as Error).cause).toBeUndefined();
        }
      }
      expect(logged.includes(config.env.INSPECTOR_FIXTURE_PASSWORD)).toBe(
        false,
      );
      expect(logged.includes(fixture)).toBe(false);
    },
  );
});

const entrypoints = [
  ["GET", "/stdio"],
  ["GET", "/sse"],
  ["POST", "/mcp"],
] as const;

describe.each(entrypoints)(
  "%s %s saved config HTTP rejection",
  (method, path) => {
    async function rejected(
      status: number,
      query: Record<string, string>,
      actor: string | undefined = actorId,
    ) {
      const response = await fetch(routeUrl(path, query), {
        method,
        headers: actor ? { "x-test-actor": actor } : {},
        signal: AbortSignal.timeout(3000),
      });
      const body = await response.text();
      expect(response.status).toBe(status);
      expect(body.includes("virtual-only-route-password")).toBe(false);
      expect(body.includes(fixture)).toBe(false);
      expect(startSpy).not.toHaveBeenCalled();
      return body;
    }

    it("returns the same 404 for another user's private and unknown configs", async () => {
      const config = savedServer({ user_id: "someone-else" });
      mocks.findByUuid
        .mockResolvedValueOnce(config)
        .mockResolvedValueOnce(undefined);
      const forbidden = await rejected(404, {
        configId: config.uuid,
        transportType: "STDIO",
      });
      const missing = await rejected(404, {
        configId: randomUUID(),
        transportType: "STDIO",
      });
      expect(forbidden).toBe(missing);
    });

    it("requires an actor even for a public config", async () => {
      const config = savedServer({ user_id: null });
      mocks.findByUuid.mockResolvedValue(config);
      // Empty header is intentionally passed through the middleware with no user.
      await rejected(
        401,
        { configId: config.uuid, transportType: "STDIO" },
        "",
      );
    });

    it("rejects invalid UUIDs without consulting the repository", async () => {
      await rejected(400, { configId: "not-a-uuid", transportType: "STDIO" });
      expect(mocks.findByUuid).not.toHaveBeenCalled();
    });

    it("rejects saved non-STDIO configs", async () => {
      const config = savedServer({
        type: "SSE",
        url: "http://invalid.test/sse",
      });
      mocks.findByUuid.mockResolvedValue(config);
      await rejected(400, { configId: config.uuid, transportType: "STDIO" });
    });

    it.each([
      ["command", process.execPath],
      ["args", ""],
      ["env", "{}"],
      ["env", '{"PASSWORD":"virtual-request-only"}'],
    ])("rejects request %s overrides without launch", async (key, value) => {
      const config = savedServer();
      mocks.findByUuid.mockResolvedValue(config);
      await rejected(400, {
        configId: config.uuid,
        transportType: "STDIO",
        [key]: value,
      });
    });

    it.each([
      { PASSWORD: "${INSPECTOR_ROUTE_HOST_CANARY}" },
      { HOME: "/virtual/override-home" },
      { TMPDIR: "/virtual/override-tmp" },
    ])(
      "rejects saved placeholders or isolated directory overrides",
      async (env) => {
        const config = savedServer({ env });
        mocks.findByUuid.mockResolvedValue(config);
        await rejected(400, { configId: config.uuid, transportType: "STDIO" });
      },
    );

    it("does not fall back to raw launch when lookup fails or throws", async () => {
      mocks.findByUuid.mockRejectedValue(
        new Error("virtual-only-route-password"),
      );
      await rejected(500, { configId: randomUUID(), transportType: "STDIO" });
    });

    it("keeps nonempty request env blocked in the legacy temporary mode", async () => {
      await rejected(400, {
        transportType: "STDIO",
        command: process.execPath,
        args: "-e process.exit(0)",
        env: '{"PASSWORD":"virtual-request-only"}',
      });
      expect(mocks.findByUuid).not.toHaveBeenCalled();
    });
  },
);
