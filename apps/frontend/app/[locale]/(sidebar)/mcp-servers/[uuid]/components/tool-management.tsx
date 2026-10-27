"use client";

import { Tool } from "@repo/zod-types";
import { AlertTriangle, Database, RefreshCw, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { MakeRequestFn } from "@/hooks/useConnection";
import { useTranslations } from "@/hooks/useTranslations";
import { trpc } from "@/lib/trpc";

import { UnifiedToolsTable } from "./tools-data-table";

// MCP Tool type from the protocol
interface MCPTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface ToolManagementProps {
  mcpServerUuid: string;
  makeRequest: MakeRequestFn;
}

export function ToolManagement({ mcpServerUuid }: ToolManagementProps) {
  const [dbTools, setDbTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(false);
  const hasInitiallyFetched = useRef(false);
  const { t } = useTranslations();

  // Get tools from database
  const { data: dbToolsResponse, refetch: refetchDbTools } =
    trpc.frontend.tools.getByMcpServerUuid.useQuery({
      mcpServerUuid,
    });

  // A failed read or discovery must not replace the last successful display.
  useEffect(() => {
    if (dbToolsResponse?.success) setDbTools(dbToolsResponse.data);
  }, [dbToolsResponse]);

  const mcpTools: MCPTool[] = dbTools.map(
    (tool) =>
      tool.definition ?? {
        name: tool.name,
        description: tool.description ?? undefined,
        inputSchema: (tool.toolSchema ?? {
          type: "object",
        }) as MCPTool["inputSchema"],
      },
  );
  const { mutateAsync: refreshTools } =
    trpc.frontend.tools.refresh.useMutation();

  // Discovery and the atomic catalog replacement happen only on the server.
  // The Inspector connects to the raw server: do not discover a second time there.
  const fetchMCPTools = useCallback(async () => {
    setLoading(true);
    try {
      const response = await refreshTools({ mcpServerUuid });
      if (!response.success) {
        throw new Error(
          response.error || t("mcp-servers:tools.failedToFetchTools"),
        );
      }
      const result = await refetchDbTools();
      if (result.error) throw result.error;
      if (!result.data?.success) {
        throw new Error(t("mcp-servers:tools.failedToFetchTools"));
      }
      setDbTools(result.data.data);
      toast.success(
        t("mcp-servers:tools.foundToolsFromMcp", { count: response.count }),
      );
    } catch (error) {
      toast.error(t("mcp-servers:tools.failedToFetchTools"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, [mcpServerUuid, refreshTools, refetchDbTools, t]);

  // Auto-fetch tools when component mounts - but only once
  useEffect(() => {
    if (!hasInitiallyFetched.current) {
      hasInitiallyFetched.current = true;
      fetchMCPTools();
    }
  }, [fetchMCPTools]);

  // Calculate tool counts for display
  const mcpToolCount = mcpTools.length;
  const dbToolCount = dbTools.length;
  const newToolsCount = mcpTools.filter(
    (mcpTool) => !dbTools.some((dbTool) => dbTool.name === mcpTool.name),
  ).length;

  return (
    <div className="space-y-4">
      {/* Header with counts and actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wrench className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm font-medium">
            {t("mcp-servers:tools.overview")}:
          </span>
          <span className="text-sm text-muted-foreground">
            {mcpToolCount} {t("mcp-servers:tools.fromMcp")}
          </span>
          <span className="text-muted-foreground">•</span>
          <Database className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            {dbToolCount} {t("mcp-servers:tools.saved")}
          </span>
          {newToolsCount > 0 && (
            <>
              <span className="text-muted-foreground">•</span>
              <span className="text-sm text-amber-600 font-medium">
                {newToolsCount} {t("mcp-servers:tools.new")}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchMCPTools}
            disabled={loading}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`}
            />
            {t("mcp-servers:tools.refreshTools")}
          </Button>
        </div>
      </div>

      {/* Unified Tools Table */}
      <div className="rounded-lg border">
        <UnifiedToolsTable
          dbTools={dbTools}
          mcpTools={mcpTools}
          mcpServerUuid={mcpServerUuid}
          loading={loading}
          onRefreshMcpTools={fetchMCPTools}
        />
      </div>

      {/* Help text when no tools are available */}
      {!loading && mcpToolCount === 0 && dbToolCount === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <AlertTriangle className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
          <h4 className="text-sm font-medium">
            {t("mcp-servers:tools.noToolsAvailable")}
          </h4>
          <p className="text-xs text-muted-foreground mt-1">
            {t("mcp-servers:tools.noToolsDescription")}
          </p>
        </div>
      )}
    </div>
  );
}
