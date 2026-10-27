import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test, { after, beforeEach } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

// Execute the real components and their button/effect callbacks. Only external
// hooks, transport and child rendering are stubbed; no DOM/network is needed.
const h = {};
const key = Symbol.for("metamcp.issue39.tool-management-test");
globalThis[key] = h;
after(() => delete globalThis[key]);
const moduleUrl = (source) =>
  `data:text/javascript,${encodeURIComponent(`const h = globalThis[Symbol.for("metamcp.issue39.tool-management-test")];\n${source}`)}`;
const stubs = new Map([
  [
    "react",
    moduleUrl(`
      export function useState(initial) {
        const i = h.index++;
        if (!(i in h.slots)) h.slots[i] = initial;
        return [h.slots[i], value => {
          h.slots[i] = typeof value === "function" ? value(h.slots[i]) : value;
        }];
      }
      export function useRef(initial) {
        const i = h.index++;
        if (!(i in h.slots)) h.slots[i] = { current: initial };
        return h.slots[i];
      }
      export function useEffect(fn, deps) {
        const i = h.index++;
        const old = h.slots[i];
        if (!old || deps.some((value, j) => value !== old[j])) h.effects.push(fn);
        h.slots[i] = deps;
      }
      export const useCallback = fn => fn;
      export default { useState, useRef, useEffect, useCallback };
    `),
  ],
  [
    "react/jsx-runtime",
    moduleUrl(`
      export const jsx = (type, props) => ({ type, props });
      export const jsxs = jsx;
      export const Fragment = "Fragment";
    `),
  ],
  [
    "lucide-react",
    moduleUrl(`export const AlertTriangle = "AlertTriangle", Database = "Database",
      RefreshCw = "RefreshCw", Wrench = "Wrench";`),
  ],
  [
    "@repo/zod-types",
    moduleUrl('export const ToolStatusEnum = { enum: { ACTIVE: "ACTIVE" } };'),
  ],
  [
    "@modelcontextprotocol/sdk/types.js",
    moduleUrl("export const ListToolsResultSchema = {};"),
  ],
  [
    "sonner",
    moduleUrl(`export const toast = {
      success: (...args) => h.successes.push(args),
      error: (...args) => h.errors.push(args)
    };`),
  ],
  [
    "@/hooks/useTranslations",
    moduleUrl("export const useTranslations = () => ({ t: key => key });"),
  ],
  [
    "@/lib/trpc",
    moduleUrl(`
      const legacy = { useMutation() { throw new Error("Legacy catalog write used"); } };
      export const trpc = { frontend: {
        tools: {
          refresh: { useMutation: () => ({ mutateAsync: h.force }) },
          getByMcpServerUuid: { useQuery: () => h.serverQuery },
          sync: legacy
        },
        namespaces: {
          getTools: { useQuery: () => h.namespaceQuery },
          refreshTools: legacy
        }
      } };
    `),
  ],
  ["@/components/ui/button", moduleUrl('export const Button = "Button";')],
  [
    "@/components/skeletons/tool-management-skeleton",
    moduleUrl('export const ToolManagementSkeleton = "Skeleton";'),
  ],
  [
    "./tools-data-table",
    moduleUrl('export const UnifiedToolsTable = "ServerTable";'),
  ],
  [
    "./enhanced-namespace-tools-table",
    moduleUrl('export const EnhancedNamespaceToolsTable = "NamespaceTable";'),
  ],
]);
const urls = [
  "../app/[locale]/(sidebar)/mcp-servers/[uuid]/components/tool-management.tsx",
  "../app/[locale]/(sidebar)/namespaces/[uuid]/components/namespace-tool-management.tsx",
].map(
  (path) => pathToFileURL(fileURLToPath(new URL(path, import.meta.url))).href,
);
const sources = new Map(
  await Promise.all(
    urls.map(async (url) => [
      url,
      ts.transpileModule(await readFile(new URL(url), "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
      }).outputText,
    ]),
  ),
);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (sources.has(context.parentURL) && stubs.has(specifier)) {
      return { url: stubs.get(specifier), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    return sources.has(url)
      ? { format: "module", source: sources.get(url), shortCircuit: true }
      : nextLoad(url, context);
  },
});
let ToolManagement, NamespaceToolManagement;
try {
  ({ ToolManagement } = await import(urls[0]));
  ({ NamespaceToolManagement } = await import(urls[1]));
} finally {
  hooks.deregister();
}

