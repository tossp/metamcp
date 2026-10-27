import { randomUUID } from "node:crypto";

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ListToolsResultSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { mcpServersRepository } from "../../db/repositories/mcp-servers.repo";
import type { CatalogSource } from "../../db/repositories/tool-catalog.repo";
import { toolCatalogRepository } from "../../db/repositories/tool-catalog.repo";
import type { ConnectedClient } from "./client";
import { createMetaMcpClient } from "./client";
import { mergeHeaders } from "./header-forwarding";
import { mcpServerPool } from "./mcp-server-pool";
import { isCurrentServerRevision } from "./pool-revision-fence";
import { isRecoverableBackendError } from "./session-error";
import { notifyToolCatalogChanged } from "./tool-catalog-events";
import { assertNoCatalogSelfReference } from "./tool-catalog-self-reference";
import { createToolCatalogService } from "./tool-catalog-service";
import { convertDbServerToParams } from "./utils";

// Keep SDK validation for every known field while retaining vendor extensions.
// SDK listTools() uses a stripping ToolSchema, including nested annotations.
const CatalogToolSchema = ToolSchema.extend({
  inputSchema: ToolSchema.shape.inputSchema.passthrough(),
  outputSchema: ToolSchema.shape.outputSchema.unwrap().passthrough().optional(),
  annotations: ToolSchema.shape.annotations.unwrap().passthrough().optional(),
  execution: ToolSchema.shape.execution.unwrap().passthrough().optional(),
}).passthrough();
const CatalogListResultSchema = ListToolsResultSchema.extend({
  tools: z.array(CatalogToolSchema),
});

async function listAllTools(
  session: ConnectedClient,
  sourceUuid: string,
): Promise<Tool[]> {
  await assertNoCatalogSelfReference(sourceUuid, session.client);
  if (!session.client.getServerCapabilities()?.tools) return [];
  const tools: Tool[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await session.client.request(
      { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
      CatalogListResultSchema,
    );
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error("Repeated catalog cursor");
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  return tools;
}

async function fetchTools(
  source: CatalogSource,
  headers: Record<string, string>,
) {
  // Saved startup config (and OAuth tokens during conversion) is read only by a
  // refresh, never the latency-sensitive directory listing path.
  const server = await mcpServersRepository.findByUuid(source.uuid);
  if (
    !server ||
    !("tool_catalog_revision" in server) ||
    server.tool_catalog_revision !== source.revision
  ) {
    throw new Error("Catalog source changed");
  }
  const params = await convertDbServerToParams(server);
  if (!params) throw new Error("Catalog configuration unavailable");
  // Bind to the DB snapshot read before async OAuth conversion, not pool arrival.
  if (
    params.tool_catalog_revision !== undefined &&
    params.tool_catalog_revision !== source.revision
  ) {
    throw new Error("Catalog source changed");
  }
  params.tool_catalog_revision = source.revision;
  if (!(await isCurrentServerRevision(params)))
    throw new Error("Catalog source changed");
  params.headers = mergeHeaders(params.headers, headers);

  if (Object.keys(source.forward_headers ?? {}).length > 0) {
    // Bypass the pool for credential-sensitive refreshes. In particular, a pool
    // at its per-server cap must never lend us another caller's connection.
    const { client, transport } = createMetaMcpClient(params);
    try {
      if (!client || !transport)
        throw new Error("Catalog connection unavailable");
      await client.connect(transport);
      if (!(await isCurrentServerRevision(params)))
        throw new Error("Catalog source changed");
      return await listAllTools(
        { client, cleanup: async () => {} },
        source.uuid,
      );
    } finally {
      // Close both even if initialization failed before the client owned transport.
      await client?.close().catch(() => {});
      await transport?.close().catch(() => {});
    }
  }

  const sessionId = randomUUID();
  try {
    const session = await mcpServerPool.getSession(
      sessionId,
      source.uuid,
      params,
    );
    if (!session) throw new Error("Catalog connection unavailable");
    try {
      return await listAllTools(session, source.uuid);
    } catch (error) {
      if (!isRecoverableBackendError(error)) throw error;
      // Same one-read recovery as requestWithSessionRecovery, without its raw
      // exception logging: upstream error messages can contain credentials.
      await mcpServerPool.invalidateServerConnection(
        sessionId,
        source.uuid,
        session,
      );
      const fresh = await mcpServerPool.getSession(
        sessionId,
        source.uuid,
        params,
      );
      if (!fresh) throw new Error("Catalog connection unavailable");
      // Restart ALL pages with a new accumulator/cursor; never mix generations.
      return await listAllTools(fresh, source.uuid);
    }
  } finally {
    await mcpServerPool.cleanupSession(sessionId).catch(() => {});
  }
}

const service = createToolCatalogService({
  repository: toolCatalogRepository,
  fetchTools,
  notify: notifyToolCatalogChanged,
});

export const listCatalogTools = service.listCatalogTools;
export const refreshCatalogTools = service.refreshCatalogTools;
