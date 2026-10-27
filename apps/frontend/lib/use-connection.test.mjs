import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test, { after, beforeEach } from "node:test";

import ts from "typescript";

// Exercise the real hook without a DOM, network, database or new dependencies.
const harness = {};
const harnessKey = Symbol.for("metamcp.issue37.connection-test");
globalThis[harnessKey] = harness;
after(() => delete globalThis[harnessKey]);
const prefix = `const h = globalThis[Symbol.for("metamcp.issue37.connection-test")];`;
const moduleUrl = (source) =>
  `data:text/javascript,${encodeURIComponent(prefix + source)}`;
const transportModule = (name) =>
  moduleUrl(`
    export class ${name} {
      constructor(url, options) {
        h.transports.push({ kind: "${name}", url, options });
      }
    }
    export class SseError extends Error {}
  `);
const stubs = new Map([
  [
    "@modelcontextprotocol/sdk/client/index.js",
    moduleUrl(`export class Client {
      async connect() { if (h.failure) throw h.failure; }
      getServerCapabilities() { return {}; }
      getServerVersion() { return {}; }
      getInstructions() { return undefined; }
    }`),
  ],
  [
    "@modelcontextprotocol/sdk/client/sse.js",
    transportModule("SSEClientTransport"),
  ],
  [
    "@modelcontextprotocol/sdk/client/streamableHttp.js",
    transportModule("StreamableHTTPClientTransport"),
  ],
  [
    "@modelcontextprotocol/sdk/client/auth.js",
    moduleUrl('export const auth = async () => "AUTHORIZED";'),
  ],
  [
    "@modelcontextprotocol/sdk/types.js",
    moduleUrl(`
      export class McpError extends Error {}
      export const ErrorCode = { MethodNotFound: -32601 };
      ${[
        "CancelledNotificationSchema",
        "CompleteResultSchema",
        "CreateMessageRequestSchema",
        "ListRootsRequestSchema",
        "LoggingMessageNotificationSchema",
        "PromptListChangedNotificationSchema",
        "ResourceListChangedNotificationSchema",
        "ResourceUpdatedNotificationSchema",
        "ToolListChangedNotificationSchema",
      ]
        .map((name) => `export const ${name} = {};`)
        .join("\n")}
    `),
  ],
  [
    "@repo/zod-types",
    moduleUrl(`export const McpServerTypeEnum = { enum: {
      STDIO: "STDIO", SSE: "SSE", STREAMABLE_HTTP: "STREAMABLE_HTTP"
    } };`),
  ],
  ["ahooks", moduleUrl("export const useMemoizedFn = fn => fn;")],
  [
    "react",
    moduleUrl(`
      export const useEffect = () => {};
      export function useState(initial) {
        const index = h.values.push(initial) - 1;
        return [initial, value => {
          h.values[index] = typeof value === "function"
            ? value(h.values[index]) : value;
        }];
      }
    `),
  ],
  ["sonner", moduleUrl("export const toast = { error() {} };")],
  ["@/lib/constants", moduleUrl("export const SESSION_KEYS = {};")],
  ["../lib/constants", moduleUrl("export const SESSION_KEYS = {};")],
  [
    "../lib/env",
    moduleUrl('export const getAppUrl = () => "https://app.example.invalid";'),
  ],
  [
    "../lib/notificationTypes",
    moduleUrl("export const StdErrNotificationSchema = {};"),
  ],
  [
    "../lib/oauth-provider",
    moduleUrl(`export const createAuthProvider = () => ({
      tokens: async () => h.oauthToken ? { access_token: h.oauthToken } : undefined,
      clear() {}
    });`),
  ],
  [
    "../lib/trpc",
    moduleUrl(`const query = { useQuery: () => ({ data: undefined }) };
      export const trpc = { frontend: { config: {
        getMcpTimeout: query, getMcpMaxTotalTimeout: query,
        getMcpResetTimeoutOnProgress: query
      } } };`),
  ],
]);
const hookUrl = new URL("../hooks/useConnection.ts", import.meta.url).href;
const source = ts.transpileModule(await readFile(new URL(hookUrl), "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === hookUrl) {
      if (stubs.has(specifier)) {
        return { url: stubs.get(specifier), shortCircuit: true };
      }
      if (specifier === "../lib/connection-url") {
        return nextResolve(
          new URL("./connection-url.ts", import.meta.url).href,
          context,
        );
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    return url === hookUrl
      ? { format: "module", source, shortCircuit: true }
      : nextLoad(url, context);
  },
});
let runConnectionHook;
try {
  ({ useConnection: runConnectionHook } = await import(hookUrl));
} finally {
  hooks.deregister();
}

