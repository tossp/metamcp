import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";

import logger from "@/utils/logger";

import { db } from "../../../db/index";
import {
  mcpServersTable,
  namespaceToolMappingsTable,
  toolsTable,
} from "../../../db/schema";
import { parseToolName } from "../tool-name-parser";
import {
  CallToolMiddleware,
  ListToolsMiddleware,
} from "./functional-middleware";
import {
  loadNamespaceToolPolicies,
  requireNamespaceServer,
} from "./namespace-tool-scope";

/**
 * Configuration for the tool overrides middleware
 */
export interface ToolOverridesConfig {
  // Legacy options retained for callers; current namespace policies are never cached.
  cacheEnabled?: boolean;
  cacheTTL?: number;
  persistentCacheOnListTools?: boolean;
}

function mergeAnnotations(
  original: Tool["annotations"],
  namespaceOverrides?: Record<string, unknown> | null,
): Tool["annotations"] | undefined {
  if (!namespaceOverrides || Object.keys(namespaceOverrides).length === 0) {
    return original;
  }

  const baseAnnotations = (original ? { ...original } : {}) as Record<
    string,
    unknown
  >;

  for (const [key, value] of Object.entries(namespaceOverrides)) {
    baseAnnotations[key] = value;
  }

  return baseAnnotations as Tool["annotations"];
}

/**
 * Apply overrides to tools
 */
async function applyToolOverrides(
  tools: Tool[],
  namespaceUuid: string,
): Promise<Tool[]> {
  if (!tools || tools.length === 0) {
    return tools;
  }

  const overriddenTools: Tool[] = [];
  try {
    const policies = await loadNamespaceToolPolicies(namespaceUuid);
    for (const tool of tools) {
      try {
        const parsed = parseToolName(tool.name);
        if (!parsed) {
          // If tool name doesn't follow expected format, include as-is
          overriddenTools.push(tool);
          continue;
        }

        const server = policies.get(parsed.serverName);
        if (!server || server.status !== "ACTIVE") continue;
        const override = server.tools.get(parsed.originalToolName);
        if (override === null) continue;
        if (!override) {
          // No overrides found, include as-is
          overriddenTools.push(tool);
          continue;
        }

        // Apply overrides - preserve server prefix format
        // For name: only apply if overrideName is not null and not empty
        const overriddenName =
          override.overrideName && override.overrideName.trim() !== ""
            ? `${parsed.serverName}__${override.overrideName}`
            : tool.name;

        // For description: apply override if it's not null, even if empty string
        // This allows users to explicitly set empty descriptions
        const overriddenDescription =
          override.overrideDescription !== null
            ? override.overrideDescription
            : tool.description;

        // For title: apply override if provided (null means no override)
        let overriddenTitle: string | undefined = tool.title;
        if (typeof override.overrideTitle !== "undefined") {
          overriddenTitle =
            override.overrideTitle === null
              ? undefined
              : override.overrideTitle;
        }

        let overriddenAnnotations =
          tool.annotations && Object.keys(tool.annotations).length > 0
            ? { ...tool.annotations }
            : undefined;

        if (overriddenAnnotations && "title" in overriddenAnnotations) {
          // Strip legacy title hint to avoid conflicting with top-level title

          const { title: _removed, ...rest } = overriddenAnnotations;
          overriddenAnnotations =
            Object.keys(rest).length > 0 ? rest : undefined;
        }

        overriddenAnnotations = mergeAnnotations(
          overriddenAnnotations,
          override.overrideAnnotations,
        );

        const overriddenTool: Tool = {
          ...tool,
          name: overriddenName,
          title: overriddenTitle,
          description: overriddenDescription,
          annotations: overriddenAnnotations,
        };

        overriddenTools.push(overriddenTool);
      } catch (error) {
        logger.error(`Error applying overrides for tool ${tool.name}:`, error);
        // Unexpected rule failures must not silently return a partial directory.
        throw error;
      }
    }
  } catch (error) {
    logger.error("Error loading namespace tool overrides:", error);
    throw new Error("Unable to apply namespace tool overrides");
  }

  return overriddenTools;
}

/**
 * Map override name back to original name for tool calls
 */
export async function mapOverrideNameToOriginal(
  toolName: string,
  namespaceUuid: string,
  _useCache: boolean = false,
): Promise<string> {
  // Parse the tool name to extract server and tool parts
  const parsed = parseToolName(toolName);
  if (!parsed) {
    // If tool name doesn't follow expected format, return as-is
    return toolName;
  }

  try {
    const server = await requireNamespaceServer(
      namespaceUuid,
      parsed.serverName,
    );
    // Always check current mappings: a cached alias is not permission evidence.
    const mappings = await db
      .select({
        originalName: toolsTable.name,
        serverName: mcpServersTable.name,
      })
      .from(namespaceToolMappingsTable)
      .innerJoin(
        toolsTable,
        eq(toolsTable.uuid, namespaceToolMappingsTable.tool_uuid),
      )
      .innerJoin(
        mcpServersTable,
        eq(mcpServersTable.uuid, namespaceToolMappingsTable.mcp_server_uuid),
      )
      .where(
        and(
          eq(namespaceToolMappingsTable.namespace_uuid, namespaceUuid),
          eq(namespaceToolMappingsTable.override_name, parsed.originalToolName),
          eq(mcpServersTable.uuid, server.uuid),
          eq(toolsTable.mcp_server_uuid, server.uuid),
        ),
      );

    if (mappings.length > 1)
      throw new Error("Ambiguous tool alias in namespace");
    const toolMapping = mappings[0];
    if (toolMapping) {
      const originalFullName = `${server.name}__${toolMapping.originalName}`;

      return originalFullName;
    }
  } catch (error) {
    logger.error(
      `Error mapping override name ${toolName} to original in namespace ${namespaceUuid}:`,
      error,
    );
    throw error;
  }

  // If no mapping found, return the original name
  return toolName;
}

/**
 * Creates a List Tools middleware that applies tool name/description overrides
 */
export function createToolOverridesListToolsMiddleware(
  _config: ToolOverridesConfig = {},
): ListToolsMiddleware {
  return (handler) => {
    return async (request, context) => {
      // Call the original handler to get the tools
      const response = await handler(request, context);

      // Apply overrides to the tools
      if (response.tools) {
        const overriddenTools = await applyToolOverrides(
          response.tools,
          context.namespaceUuid,
        );

        return {
          ...response,
          tools: overriddenTools,
        };
      }

      return response;
    };
  };
}

/**
 * Creates a Call Tool middleware that maps override names back to original names
 */
export function createToolOverridesCallToolMiddleware(
  _config: ToolOverridesConfig = {},
): CallToolMiddleware {
  return (handler) => {
    return async (request, context) => {
      // Map override name back to original name if needed
      let originalToolName: string;
      try {
        originalToolName = await mapOverrideNameToOriginal(
          request.params.name,
          context.namespaceUuid,
        );
      } catch {
        return {
          content: [
            { type: "text", text: "Unable to resolve tool in this namespace" },
          ],
          isError: true,
        };
      }

      // Create a new request with the original tool name
      const modifiedRequest = {
        ...request,
        params: {
          ...request.params,
          name: originalToolName,
        },
      };

      // Call the original handler with the modified request
      return handler(modifiedRequest, context);
    };
  };
}

/**
 * Utility function to clear override cache
 */
export function clearOverrideCache(_namespaceUuid?: string): void {
  // Compatibility hook: overrides are request-local and no longer cached.
}
