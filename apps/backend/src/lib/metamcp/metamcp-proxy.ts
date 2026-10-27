import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  GetPromptResultSchema,
  ListPromptsRequestSchema,
  ListPromptsResult,
  ListPromptsResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResult,
  ListResourcesResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/types.js";

import logger from "@/utils/logger";

import { namespacesRepository } from "../../db/repositories/namespaces.repo";
import { toolCatalogRepository } from "../../db/repositories/tool-catalog.repo";
import { getAdminToolsContext } from "../admin-mcp/admin-session-context";
import {
  executeAdminTool,
  getAdminToolsForMcp,
  isExposedAdminToolName,
} from "../admin-mcp/tools-registry";
import { createCatalogToolHandlers } from "./catalog-tool-handlers";
import { ConnectedClient } from "./client";
import { getMcpServers } from "./fetch-metamcp";
import { extractForwardedHeaders, mergeHeaders } from "./header-forwarding";
import { requestWithSessionRecovery } from "./list-handler-recovery";
import { mcpServerPool } from "./mcp-server-pool";
import { createAuditCallToolMiddleware } from "./metamcp-middleware/audit-requests.functional";
import {
  createFilterCallToolMiddleware,
  createFilterListToolsMiddleware,
} from "./metamcp-middleware/filter-tools.functional";
import {
  compose,
  MetaMCPHandlerContext,
} from "./metamcp-middleware/functional-middleware";
import { resolveToolIdentity } from "./metamcp-middleware/tool-identity";
import {
  createToolOverridesCallToolMiddleware,
  createToolOverridesListToolsMiddleware,
} from "./metamcp-middleware/tool-overrides.functional";
import { formatToolCallError } from "./tool-call-error";
import { subscribeToolCatalog } from "./tool-catalog-events";
import { parseToolName } from "./tool-name-parser";
import { sanitizeName } from "./utils";

