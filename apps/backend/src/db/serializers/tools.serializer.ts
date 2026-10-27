import { DatabaseTool, Tool } from "@repo/zod-types";

export class ToolsSerializer {
  static serializeTool(dbTool: DatabaseTool): Tool {
    return {
      uuid: dbTool.uuid,
      name: dbTool.name,
      description: dbTool.description,
      toolSchema: dbTool.toolSchema,
      catalog_revision: dbTool.catalog_revision,
      definition: dbTool.definition,
      title: dbTool.definition?.title ?? null,
      created_at: dbTool.created_at.toISOString(),
      updated_at: dbTool.updated_at.toISOString(),
      mcp_server_uuid: dbTool.mcp_server_uuid,
    };
  }

  static serializeToolList(dbTools: DatabaseTool[]): Tool[] {
    return dbTools.map(this.serializeTool);
  }
}
