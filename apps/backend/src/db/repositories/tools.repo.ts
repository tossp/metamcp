import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  DatabaseTool,
  ToolCreateInput,
  ToolUpsertInput,
} from "@repo/zod-types";
import { and, eq, getTableColumns, notInArray, sql } from "drizzle-orm";

import { db } from "../index";
import {
  mcpServersTable,
  namespaceServerMappingsTable,
  namespaceToolMappingsTable,
  toolsTable,
} from "../schema";

type Database = typeof db;
export type ToolCatalogTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];
type ToolWriter = Pick<Database, "insert" | "delete">;

async function upsertTools(
  writer: ToolWriter,
  input: ToolUpsertInput,
  revision: number,
): Promise<DatabaseTool[]> {
  if (input.tools.length === 0) return [];

  // The protocol identifies tools by name. Deduplicate before a multi-row UPSERT.
  const definitions = new Map<string, Tool>();
  for (const tool of input.tools) {
    const { description, ...rest } = tool;
    definitions.set(tool.name, {
      ...rest,
      ...(description == null ? {} : { description }),
      inputSchema: { ...tool.inputSchema, type: "object" },
    });
  }
  return writer
    .insert(toolsTable)
    .values(
      [...definitions.values()].map((definition) => ({
        name: definition.name,
        description: definition.description ?? null,
        toolSchema: definition.inputSchema,
        definition,
        catalog_revision: revision,
        mcp_server_uuid: input.mcpServerUuid,
      })),
    )
    .onConflictDoUpdate({
      target: [toolsTable.mcp_server_uuid, toolsTable.name],
      set: {
        description: sql`excluded.description`,
        toolSchema: sql`excluded.tool_schema`,
        definition: sql`excluded.definition`,
        catalog_revision: sql`excluded.catalog_revision`,
        updated_at: new Date(),
      },
    })
    .returning();
}

async function deleteObsoleteTools(
  writer: ToolWriter,
  serverUuid: string,
  names: string[],
): Promise<DatabaseTool[]> {
  return writer
    .delete(toolsTable)
    .where(
      and(
        eq(toolsTable.mcp_server_uuid, serverUuid),
        names.length ? notInArray(toolsTable.name, names) : undefined,
      ),
    )
    .returning();
}

/** Caller must hold the server row lock in this transaction. */
export async function syncToolsInTransaction(
  tx: ToolCatalogTransaction,
  input: ToolUpsertInput,
  revision: number,
): Promise<{ upserted: DatabaseTool[]; deleted: DatabaseTool[] }> {
  // UPSERT preserves UUIDs and namespace overrides for every surviving name.
  const upserted = await upsertTools(tx, input, revision);
  const deleted = await deleteObsoleteTools(
    tx,
    input.mcpServerUuid,
    input.tools.map((tool) => tool.name),
  );
  if (input.tools.length > 0) {
    // Fill only missing mappings in every associated namespace. Existing
    // disabled status and overrides belong to the user and must never reset.
    // Explicit columns let PostgreSQL apply defaults for all other fields;
    // Drizzle's insert-select builder requires the full table column set.
    await tx.execute(sql`insert into ${namespaceToolMappingsTable}
      ("namespace_uuid", "tool_uuid", "mcp_server_uuid")
      select ${namespaceServerMappingsTable.namespace_uuid},
        ${toolsTable.uuid}, ${toolsTable.mcp_server_uuid}
      from ${namespaceServerMappingsTable}
      inner join ${toolsTable}
        on ${toolsTable.mcp_server_uuid} = ${namespaceServerMappingsTable.mcp_server_uuid}
      where ${toolsTable.mcp_server_uuid} = ${input.mcpServerUuid}
      on conflict ("namespace_uuid", "tool_uuid") do nothing`);
  }
  await tx
    .update(mcpServersTable)
    .set({ tool_catalog_refreshed_at: new Date() })
    .where(eq(mcpServersTable.uuid, input.mcpServerUuid));
  return { upserted, deleted };
}

export class ToolsRepository {
  constructor(private readonly database: Database = db) {}

  async findByMcpServerUuid(mcpServerUuid: string): Promise<DatabaseTool[]> {
    return this.database
      .select(getTableColumns(toolsTable))
      .from(toolsTable)
      .innerJoin(
        mcpServersTable,
        eq(mcpServersTable.uuid, toolsTable.mcp_server_uuid),
      )
      .where(
        and(
          eq(toolsTable.mcp_server_uuid, mcpServerUuid),
          eq(
            toolsTable.catalog_revision,
            mcpServersTable.tool_catalog_revision,
          ),
        ),
      )
      .orderBy(toolsTable.name);
  }

  async create(input: ToolCreateInput): Promise<DatabaseTool> {
    const [createdTool] = await this.database
      .insert(toolsTable)
      .values(input)
      .returning();
    return createdTool;
  }

  async bulkUpsert(input: ToolUpsertInput): Promise<DatabaseTool[]> {
    if (!input.tools.length) return [];
    return this.database.transaction(async (tx) => {
      const [server] = await tx
        .select({ revision: mcpServersTable.tool_catalog_revision })
        .from(mcpServersTable)
        .where(eq(mcpServersTable.uuid, input.mcpServerUuid))
        .for("update");
      if (!server) throw new Error("MCP server not found");
      return upsertTools(tx, input, server.revision);
    });
  }

  async findByUuid(uuid: string): Promise<DatabaseTool | undefined> {
    const [tool] = await this.database
      .select()
      .from(toolsTable)
      .where(eq(toolsTable.uuid, uuid))
      .limit(1);
    return tool;
  }

  async deleteByUuid(uuid: string): Promise<DatabaseTool | undefined> {
    const [deletedTool] = await this.database
      .delete(toolsTable)
      .where(eq(toolsTable.uuid, uuid))
      .returning();
    return deletedTool;
  }

  async deleteObsoleteTools(
    mcpServerUuid: string,
    currentToolNames: string[],
  ): Promise<DatabaseTool[]> {
    return deleteObsoleteTools(this.database, mcpServerUuid, currentToolNames);
  }

  async syncTools(input: ToolUpsertInput): Promise<{
    upserted: DatabaseTool[];
    deleted: DatabaseTool[];
  }> {
    return this.database.transaction(async (tx) => {
      const [server] = await tx
        .select({ revision: mcpServersTable.tool_catalog_revision })
        .from(mcpServersTable)
        .where(eq(mcpServersTable.uuid, input.mcpServerUuid))
        .for("update");
      if (!server) throw new Error("MCP server not found");
      return syncToolsInTransaction(tx, input, server.revision);
    });
  }
}

export const toolsRepository = new ToolsRepository();
