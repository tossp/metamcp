"use client";

import {
  ClientRequest,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { NamespaceTool, ToolStatusEnum } from "@repo/zod-types";
import { AlertTriangle, Database, RefreshCw, Wrench } from "lucide-react";
import React, { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { ToolManagementSkeleton } from "@/components/skeletons/tool-management-skeleton";
import { Button } from "@/components/ui/button";
import { MakeRequestFn } from "@/hooks/useConnection";
import { useTranslations } from "@/hooks/useTranslations";
import { trpc } from "@/lib/trpc";

import { EnhancedNamespaceToolsTable } from "./enhanced-namespace-tools-table";

interface NamespaceToolManagementProps {
  servers: Array<{
    uuid: string;
    name: string;
    status: string;
  }>;
  namespaceUuid: string;
  makeRequest?: MakeRequestFn; // Optional makeRequest function for MetaMCP connections
  sessionInitializing?: boolean; // Whether session initialization is in progress
}

export function NamespaceToolManagement({
  servers,
  namespaceUuid,
  makeRequest,
  sessionInitializing = false,
}: NamespaceToolManagementProps) {
  const [loading, setLoading] = useState(false);
  const [mcpTools, setMcpTools] = useState<
    Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }>
  >([]);
  const [namespaceTools, setNamespaceTools] = useState<NamespaceTool[]>([]);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const hasAttemptedInitialFetch = useRef(false);

  // Get translations
  const { t } = useTranslations();

  // Get tools from namespace tool mapping table
  const {
    data: toolsResponse,
    isLoading: isToolsLoading,
    refetch: refetchTools,
  } = trpc.frontend.namespaces.getTools.useQuery({
    namespaceUuid,
  });

  React.useEffect(() => {
    if (toolsResponse?.success) setNamespaceTools(toolsResponse.data);
  }, [toolsResponse]);

  const { mutateAsync: refreshTools } =
    trpc.frontend.tools.refresh.useMutation();
  const reportError = useCallback(
    (message: string) => {
      setRefreshError(message);
      toast.error(t("namespaces:toolManagement.toolsRefreshFailed"), {
        description: message,
      });
    },
    [t],
  );

  // Ordinary list is a display read, never a force refresh or a mapping write.
  // Let errors propagate so callers cannot report success or clear old tools.
  const fetchMetaMCPTools = useCallback(async () => {
    if (!makeRequest) return;
    const listToolsRequest: ClientRequest = {
      method: "tools/list",
      params: {},
    };
    const response = await makeRequest(
      listToolsRequest,
      ListToolsResultSchema,
      { suppressToast: true },
    );
    if (!response?.tools) {
      throw new Error(t("namespaces:toolManagement.fetchToolsError"));
    }
    setMcpTools(
      response.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
      })),
    );
  }, [makeRequest, t]);

  // Servers have already been prepared before joining the namespace.
  React.useEffect(() => {
    if (makeRequest && !hasAttemptedInitialFetch.current) {
      hasAttemptedInitialFetch.current = true;
      fetchMetaMCPTools().catch((error: unknown) => {
        reportError(error instanceof Error ? error.message : String(error));
      });
    }
  }, [makeRequest, fetchMetaMCPTools, reportError]);

  const handleRefreshAllTools = async () => {
    setLoading(true);
    setRefreshError(null);
    const errors: string[] = [];
    try {
      const response = await refreshTools({ namespaceUuid });
      for (const result of response.results ?? []) {
        if (!result.success) {
          const server = servers.find(
            (server) => server.uuid === result.serverUuid,
          );
          errors.push(
            `${server?.name ?? result.serverUuid}: ${result.error || t("namespaces:toolManagement.toolsRefreshFailed")}`,
          );
        }
      }
      if (!response.success || errors.length > 0) {
        if (response.error) errors.unshift(response.error);
        if (errors.length === 0) {
          errors.push(t("namespaces:toolManagement.toolsRefreshFailed"));
        }
      }

      // Read the committed catalogs, including the retained catalogs of failed
      // servers. Never rewrite namespace status/overrides from a list response.
      const result = await refetchTools();
      if (result.error) throw result.error;
      if (!result.data?.success) {
        throw new Error(t("namespaces:toolManagement.fetchToolsError"));
      }
      setNamespaceTools(result.data.data);
      if (makeRequest) {
        await fetchMetaMCPTools();
      } else if (errors.length === 0) {
        // Without an Inspector connection, the DB table is the display source.
        setMcpTools([]);
      }

      if (errors.length > 0) {
        reportError(errors.join("\n"));
      } else {
        toast.success(t("namespaces:toolManagement.toolsRefreshed"), {
          description: t("namespaces:toolManagement.toolsRefreshedDescription"),
        });
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      reportError(errors.join("\n"));
    } finally {
      setLoading(false);
    }
  };

  // Calculate counts
  const serverCount = servers.length;
  const activeServerCount = servers.filter(
    (s) => s.status === ToolStatusEnum.enum.ACTIVE,
  ).length;
  const savedToolCount = namespaceTools.length;
  const activeToolCount = namespaceTools.filter(
    (t) => t.status === ToolStatusEnum.enum.ACTIVE,
  ).length;
  const mcpToolCount = mcpTools.length;

  // Calculate new tools count by comparing MetaMCP tools with saved tools
  // Parse the server__toolName format to get the actual tool name for comparison
  const newToolsCount = mcpTools.filter((mcpTool) => {
    const lastDoubleUnderscoreIndex = mcpTool.name.lastIndexOf("__");
    if (lastDoubleUnderscoreIndex === -1) return false;

    const serverName = mcpTool.name.substring(0, lastDoubleUnderscoreIndex);
    let actualToolName = mcpTool.name.substring(lastDoubleUnderscoreIndex + 2);

    // Handle nested MetaMCP scenarios - get actual server names from saved tools
    const actualServerNames = new Set(
      namespaceTools.map((tool) => tool.serverName),
    );

    if (!actualServerNames.has(serverName) && serverName.includes("__")) {
      const firstDoubleUnderscoreIndex = serverName.indexOf("__");
      const actualServerName = serverName.substring(
        0,
        firstDoubleUnderscoreIndex,
      );

      if (actualServerNames.has(actualServerName)) {
        // This is a nested MetaMCP tool - adjust parsing
        const nestedPart = serverName.substring(firstDoubleUnderscoreIndex + 2);
        actualToolName = `${nestedPart}__${actualToolName}`;
      }
    }

    return !namespaceTools.some(
      (savedTool) => savedTool.name === actualToolName,
    );
  }).length;

  // Show loading skeleton when initially loading
  if (isToolsLoading || loading) {
    return (
      <div className="space-y-4">
        {/* Header with counts and actions */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wrench className="h-5 w-5 text-muted-foreground" />
            <span className="text-sm font-medium">
              {t("namespaces:toolManagement.toolsOverview")}
            </span>
            <span className="text-sm text-muted-foreground">
              {serverCount} {t("namespaces:toolManagement.servers")}
            </span>
            <span className="text-muted-foreground">•</span>
            <span className="text-sm text-muted-foreground">
              {activeServerCount} {t("namespaces:toolManagement.active")}
            </span>
            <span className="text-muted-foreground">•</span>
            <Wrench className="h-4 w-4 text-blue-500" />
            <span className="text-sm text-muted-foreground">
              {mcpToolCount} {t("namespaces:toolManagement.fromMetaMCP")}
            </span>
            <span className="text-muted-foreground">•</span>
            <Database className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {savedToolCount} {t("namespaces:toolManagement.saved")}
            </span>
            <span className="text-muted-foreground">•</span>
            <span className="text-sm text-muted-foreground">
              {activeToolCount} {t("namespaces:toolManagement.active")}
            </span>
            {newToolsCount > 0 && (
              <>
                <span className="text-muted-foreground">•</span>
                <span className="text-sm text-amber-600 font-medium">
                  {newToolsCount} {t("namespaces:toolManagement.new")}
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefreshAllTools}
              disabled={true}
            >
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              {sessionInitializing
                ? t("namespaces:toolManagement.initializing")
                : t("namespaces:toolManagement.refreshTools")}
            </Button>
          </div>
        </div>

        {/* Loading skeleton */}
        <div className="rounded-lg border">
          <ToolManagementSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header with counts and actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wrench className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm font-medium">
            {t("namespaces:toolManagement.toolsOverview")}
          </span>
          <span className="text-sm text-muted-foreground">
            {serverCount} {t("namespaces:toolManagement.servers")}
          </span>
          <span className="text-muted-foreground">•</span>
          <span className="text-sm text-muted-foreground">
            {activeServerCount} {t("namespaces:toolManagement.active")}
          </span>
          <span className="text-muted-foreground">•</span>
          <Wrench className="h-4 w-4 text-blue-500" />
          <span className="text-sm text-muted-foreground">
            {mcpToolCount} {t("namespaces:toolManagement.fromMetaMCP")}
          </span>
          <span className="text-muted-foreground">•</span>
          <Database className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            {savedToolCount} {t("namespaces:toolManagement.saved")}
          </span>
          <span className="text-muted-foreground">•</span>
          <span className="text-sm text-muted-foreground">
            {activeToolCount} {t("namespaces:toolManagement.active")}
          </span>
          {newToolsCount > 0 && (
            <>
              <span className="text-muted-foreground">•</span>
              <span className="text-sm text-amber-600 font-medium">
                {newToolsCount} {t("namespaces:toolManagement.new")}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefreshAllTools}
            disabled={loading || isToolsLoading || sessionInitializing}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${loading || isToolsLoading || sessionInitializing ? "animate-spin" : ""}`}
            />
            {sessionInitializing
              ? t("namespaces:toolManagement.initializing")
              : t("namespaces:toolManagement.refreshTools")}
          </Button>
        </div>
      </div>

      {refreshError && (
        <div
          role="alert"
          className="rounded-lg border border-destructive p-4 text-sm"
        >
          <p className="font-medium">
            {t("namespaces:toolManagement.toolsRefreshFailed")}
          </p>
          <p className="whitespace-pre-wrap">{refreshError}</p>
        </div>
      )}

      {/* Show table when tools are available, or single empty state when no tools */}
      {savedToolCount > 0 || mcpToolCount > 0 ? (
        <div className="rounded-lg border">
          <EnhancedNamespaceToolsTable
            savedTools={namespaceTools}
            mcpTools={mcpTools}
            loading={false} // We handle loading state above
            onRefreshTools={handleRefreshAllTools}
            namespaceUuid={namespaceUuid}
            servers={servers}
            sessionInitializing={sessionInitializing}
          />
        </div>
      ) : (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <AlertTriangle className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
          <h4 className="text-sm font-medium">
            {t("namespaces:toolManagement.noToolsAvailable")}
          </h4>
          <p className="text-xs text-muted-foreground mt-1">
            {t("namespaces:toolManagement.noToolsDescription")}
          </p>
        </div>
      )}
    </div>
  );
}
