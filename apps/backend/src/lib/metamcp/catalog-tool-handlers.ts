import { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolResult,
  CompatibilityCallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

import logger from "@/utils/logger";

import { mcpServersRepository } from "../../db/repositories/mcp-servers.repo";
import { toolCatalogRepository } from "../../db/repositories/tool-catalog.repo";
import { configService } from "../config.service";
import { ConnectedClient } from "./client";
import { extractForwardedHeaders, mergeHeaders } from "./header-forwarding";
import { mcpServerPool } from "./mcp-server-pool";
import {
  CallToolHandler,
  ListToolsHandler,
} from "./metamcp-middleware/functional-middleware";
import { isSafeToRetryToolCall } from "./session-error";
import { listCatalogTools } from "./tool-catalog";
import { parseToolName } from "./tool-name-parser";
import { convertDbServerToParams, sanitizeName } from "./utils";

/** Directory reads never wait for upstream connections. Calls connect only their target. */
export function createCatalogToolHandlers(
  namespaceUuid: string,
  sessionId: string,
  includeInactive: boolean,
) {
  const read = (headers?: Record<string, string>, refresh = true) =>
    listCatalogTools(namespaceUuid, {
      includeInactive,
      headers,
      sessionId,
      refresh,
    });

  const list: ListToolsHandler = async (_request, context) => {
    const entries = await read(context.clientRequestHeaders);
    const names = new Set<string>();
    const tools = entries.map(({ serverName, tool }) => {
      const name = `${sanitizeName(serverName)}__${tool.name}`;
      if (names.has(name)) throw new Error("Ambiguous tool names in namespace");
      names.add(name);
      return { ...tool, name };
    });
    return { tools };
  };

  const call: CallToolHandler = async (request, context) => {
    const { name, arguments: args } = request.params;
    const parsed = parseToolName(name);
    if (!parsed) throw new Error(`Invalid tool name format: ${name}`);

    // Read the current directory/membership even when this session listed before.
    // Never route from a stale session-local map or probe every upstream on a miss.
    const entries = await read(context.clientRequestHeaders, false);
    const candidates = entries.filter(
      ({ serverName, tool }) =>
        sanitizeName(serverName) === parsed.serverName &&
        tool.name === parsed.originalToolName,
    );
    if (candidates.length !== 1) throw new Error(`Unknown tool: ${name}`);
    const { serverUuid, revision } = candidates[0];
    const saved = await mcpServersRepository.findByUuid(serverUuid);
    if (!saved) throw new Error(`Unknown tool: ${name}`);
    if (
      "tool_catalog_revision" in saved &&
      saved.tool_catalog_revision !== revision
    ) {
      throw new Error(
        "Tool server configuration changed; refresh the directory",
      );
    }
    const params = await convertDbServerToParams(saved);
    if (!params) throw new Error("Tool server configuration is unavailable");
    // Carry the revision from the directory/config read into acquisition and retry.
    params.tool_catalog_revision = revision;
    const current = await toolCatalogRepository.findByServerUuid(serverUuid);
    if (!current || current.source.revision !== revision) {
      throw new Error(
        "Tool server configuration changed; refresh the directory",
      );
    }
    const forwarded = context.clientRequestHeaders
      ? extractForwardedHeaders(context.clientRequestHeaders, {
          [serverUuid]: params,
        })[serverUuid]
      : undefined;
    const effectiveParams = forwarded
      ? { ...params, headers: mergeHeaders(params.headers, forwarded) }
      : params;
    const clientForTool = await mcpServerPool.getSession(
      sessionId,
      serverUuid,
      effectiveParams,
      namespaceUuid,
    );
    if (!clientForTool)
      throw new Error(`No session available for server ${serverUuid}`);

    const mcpRequestOptions: RequestOptions = {
      resetTimeoutOnProgress:
        await configService.getMcpResetTimeoutOnProgress(),
      timeout: await configService.getMcpTimeout(),
      maxTotalTimeout: await configService.getMcpMaxTotalTimeout(),
    };
    const callOnce = (session: ConnectedClient) =>
      session.client.request(
        {
          method: "tools/call",
          params: {
            name: parsed.originalToolName,
            arguments: args || {},
            _meta: request.params._meta,
          },
        },
        CompatibilityCallToolResultSchema,
        mcpRequestOptions,
      );
    try {
      return (await callOnce(clientForTool)) as CallToolResult;
    } catch (error) {
      if (
        !isSafeToRetryToolCall(
          error,
          clientForTool.client.transport === undefined,
        )
      ) {
        throw error;
      }
      logger.warn(
        `Backend connection lost for server ${serverUuid}; retrying tool once`,
      );
      await mcpServerPool.invalidateServerConnection(
        sessionId,
        serverUuid,
        clientForTool,
      );
      const fresh = await mcpServerPool.getSession(
        sessionId,
        serverUuid,
        effectiveParams,
        namespaceUuid,
      );
      if (!fresh)
        throw new Error(
          `Failed to re-initialize session for server ${serverUuid}`,
        );
      return (await callOnce(fresh)) as CallToolResult;
    }
  };
  return { list, call };
}
