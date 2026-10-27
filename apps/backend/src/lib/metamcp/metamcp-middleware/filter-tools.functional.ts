import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";

import logger from "@/utils/logger";

import { db } from "../../../db/index";
import { namespaceToolMappingsTable, toolsTable } from "../../../db/schema";
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
 * Configuration for the filter middleware
 */
export interface FilterToolsConfig {
  // Legacy options retained for callers; permissions are always read fresh.
  cacheEnabled?: boolean;
  cacheTTL?: number;
  customErrorMessage?: (toolName: string, reason: string) => string;
}

/**
 * Get current tool status from the database
 */
async function getToolStatus(
  namespaceUuid: string,
  toolName: string,
  serverUuid: string,
): Promise<"ACTIVE" | "INACTIVE" | null> {
  try {
    // Query database for tool status
    const mappings = await db
      .select({
        status: namespaceToolMappingsTable.status,
      })
      .from(namespaceToolMappingsTable)
      .innerJoin(
        toolsTable,
        eq(toolsTable.uuid, namespaceToolMappingsTable.tool_uuid),
      )
      .where(
        and(
          eq(namespaceToolMappingsTable.namespace_uuid, namespaceUuid),
          eq(toolsTable.name, toolName),
          eq(namespaceToolMappingsTable.mcp_server_uuid, serverUuid),
          eq(toolsTable.mcp_server_uuid, serverUuid),
        ),
      );

    if (mappings.length > 1) {
      throw new Error("Ambiguous tool status in namespace");
    }
    const status = mappings[0]?.status || null;
    if (status !== null && status !== "ACTIVE" && status !== "INACTIVE") {
      throw new Error("Invalid tool status");
    }

    return status;
  } catch (error) {
    logger.error(
      `Error fetching tool status for ${toolName} in namespace ${namespaceUuid}:`,
      error,
    );
    throw error;
  }
}

// parseToolName is now imported from shared utility

/**
 * Get server UUID by name
 */
async function getServerUuidByName(
  serverName: string,
  namespaceUuid: string,
): Promise<string> {
  return (await requireNamespaceServer(namespaceUuid, serverName)).uuid;
}

/**
 * Filter tools based on their status in the namespace
 */
async function filterActiveTools(
  tools: Tool[],
  namespaceUuid: string,
): Promise<Tool[]> {
  if (!tools?.length) return tools;
  try {
    const policies = await loadNamespaceToolPolicies(namespaceUuid);
    return tools.filter((tool) => {
      const parsed = parseToolName(tool.name);
      if (!parsed) return true;
      const server = policies.get(parsed.serverName);
      if (!server || server.status !== "ACTIVE") return false;
      const policy = server.tools.get(parsed.originalToolName);
      // No tool mapping retains the existing default-active behavior.
      return policy === undefined || policy?.status === "ACTIVE";
    });
  } catch (error) {
    logger.error("Error loading namespace tool permissions:", error);
    throw new Error("Unable to load namespace tool permissions");
  }
}

/**
 * Check if a tool is allowed to be called
 */
async function isToolAllowed(
  toolName: string,
  namespaceUuid: string,
  serverUuid: string,
): Promise<{ allowed: boolean; reason?: string }> {
  try {
    const parsed = parseToolName(toolName);
    if (!parsed) {
      // If tool name doesn't follow expected format, allow it
      return { allowed: true };
    }

    const status = await getToolStatus(
      namespaceUuid,
      parsed.originalToolName,
      serverUuid,
    );

    // If no mapping exists or tool is active, allow it
    if (status === null || status === "ACTIVE") {
      return { allowed: true };
    }

    // Tool is inactive
    return {
      allowed: false,
      reason: "Tool has been marked as inactive in this namespace",
    };
  } catch (error) {
    logger.error(
      `Error checking if tool ${toolName} is allowed in namespace ${namespaceUuid}:`,
      error,
    );
    return { allowed: false, reason: "Unable to verify tool permissions" };
  }
}

/**
 * Creates a List Tools middleware that filters out inactive tools
 */
export function createFilterListToolsMiddleware(
  _config: FilterToolsConfig = {},
): ListToolsMiddleware {
  return (handler) => {
    return async (request, context) => {
      // Call the original handler to get the tools
      const response = await handler(request, context);

      // Filter the tools based on namespace tool mappings
      if (response.tools) {
        const filteredTools = await filterActiveTools(
          response.tools,
          context.namespaceUuid,
        );

        return {
          ...response,
          tools: filteredTools,
        };
      }

      return response;
    };
  };
}

/**
 * Creates a Call Tool middleware that blocks calls to inactive tools
 */
export function createFilterCallToolMiddleware(
  config: FilterToolsConfig = {},
): CallToolMiddleware {
  const customErrorMessage =
    config.customErrorMessage ??
    ((toolName: string, reason: string) =>
      `Tool "${toolName}" is currently inactive and disallowed in this namespace: ${reason}`);

  return (handler) => {
    return async (request, context) => {
      // Extract tool name and server info from the request
      const toolName = request.params.name;

      // We need to get serverUuid somehow - this would need to be passed through context
      // For now, let's extract it from the tool name format
      const parsed = parseToolName(toolName);
      if (parsed) {
        try {
          const serverUuid = await getServerUuidByName(
            parsed.serverName,
            context.namespaceUuid,
          );
          const { allowed, reason } = await isToolAllowed(
            toolName,
            context.namespaceUuid,
            serverUuid,
          );

          if (!allowed) {
            // Return error response instead of calling the handler
            return {
              content: [
                {
                  type: "text",
                  text: customErrorMessage(
                    toolName,
                    reason || "Unknown reason",
                  ),
                },
              ],
              isError: true,
            };
          }
        } catch (error) {
          logger.error(`Error resolving tool scope for ${toolName}:`, error);
          return {
            content: [
              {
                type: "text",
                text: customErrorMessage(
                  toolName,
                  "Unable to verify namespace membership",
                ),
              },
            ],
            isError: true,
          };
        }
      }

      // Tool is allowed, call the original handler
      return handler(request, context);
    };
  };
}

/**
 * Utility function to clear cache
 */
export function clearFilterCache(_namespaceUuid?: string): void {
  // Compatibility hook: permissions are always read from current mappings.
}
