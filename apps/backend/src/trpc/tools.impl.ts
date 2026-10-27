import {
  CreateToolRequestSchema,
  CreateToolResponseSchema,
  GetToolsByMcpServerUuidRequestSchema,
  GetToolsByMcpServerUuidResponseSchema,
  McpToolSchema,
  RefreshToolsRequestSchema,
  RefreshToolsResponseSchema,
} from "@repo/zod-types";
import { z } from "zod";

import logger from "@/utils/logger";

import { namespacesRepository, toolsRepository } from "../db/repositories";
import { toolCatalogRepository } from "../db/repositories/tool-catalog.repo";
import { ToolsSerializer } from "../db/serializers";
import { refreshCatalogTools } from "../lib/metamcp/tool-catalog";
import { notifyToolCatalogChanged } from "../lib/metamcp/tool-catalog-events";

type ToolInput = z.infer<typeof CreateToolRequestSchema>;
const unavailable = "Tool catalog is not available";

async function accessibleCatalog(serverUuid: string, userId: string) {
  if (!userId) return undefined;
  const record = await toolCatalogRepository.findByServerUuid(serverUuid);
  return record &&
    (record.source.user_id === null || record.source.user_id === userId)
    ? record
    : undefined;
}

async function saveTools(input: ToolInput, userId: string, replace: boolean) {
  const record = await accessibleCatalog(input.mcpServerUuid, userId);
  // Public directories must be discovered by the server, not supplied by any reader.
  if (!record || record.source.user_id !== userId) {
    return { success: false, count: 0, error: unavailable };
  }
  const incoming = input.tools.map((tool) =>
    McpToolSchema.parse({
      ...tool,
      inputSchema: { ...tool.inputSchema, type: "object" },
    }),
  );
  const tools = replace
    ? incoming
    : [
        ...new Map(
          [...record.tools, ...incoming].map((tool) => [tool.name, tool]),
        ).values(),
      ];
  const saved = await toolCatalogRepository.publish(
    record.source.uuid,
    record.source.revision,
    tools,
  );
  if (!saved)
    return {
      success: false,
      count: 0,
      error: "Tool configuration changed; retry the update",
    };
  notifyToolCatalogChanged(record.source.uuid);
  return { success: true, count: incoming.length };
}

export const toolsImplementations = {
  getByMcpServerUuid: async (
    input: z.infer<typeof GetToolsByMcpServerUuidRequestSchema>,
    userId: string,
  ): Promise<z.infer<typeof GetToolsByMcpServerUuidResponseSchema>> => {
    try {
      if (!(await accessibleCatalog(input.mcpServerUuid, userId))) {
        return { success: false, data: [], message: unavailable };
      }
      const tools = await toolsRepository.findByMcpServerUuid(
        input.mcpServerUuid,
      );
      return { success: true, data: ToolsSerializer.serializeToolList(tools) };
    } catch {
      logger.error("Tool catalog read failed");
      return { success: false, data: [], message: unavailable };
    }
  },

  create: async (
    input: ToolInput,
    userId: string,
  ): Promise<z.infer<typeof CreateToolResponseSchema>> => {
    try {
      return await saveTools(input, userId, false);
    } catch {
      logger.error("Tool catalog save failed");
      return {
        success: false,
        count: 0,
        error: "Tool catalog could not be saved",
      };
    }
  },

  sync: async (
    input: ToolInput,
    userId: string,
  ): Promise<z.infer<typeof CreateToolResponseSchema>> => {
    try {
      return await saveTools(input, userId, true);
    } catch {
      logger.error("Tool catalog sync failed");
      return {
        success: false,
        count: 0,
        error: "Tool catalog could not be saved",
      };
    }
  },

  refresh: async (
    input: z.infer<typeof RefreshToolsRequestSchema>,
    userId: string,
  ): Promise<z.infer<typeof RefreshToolsResponseSchema>> => {
    try {
      let serverUuids: string[];
      if (input.mcpServerUuid) {
        const record = await accessibleCatalog(input.mcpServerUuid, userId);
        if (!record) return { success: false, count: 0, error: unavailable };
        serverUuids = [record.source.uuid];
      } else if (input.namespaceUuid) {
        const namespace = await namespacesRepository.findByUuid(
          input.namespaceUuid,
        );
        if (
          !userId ||
          !namespace ||
          (namespace.user_id !== null && namespace.user_id !== userId)
        ) {
          return { success: false, count: 0, error: unavailable };
        }
        const records = await toolCatalogRepository.findByNamespace(
          input.namespaceUuid,
        );
        serverUuids = records
          .filter(
            ({ source }) =>
              source.user_id === null || source.user_id === userId,
          )
          .map(({ source }) => source.uuid);
        if (records.length !== serverUuids.length) {
          return { success: false, count: 0, error: unavailable };
        }
      } else {
        return { success: false, count: 0, error: unavailable };
      }
      const results = await Promise.all(
        serverUuids.map((uuid) => refreshCatalogTools(uuid)),
      );
      const success = results.every((result) => result.success);
      return {
        success,
        count: results.reduce((sum, result) => sum + result.count, 0),
        results,
        ...(!success
          ? { error: "Some tool catalogs could not be refreshed" }
          : {}),
      };
    } catch {
      logger.error("Tool catalog refresh failed");
      return { success: false, count: 0, error: "Tool catalog refresh failed" };
    }
  },
};