beforeEach((t) => {
  Object.assign(harness, {
    values: [],
    transports: [],
    errors: [],
    failure: undefined,
    oauthToken: undefined,
  });
  t.mock.method(globalThis, "fetch", async () => ({
    json: async () => ({ status: "ok" }),
  }));
  t.mock.method(console, "error", (...args) => harness.errors.push(args));
});

const configId = "a5e1cbd3-6f80-4a8d-9dc5-18ff61c6a49e";
const baseOptions = {
  mcpServerUuid: configId,
  transportType: "STDIO",
  url: "",
};

test("hook sends only the saved STDIO reference and redacts raw connection errors", async () => {
  const password = "virtual-password-37";
  harness.failure = new Error(`virtual command/args/env: ${password}`);
  await runConnectionHook({
    ...baseOptions,
    command: "private-command",
    args: `--password=${password}`,
    env: { PASSWORD: password },
  }).connect();
  assert.equal(harness.transports.length, 1);
  assert.deepEqual(
    [...harness.transports[0].url.searchParams],
    [
      ["configId", configId],
      ["transportType", "STDIO"],
    ],
  );
  assert.equal(harness.values[0], "error");
  assert.equal(harness.errors.length > 0, true);
  const logged = harness.errors.flat().map(String).join(" ");
  assert.equal(logged.includes(password), false);
  assert.equal(logged.includes("https://"), false);
  assert.equal(harness.errors.flat().includes(harness.failure), false);
});

test("hook rejects a missing or invalid STDIO ID before creating a transport", async () => {
  for (const mcpServerUuid of [undefined, "", "not-a-uuid"]) {
    await runConnectionHook({ ...baseOptions, mcpServerUuid }).connect();
  }
  assert.equal(harness.transports.length, 0);
  assert.equal(harness.values[0], "error");
});

for (const connection of [
  { transportType: "STDIO" },
  { transportType: "SSE" },
  { transportType: "STREAMABLE_HTTP" },
  { transportType: "SSE", isMetaMCP: true, includeInactiveServers: true },
]) {
  test(`hook preserves bearer/custom/OAuth headers for ${connection.isMetaMCP ? "MetaMCP" : connection.transportType}`, async () => {
    for (const [bearerToken, headerName, oauthToken, expected] of [
      [
        "virtual-bearer",
        undefined,
        "virtual-oauth-fallback",
        { Authorization: "Bearer virtual-bearer" },
      ],
      [
        "virtual-custom",
        "X-Api-Key",
        undefined,
        { "X-Api-Key": "virtual-custom", "x-custom-auth-header": "X-Api-Key" },
      ],
      [
        undefined,
        undefined,
        "virtual-oauth",
        { Authorization: "Bearer virtual-oauth" },
      ],
    ]) {
      harness.oauthToken = oauthToken;
      const statusIndex = harness.values.length;
      await runConnectionHook({
        ...baseOptions,
        ...connection,
        url: "/mcp-proxy/metamcp/example/sse",
        bearerToken,
        headerName,
      }).connect();
      const { kind, options } = harness.transports.at(-1);
      assert.equal(
        kind,
        connection.transportType === "STREAMABLE_HTTP"
          ? "StreamableHTTPClientTransport"
          : "SSEClientTransport",
      );
      assert.deepEqual(options.requestInit, {
        headers: expected,
        credentials: "include",
      });
      await options.eventSourceInit.fetch("https://upstream.example.invalid", {
        method: "GET",
      });
      const [, requestInit] = globalThis.fetch.mock.calls.at(-1).arguments;
      assert.deepEqual(requestInit, {
        method: "GET",
        headers: expected,
        credentials: "include",
      });
      assert.equal(harness.values[statusIndex], "connected");
    }
  });
}