const schema = { type: "object", properties: { input: { type: "string" } } };
const savedTool = {
  uuid: "tool-1",
  name: "existing",
  description: "Last successful description",
  toolSchema: schema,
  serverUuid: "server-1",
  serverName: "First",
  status: "INACTIVE",
  overrideName: "custom_name",
  overrideDescription: "User override",
};
const listedTool = {
  name: "First__custom_name",
  description: "User override",
  inputSchema: schema,
};
beforeEach(() => {
  Object.assign(h, {
    slots: [],
    effects: [],
    calls: [],
    successes: [],
    errors: [],
    forceResponse: { success: true, count: 1 },
    forceError: undefined,
    listResponse: { tools: [listedTool] },
    listError: undefined,
    dbResponse: { data: { success: true, data: [savedTool] } },
  });
  h.force = async (input) => {
    h.calls.push(["force", input]);
    if (h.forceError) throw h.forceError;
    return h.forceResponse;
  };
  h.makeRequest = async (input) => {
    h.calls.push(["list", input]);
    if (h.listError) throw h.listError;
    return h.listResponse;
  };
  const refetch = async () => {
    h.calls.push(["db"]);
    return h.dbResponse;
  };
  h.serverQuery = { data: { success: true, data: [savedTool] }, refetch };
  h.namespaceQuery = { ...h.serverQuery, isLoading: false };
});

function render() {
  h.index = 0;
  h.effects = [];
  h.tree = h.component(h.props);
  for (const effect of h.effects) effect();
  return h.tree;
}
async function settle() {
  await setImmediate();
  render();
  await setImmediate();
  render();
}
async function mount(namespace = false, connected = true) {
  h.component = namespace ? NamespaceToolManagement : ToolManagement;
  h.props = namespace
    ? {
        namespaceUuid: "namespace-1",
        servers: [
          { uuid: "server-1", name: "First", status: "ACTIVE" },
          { uuid: "server-2", name: "Second", status: "ACTIVE" },
        ],
        makeRequest: connected ? h.makeRequest : undefined,
      }
    : { mcpServerUuid: "server-1", makeRequest: h.makeRequest };
  render();
  await settle();
}
function findNode(predicate, node = h.tree) {
  if (!node || typeof node !== "object") return;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = findNode(predicate, child ?? null);
    if (found) return found;
  }
}
function table(namespace = false) {
  return findNode(
    (node) => node.type === (namespace ? "NamespaceTable" : "ServerTable"),
  )?.props;
}
async function refresh() {
  h.calls = [];
  h.successes = [];
  h.errors = [];
  await findNode((node) => node.type === "Button").props.onClick();
  await settle();
}

// Initial single-server viewing is intentionally a force refresh, unlike a
// namespace's initial ordinary catalog read.
test("single-server automatic viewing and manual button force once, never Inspector list/sync", async () => {
  await mount();
  assert.deepEqual(h.calls, [["force", { mcpServerUuid: "server-1" }], ["db"]]);
  assert.deepEqual(table().mcpTools, [
    {
      name: savedTool.name,
      description: savedTool.description,
      inputSchema: schema,
    },
  ]);
  await refresh();
  assert.deepEqual(h.calls, [["force", { mcpServerUuid: "server-1" }], ["db"]]);
  assert.equal(h.successes.length, 1);
  h.calls = [];
  await table().onRefreshMcpTools();
  assert.equal(h.calls[0][0], "force");
});

