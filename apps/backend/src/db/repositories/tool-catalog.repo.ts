import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { and, eq, isNull, or } from "drizzle-orm";

import { db } from "../index";
import {
  mcpServersTable,
  namespaceServerMappingsTable,
  namespacesTable,
  toolsTable,
} from "../schema";
import { syncToolsInTransaction } from "./tools.repo";

export type CatalogSource = {
  uuid: string;
  name: string;
  forward_headers: Record<string, string> | null;
  user_id: string | null;
  revision: number;
  refreshedAt: Date | null;
};
export type CatalogRecord = { source: CatalogSource; tools: Tool[] };

// Never select connection credentials or launch parameters on the catalog path.
const sourceProjection = {
  uuid: mcpServersTable.uuid,
  name: mcpServersTable.name,
  forward_headers: mcpServersTable.forward_headers,
  user_id: mcpServersTable.user_id,
  revision: mcpServersTable.tool_catalog_revision,
  refreshedAt: mcpServersTable.tool_catalog_refreshed_at,
};
const toolProjection = {
  name: toolsTable.name,
  description: toolsTable.description,
  toolSchema: toolsTable.toolSchema,
  definition: toolsTable.definition,
};
const currentTools = and(
  eq(toolsTable.mcp_server_uuid, mcpServersTable.uuid),
  eq(toolsTable.catalog_revision, mcpServersTable.tool_catalog_revision),
);

type CatalogRow = {
  source: CatalogSource;
  tool: Pick<
    typeof toolsTable.$inferSelect,
    "name" | "description" | "toolSchema" | "definition"
  > | null;
};

function collectRecords(rows: CatalogRow[]): CatalogRecord[] {
  const records = new Map<string, CatalogRecord>();
  for (const { source, tool } of rows) {
    let record = records.get(source.uuid);
    if (!record) {
      record = { source, tools: [] };
      records.set(source.uuid, record);
    }
    if (tool) {
      record.tools.push(
        tool.definition ?? {
          name: tool.name,
          ...(tool.description == null
            ? {}
            : { description: tool.description }),
          inputSchema: tool.toolSchema,
        },
      );
    }
  }
  return [...records.values()];
}

export class ToolCatalogRepository {
  constructor(private readonly database: typeof db = db) {}

  async findByNamespace(
    namespaceUuid: string,
    includeInactiveServers = false,
  ): Promise<CatalogRecord[]> {
    // One statement gives a consistent source/revision/tools snapshot, not N+1.
    const rows = await this.database
      .select({ source: sourceProjection, tool: toolProjection })
      .from(mcpServersTable)
      .innerJoin(
        namespaceServerMappingsTable,
        eq(namespaceServerMappingsTable.mcp_server_uuid, mcpServersTable.uuid),
      )
      .innerJoin(
        namespacesTable,
        eq(namespacesTable.uuid, namespaceServerMappingsTable.namespace_uuid),
      )
      .leftJoin(toolsTable, currentTools)
      .where(
        and(
          eq(namespaceServerMappingsTable.namespace_uuid, namespaceUuid),
          // A historical mapping cannot grant access after either owner changes.
          // NULL namespace owners only match public servers via the first arm.
          or(
            isNull(mcpServersTable.user_id),
            eq(mcpServersTable.user_id, namespacesTable.user_id),
          ),
          includeInactiveServers
            ? undefined
            : eq(namespaceServerMappingsTable.status, "ACTIVE"),
        ),
      )
      .orderBy(mcpServersTable.uuid, toolsTable.name);
    return collectRecords(rows);
  }

  async findRevisionByServerUuid(
    serverUuid: string,
  ): Promise<number | undefined> {
    const [source] = await this.database
      .select({ revision: mcpServersTable.tool_catalog_revision })
      .from(mcpServersTable)
      .where(eq(mcpServersTable.uuid, serverUuid))
      .limit(1);
    return source?.revision;
  }

  async findByServerUuid(
    serverUuid: string,
  ): Promise<CatalogRecord | undefined> {
    const rows = await this.database
      .select({ source: sourceProjection, tool: toolProjection })
      .from(mcpServersTable)
      .leftJoin(toolsTable, currentTools)
      .where(eq(mcpServersTable.uuid, serverUuid))
      .orderBy(toolsTable.name);
    return collectRecords(rows)[0];
  }

  async publish(
    serverUuid: string,
    expectedRevision: number,
    tools: Tool[],
  ): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const [server] = await tx
        .select({ revision: mcpServersTable.tool_catalog_revision })
        .from(mcpServersTable)
        .where(eq(mcpServersTable.uuid, serverUuid))
        .for("update");
      if (!server || server.revision !== expectedRevision) return false;
      await syncToolsInTransaction(
        tx,
        { mcpServerUuid: serverUuid, tools },
        expectedRevision,
      );
      return true;
    });
  }
}

export const toolCatalogRepository = new ToolCatalogRepository();