export const createServer = async (
  namespaceUuid: string,
  sessionId: string,
  includeInactiveServers: boolean = false,
  clientRequestHeaders?: Record<string, string>,
  requestContext?: Pick<MetaMCPHandlerContext, "endpointName" | "auth">,
) => {
  const promptToClient: Record<string, ConnectedClient> = {};
  const resourceToClient: Record<string, ConnectedClient> = {};

  // Helper function to detect if a server is the same instance
  const isSameServerInstance = (
    params: { name?: string; url?: string | null },
    _serverUuid: string,
  ): boolean => {
    // Check if server name is exactly the same as our current server instance
    // This prevents exact recursive calls to the same server
    if (params.name === `metamcp-unified-${namespaceUuid}`) {
      return true;
    }

    return false;
  };

  const namespace = await namespacesRepository.findByUuid(namespaceUuid);

  const server = new Server(
    {
      name: `metamcp-unified-${namespaceUuid}`,
      version: "1.0.0",
    },
    {
      capabilities: {
        prompts: {},
        resources: {},
        tools: { listChanged: true },
      },
      instructions: namespace?.description ?? undefined,
    },
  );

  // Create the handler context.
  // NOTE: clientRequestHeaders are captured once at session initialisation
  // (StreamableHTTP) or connection time (SSE). They are NOT refreshed on
  // subsequent requests within the same session. This is acceptable because
  // headers like Authorization are stable for a session's lifetime, but
  // callers should be aware of this if session-scoped header staleness
  // could be a concern.
  const handlerContext: MetaMCPHandlerContext = {
    namespaceUuid,
    sessionId,
    clientRequestHeaders,
    endpointName: requestContext?.endpointName || "unknown",
    auth: requestContext?.auth,
  };

  const { list: originalListToolsHandler, call: originalCallToolHandler } =
    createCatalogToolHandlers(namespaceUuid, sessionId, includeInactiveServers);

  // Compose middleware with handlers - this is the Express-like functional approach
  const listToolsWithMiddleware = compose(
    createToolOverridesListToolsMiddleware({ cacheEnabled: false }),
    createFilterListToolsMiddleware({ cacheEnabled: false }),
    // Add more middleware here as needed
    // createLoggingMiddleware(),
    // createRateLimitingMiddleware(),
  )(originalListToolsHandler);

  const callToolWithMiddleware = compose(
    createAuditCallToolMiddleware({ resolveToolIdentity }),
    createToolOverridesCallToolMiddleware({ cacheEnabled: false }),
    createFilterCallToolMiddleware({
      cacheEnabled: false,
      customErrorMessage: (toolName, reason) =>
        `Access denied to tool "${toolName}": ${reason}`,
    }),
    // Add more middleware here as needed
    // createAuthorizationMiddleware(),
  )(originalCallToolHandler);

  // Set up the handlers with middleware
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const result = await listToolsWithMiddleware(request, handlerContext);
    const adminContext = getAdminToolsContext(handlerContext.sessionId);

    if (adminContext?.enabled && adminContext.userId) {
      result.tools.push(...getAdminToolsForMcp());
    }

    return result;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (isExposedAdminToolName(request.params.name)) {
      const adminContext = getAdminToolsContext(handlerContext.sessionId);
      if (!adminContext?.enabled || !adminContext.userId) {
        throw new Error(
          `Access denied to MetaMCP admin tool: ${request.params.name}`,
        );
      }

      return executeAdminTool(
        request.params.name,
        adminContext.userId,
        request.params.arguments,
      );
    }

    try {
      return await callToolWithMiddleware(request, handlerContext);
    } catch (error) {
      // Recovery and audit middleware see the original error. Translate only
      // at the consumer boundary, retaining raw diagnostics in server logs.
      logger.error(`Tool call failed: ${request.params.name}`, error);
      throw formatToolCallError(error, request.params.name);
    }
  });

  // Get Prompt Handler
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    const clientForPrompt = promptToClient[name];

    if (!clientForPrompt) {
      throw new Error(`Unknown prompt: ${name}`);
    }

    try {
      // Parse the prompt name using shared utility
      const parsed = parseToolName(name);
      if (!parsed) {
        throw new Error(`Invalid prompt name format: ${name}`);
      }

      const promptName = parsed.originalToolName;
      const response = await clientForPrompt.client.request(
        {
          method: "prompts/get",
          params: {
            name: promptName,
            arguments: request.params.arguments || {},
            _meta: request.params._meta,
          },
        },
        GetPromptResultSchema,
      );

      return response;
    } catch (error) {
      logger.error(
        `Error getting prompt through ${
          clientForPrompt.client.getServerVersion()?.name
        }:`,
        error,
      );
      throw error;
    }
  });

  // List Prompts Handler
  server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    const serverParams = await getMcpServers(
      namespaceUuid,
      includeInactiveServers,
    );
    const allPrompts: ListPromptsResult["prompts"] = [];
    const failedServers: string[] = [];

    // Extract forwarded headers from client request for servers that need them
    const forwardedHeadersByServer = handlerContext.clientRequestHeaders
      ? extractForwardedHeaders(
          handlerContext.clientRequestHeaders,
          serverParams,
        )
      : {};

    // Track visited servers to detect circular references - reset on each call
    const visitedServers = new Set<string>();

    // Filter out self-referencing servers before processing
    const validPromptServers = Object.entries(serverParams).filter(
      ([uuid, params]) => {
        // Skip if we've already visited this server to prevent circular references
        if (visitedServers.has(uuid)) {
          logger.info(
            `Skipping already visited server in prompts: ${params.name || uuid}`,
          );
          return false;
        }

        // Check if this server is the same instance to prevent self-referencing
        if (isSameServerInstance(params, uuid)) {
          logger.info(
            `Skipping self-referencing server in prompts: ${params.name || uuid}`,
          );
          return false;
        }

        // Mark this server as visited
        visitedServers.add(uuid);
        return true;
      },
    );

    await Promise.allSettled(
      validPromptServers.map(async ([uuid, params]) => {
        // Merge forwarded headers into server params for this session
        const effectiveParams = forwardedHeadersByServer[uuid]
          ? {
              ...params,
              headers: mergeHeaders(
                params.headers,
                forwardedHeadersByServer[uuid],
              ),
            }
          : params;

        const session = await mcpServerPool.getSession(
          sessionId,
          uuid,
          effectiveParams,
          namespaceUuid,
        );
        if (!session) {
          logger.error(
            `prompts/list: no session available for server ${params.name || uuid} — excluded from namespace response (error state, connection cap, or backend unreachable)`,
          );
          failedServers.push(params.name || uuid);
          return;
        }

        // Now check for self-referencing using the actual MCP server name
        const serverVersion = session.client.getServerVersion();
        const actualServerName = serverVersion?.name || params.name || "";
        const ourServerName = `metamcp-unified-${namespaceUuid}`;

        if (actualServerName === ourServerName) {
          logger.info(
            `Skipping self-referencing MetaMCP server in prompts: "${actualServerName}"`,
          );
          return;
        }

        const capabilities = session.client.getServerCapabilities();
        if (!capabilities?.prompts) return;

        // Use name assigned by user, fallback to name from server
        const serverName =
          params.name || session.client.getServerVersion()?.name || "";
        try {
          let activeSession = session;
          const result = await requestWithSessionRecovery({
            pool: mcpServerPool,
            sessionId,
            serverUuid: uuid,
            params: effectiveParams,
            namespaceUuid,
            operation: "prompts/list",
            serverName,
            session,
            attempt: (active) =>
              active.client.request(
                {
                  method: "prompts/list",
                  params: {
                    cursor: request.params?.cursor,
                    _meta: request.params?._meta,
                  },
                },
                ListPromptsResultSchema,
              ),
            onFreshSession: (fresh) => {
              activeSession = fresh;
            },
          });

          if (result.prompts) {
            const promptsWithSource = result.prompts.map((prompt) => {
              const promptName = `${sanitizeName(serverName)}__${prompt.name}`;
              promptToClient[promptName] = activeSession;
              return {
                ...prompt,
                name: promptName,
                description: prompt.description || "",
              };
            });
            allPrompts.push(...promptsWithSource);
          }
        } catch (error) {
          logger.error(`Error fetching prompts from: ${serverName}`, error);
          failedServers.push(serverName || uuid);
        }
      }),
    );

    if (failedServers.length > 0) {
      logger.error(
        `prompts/list DEGRADED for namespace ${namespaceUuid}: ${failedServers.length} backend server(s) failed (${failedServers.join(", ")}); returning ${allPrompts.length} prompts`,
      );
    }

    return {
      prompts: allPrompts,
      nextCursor: request.params?.cursor,
    };
  });

  // List Resources Handler
  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const serverParams = await getMcpServers(
      namespaceUuid,
      includeInactiveServers,
    );
    const allResources: ListResourcesResult["resources"] = [];
    const failedServers: string[] = [];

    // Extract forwarded headers from client request for servers that need them
    const forwardedHeadersByServer = handlerContext.clientRequestHeaders
      ? extractForwardedHeaders(
          handlerContext.clientRequestHeaders,
          serverParams,
        )
      : {};

    // Track visited servers to detect circular references - reset on each call
    const visitedServers = new Set<string>();

    // Filter out self-referencing servers before processing
    const validResourceServers = Object.entries(serverParams).filter(
      ([uuid, params]) => {
        // Skip if we've already visited this server to prevent circular references
        if (visitedServers.has(uuid)) {
          logger.info(
            `Skipping already visited server in resources: ${params.name || uuid}`,
          );
          return false;
        }

        // Check if this server is the same instance to prevent self-referencing
        if (isSameServerInstance(params, uuid)) {
          logger.info(
            `Skipping self-referencing server in resources: ${params.name || uuid}`,
          );
          return false;
        }

        // Mark this server as visited
        visitedServers.add(uuid);
        return true;
      },
    );

    await Promise.allSettled(
      validResourceServers.map(async ([uuid, params]) => {
        // Merge forwarded headers into server params for this session
        const effectiveParams = forwardedHeadersByServer[uuid]
          ? {
              ...params,
              headers: mergeHeaders(
                params.headers,
                forwardedHeadersByServer[uuid],
              ),
            }
          : params;

        const session = await mcpServerPool.getSession(
          sessionId,
          uuid,
          effectiveParams,
          namespaceUuid,
        );
        if (!session) {
          logger.error(
            `resources/list: no session available for server ${params.name || uuid} — excluded from namespace response (error state, connection cap, or backend unreachable)`,
          );
          failedServers.push(params.name || uuid);
          return;
        }

        // Now check for self-referencing using the actual MCP server name
        const serverVersion = session.client.getServerVersion();
        const actualServerName = serverVersion?.name || params.name || "";
        const ourServerName = `metamcp-unified-${namespaceUuid}`;

        if (actualServerName === ourServerName) {
          logger.info(
            `Skipping self-referencing MetaMCP server in resources: "${actualServerName}"`,
          );
          return;
        }

        const capabilities = session.client.getServerCapabilities();
        if (!capabilities?.resources) return;

        // Use name assigned by user, fallback to name from server
        const serverName =
          params.name || session.client.getServerVersion()?.name || "";
        try {
          let activeSession = session;
          const result = await requestWithSessionRecovery({
            pool: mcpServerPool,
            sessionId,
            serverUuid: uuid,
            params: effectiveParams,
            namespaceUuid,
            operation: "resources/list",
            serverName,
            session,
            attempt: (active) =>
              active.client.request(
                {
                  method: "resources/list",
                  params: {
                    cursor: request.params?.cursor,
                    _meta: request.params?._meta,
                  },
                },
                ListResourcesResultSchema,
              ),
            onFreshSession: (fresh) => {
              activeSession = fresh;
            },
          });

          if (result.resources) {
            const resourcesWithSource = result.resources.map((resource) => {
              resourceToClient[resource.uri] = activeSession;
              return {
                ...resource,
                name: resource.name || "",
              };
            });
            allResources.push(...resourcesWithSource);
          }
        } catch (error) {
          logger.error(`Error fetching resources from: ${serverName}`, error);
          failedServers.push(serverName || uuid);
        }
      }),
    );

    if (failedServers.length > 0) {
      logger.error(
        `resources/list DEGRADED for namespace ${namespaceUuid}: ${failedServers.length} backend server(s) failed (${failedServers.join(", ")}); returning ${allResources.length} resources`,
      );
    }

    return {
      resources: allResources,
      nextCursor: request.params?.cursor,
    };
  });

  // Read Resource Handler
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const clientForResource = resourceToClient[uri];

    if (!clientForResource) {
      throw new Error(`Unknown resource: ${uri}`);
    }

    try {
      return await clientForResource.client.request(
        {
          method: "resources/read",
          params: {
            uri,
            _meta: request.params._meta,
          },
        },
        ReadResourceResultSchema,
      );
    } catch (error) {
      logger.error(
        `Error reading resource through ${
          clientForResource.client.getServerVersion()?.name
        }:`,
        error,
      );
      throw error;
    }
  });

  // List Resource Templates Handler
  server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async (request) => {
      const serverParams = await getMcpServers(
        namespaceUuid,
        includeInactiveServers,
      );
      const allTemplates: ResourceTemplate[] = [];
      const failedServers: string[] = [];

      // Track visited servers to detect circular references - reset on each call
      const visitedServers = new Set<string>();

      // Filter out self-referencing servers before processing
      // Extract forwarded headers from client request for servers that need them
      const forwardedHeadersByServer = handlerContext.clientRequestHeaders
        ? extractForwardedHeaders(
            handlerContext.clientRequestHeaders,
            serverParams,
          )
        : {};

      const validTemplateServers = Object.entries(serverParams).filter(
        ([uuid, params]) => {
          // Skip if we've already visited this server to prevent circular references
          if (visitedServers.has(uuid)) {
            logger.info(
              `Skipping already visited server in resource templates: ${params.name || uuid}`,
            );
            return false;
          }

          // Check if this server is the same instance to prevent self-referencing
          if (isSameServerInstance(params, uuid)) {
            logger.info(
              `Skipping self-referencing server in resource templates: ${params.name || uuid}`,
            );
            return false;
          }

          // Mark this server as visited
          visitedServers.add(uuid);
          return true;
        },
      );

      await Promise.allSettled(
        validTemplateServers.map(async ([uuid, params]) => {
          // Merge forwarded headers into server params for this session
          const effectiveParams = forwardedHeadersByServer[uuid]
            ? {
                ...params,
                headers: mergeHeaders(
                  params.headers,
                  forwardedHeadersByServer[uuid],
                ),
              }
            : params;

          const session = await mcpServerPool.getSession(
            sessionId,
            uuid,
            effectiveParams,
            namespaceUuid,
          );
          if (!session) {
            logger.error(
              `resources/templates/list: no session available for server ${params.name || uuid} — excluded from namespace response (error state, connection cap, or backend unreachable)`,
            );
            failedServers.push(params.name || uuid);
            return;
          }

          // Now check for self-referencing using the actual MCP server name
          const serverVersion = session.client.getServerVersion();
          const actualServerName = serverVersion?.name || params.name || "";
          const ourServerName = `metamcp-unified-${namespaceUuid}`;

          if (actualServerName === ourServerName) {
            logger.info(
              `Skipping self-referencing MetaMCP server in resource templates: "${actualServerName}"`,
            );
            return;
          }

          const capabilities = session.client.getServerCapabilities();
          if (!capabilities?.resources) return;

          const serverName =
            params.name || session.client.getServerVersion()?.name || "";

          try {
            // No per-client map to repoint here (templates aren't keyed to a
            // client), so onFreshSession is omitted — the recovery still
            // invalidates + retries on the fresh session.
            const result = await requestWithSessionRecovery({
              pool: mcpServerPool,
              sessionId,
              serverUuid: uuid,
              params: effectiveParams,
              namespaceUuid,
              operation: "resources/templates/list",
              serverName,
              session,
              attempt: (active) =>
                active.client.request(
                  {
                    method: "resources/templates/list",
                    params: {
                      cursor: request.params?.cursor,
                      _meta: request.params?._meta,
                    },
                  },
                  ListResourceTemplatesResultSchema,
                ),
            });

            if (result.resourceTemplates) {
              const templatesWithSource = result.resourceTemplates.map(
                (template) => ({
                  ...template,
                  name: template.name || "",
                }),
              );
              allTemplates.push(...templatesWithSource);
            }
          } catch (error) {
            logger.error(
              `Error fetching resource templates from: ${serverName}`,
              error,
            );
            failedServers.push(serverName || uuid);
            return;
          }
        }),
      );

      if (failedServers.length > 0) {
        logger.error(
          `resources/templates/list DEGRADED for namespace ${namespaceUuid}: ${failedServers.length} backend server(s) failed (${failedServers.join(", ")}); returning ${allTemplates.length} templates`,
        );
      }

      return {
        resourceTemplates: allTemplates,
        nextCursor: request.params?.cursor,
      };
    },
  );

  const unsubscribeCatalog = subscribeToolCatalog(async (serverUuid) => {
    const members = await toolCatalogRepository.findByNamespace(
      namespaceUuid,
      includeInactiveServers,
    );
    if (members.some(({ source }) => source.uuid === serverUuid)) {
      await server.sendToolListChanged();
    }
  });
  const previousOnClose = server.onclose;
  server.onclose = () => {
    unsubscribeCatalog();
    previousOnClose?.();
  };
  const cleanup = async () => {
    unsubscribeCatalog();
    await mcpServerPool.cleanupSession(sessionId);
  };

  return { server, cleanup, internalSessionId: sessionId };
};