test("single-server display preserves the complete persisted MCP definition", async () => {
  const definition = {
    name: "existing",
    title: "Lookup",
    description: "full",
    inputSchema: schema,
    outputSchema: { type: "object", "x-vendor": true },
    annotations: { readOnlyHint: true },
    _meta: { revision: 2 },
    "x-vendor": { nested: true },
  };
  const full = { ...savedTool, definition };
  h.serverQuery.data = { success: true, data: [full] };
  h.dbResponse = { data: { success: true, data: [full] } };
  await mount();
  assert.deepEqual(table().mcpTools, [definition]);
});

for (const failure of ["response", "rejection", "db-error", "db-response"]) {
  test(`single-server ${failure} preserves the last display and never toasts success`, async () => {
    await mount();
    const previous = table().mcpTools;
    if (failure === "response")
      h.forceResponse = { success: false, count: 0, error: "offline" };
    if (failure === "rejection") h.forceError = new Error("network");
    if (failure === "db-error")
      h.dbResponse = { ...h.dbResponse, error: new Error("read failed") };
    if (failure === "db-response") h.dbResponse = { data: { success: false } };
    await refresh();
    assert.deepEqual(table().mcpTools, previous);
    assert.deepEqual(table().dbTools, [savedTool]);
    assert.equal(h.successes.length, 0);
    assert.equal(h.errors.length, 1);
  });
}

test("single-server same-name schema/description and successful empty catalogs replace the display", async () => {
  await mount();
  const updated = {
    ...savedTool,
    description: "Updated",
    toolSchema: { type: "object", required: ["new"] },
  };
  h.dbResponse = { data: { success: true, data: [updated] } };
  await refresh();
  assert.equal(table().mcpTools[0].description, "Updated");
  assert.deepEqual(table().mcpTools[0].inputSchema, updated.toolSchema);
  h.forceResponse = { success: true, count: 0 };
  h.dbResponse = { data: { success: true, data: [] } };
  await refresh();
  assert.deepEqual(table().mcpTools, []);
  assert.deepEqual(table().dbTools, []);
  assert.equal(h.successes.length, 1);
});

test("namespace initial read never forces or rewrites mappings; manual refresh forces before DB/list", async () => {
  await mount(true);
  assert.deepEqual(h.calls, [["list", { method: "tools/list", params: {} }]]);
  assert.equal(h.successes.length, 0);
  await refresh();
  assert.deepEqual(h.calls, [
    ["force", { namespaceUuid: "namespace-1" }],
    ["db"],
    ["list", { method: "tools/list", params: {} }],
  ]);
  assert.deepEqual(table(true).savedTools, [savedTool]);
  assert.equal(table(true).savedTools[0].status, "INACTIVE");
  assert.equal(table(true).savedTools[0].overrideName, "custom_name");
  assert.equal(h.successes.length, 1);
  h.calls = [];
  await table(true).onRefreshTools();
  assert.equal(h.calls[0][0], "force");
});

test("namespace refresh forces even without an Inspector connection", async () => {
  await mount(true, false);
  assert.deepEqual(h.calls, []);
  await refresh();
  assert.deepEqual(h.calls, [
    ["force", { namespaceUuid: "namespace-1" }],
    ["db"],
  ]);
  assert.deepEqual(table(true).savedTools, [savedTool]);
  assert.equal(h.successes.length, 1);
});

for (const failure of [
  "force",
  "list",
  "invalid-list",
  "db-error",
  "db-response",
]) {
  test(`namespace ${failure} failure retains tools and does not report success`, async () => {
    await mount(true);
    const previous = table(true).mcpTools;
    if (failure === "force") h.forceError = new Error("force failed");
    if (failure === "list") h.listError = new Error("list failed");
    if (failure === "invalid-list") h.listResponse = undefined;
    if (failure === "db-error")
      h.dbResponse = { error: new Error("DB failed") };
    if (failure === "db-response") h.dbResponse = { data: { success: false } };
    await refresh();
    assert.deepEqual(table(true).mcpTools, previous);
    assert.deepEqual(table(true).savedTools, [savedTool]);
    assert.equal(h.successes.length, 0);
    assert.equal(h.errors.length, 1);
    assert.ok(findNode((node) => node.props?.role === "alert"));
  });
}

for (const success of [false, true]) {
  test(`namespace per-server failures are shown even if top-level success is ${success}`, async () => {
    const retained = { ...listedTool, name: "Second__cached" };
    h.listResponse = { tools: [listedTool, retained] };
    await mount(true);
    const updated = { ...listedTool, description: "Refreshed first server" };
    h.listResponse = { tools: [updated, retained] };
    h.forceResponse = {
      success,
      count: 1,
      results: [
        { serverUuid: "server-1", success: true, count: 1 },
        {
          serverUuid: "server-2",
          success: false,
          count: 0,
          error: "upstream offline",
        },
        {
          serverUuid: "unknown-server",
          success: false,
          count: 0,
          error: "timed out",
        },
      ],
    };
    await refresh();
    assert.equal(h.successes.length, 0);
    assert.match(h.errors[0][1].description, /Second: upstream offline/);
    assert.match(h.errors[0][1].description, /unknown-server: timed out/);
    const alert = findNode((node) => node.props?.role === "alert");
    assert.match(JSON.stringify(alert), /Second: upstream offline/);
    assert.deepEqual(table(true).mcpTools, [updated, retained]);
    assert.deepEqual(table(true).savedTools, [savedTool]);
    assert.deepEqual(
      h.calls.map(([name]) => name),
      ["force", "db", "list"],
    );
  });
}

test("namespace partial failure after Inspector disconnect retains its last list", async () => {
  await mount(true);
  h.props.makeRequest = undefined;
  render();
  h.forceResponse = {
    success: true,
    count: 0,
    results: [{ serverUuid: "server-1", success: false, count: 0 }],
  };
  await refresh();
  assert.deepEqual(table(true).mcpTools, [listedTool]);
  assert.equal(h.successes.length, 0);
  assert.equal(h.errors.length, 1);
});

test("single-server initial discovery failure still displays its persisted catalog", async () => {
  h.forceError = new Error("offline");
  await mount();
  assert.deepEqual(table().dbTools, [savedTool]);
  assert.equal(table().mcpTools[0].name, savedTool.name);
  assert.equal(h.successes.length, 0);
  assert.equal(h.errors.length, 1);
});

test("namespace top-level failure and a subsequent list error are both visible", async () => {
  await mount(true);
  h.forceResponse = { success: false, count: 0, error: "refresh rejected" };
  h.listError = new Error("list failed");
  await refresh();
  assert.equal(h.successes.length, 0);
  assert.match(h.errors[0][1].description, /refresh rejected\nlist failed/);
  assert.deepEqual(table(true).mcpTools, [listedTool]);
});

test("namespace successful zero clears old display and errors, without a mapping write", async () => {
  await mount(true);
  h.forceError = new Error("offline");
  await refresh();
  h.forceError = undefined;
  h.forceResponse = { success: true, count: 0, results: [] };
  h.dbResponse = { data: { success: true, data: [] } };
  h.listResponse = { tools: [] };
  await refresh();
  assert.equal(table(true), undefined);
  assert.equal(
    findNode((node) => node.props?.role === "alert"),
    undefined,
  );
  assert.equal(h.successes.length, 1);
  assert.equal(h.errors.length, 0);
});

test("namespace initial list failure is reported without forcing or clearing saved tools", async () => {
  h.listError = new Error("initial read failed");
  await mount(true);
  assert.deepEqual(table(true).savedTools, [savedTool]);
  assert.equal(
    h.calls.some(([name]) => name === "force"),
    false,
  );
  assert.equal(h.successes.length, 0);
  assert.equal(h.errors.length, 1);
});
