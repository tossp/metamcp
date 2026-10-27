import { z } from "zod";

export const ToolStatusEnum = z.enum(["ACTIVE", "INACTIVE"]);
export type ToolStatus = z.infer<typeof ToolStatusEnum>;

// Keep JSON Schema keywords and vendor extensions intact across API boundaries.
export const ToolJsonSchema = z
  .object({
    type: z.literal("object"),
    properties: z.record(z.string(), z.any()).optional(),
    required: z.array(z.string()).optional(),
  })
  .passthrough();

export const ToolAnnotationsSchema = z
  .object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .passthrough();

// Protocol definition, independent of the backend-only MCP SDK dependency.
export const McpToolSchema = z
  .object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    inputSchema: ToolJsonSchema,
    outputSchema: ToolJsonSchema.optional(),
    annotations: ToolAnnotationsSchema.optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type McpTool = z.infer<typeof McpToolSchema>;

const storedCatalogFields = {
  catalog_revision: z.number().int().optional(),
  definition: McpToolSchema.nullable().optional(),
};

// Optional catalog fields keep existing database serializers/callers compatible.
export const ToolSchema = z.object({
  uuid: z.string().uuid(),
  name: z.string(),
  title: z.string().nullable().optional(),
  description: z.string().nullable(),
  toolSchema: ToolJsonSchema,
  ...storedCatalogFields,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  mcp_server_uuid: z.string().uuid(),
});
export type Tool = z.infer<typeof ToolSchema>;

export const GetToolsByMcpServerUuidRequestSchema = z.object({
  mcpServerUuid: z.string().uuid(),
});
export const GetToolsByMcpServerUuidResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(ToolSchema),
  message: z.string().optional(),
});

const legacyInputSchema = ToolJsonSchema.extend({
  type: z.literal("object").optional(),
});

export const CreateToolRequestSchema = z.object({
  mcpServerUuid: z.string().uuid(),
  tools: z.array(McpToolSchema.extend({ inputSchema: legacyInputSchema })),
});
export const CreateToolResponseSchema = z.object({
  success: z.boolean(),
  count: z.number(),
  message: z.string().optional(),
  error: z.string().optional(),
});

export const RefreshToolsRequestSchema = z
  .object({
    mcpServerUuid: z.string().uuid().optional(),
    namespaceUuid: z.string().uuid().optional(),
  })
  .refine(
    (input) =>
      (input.mcpServerUuid !== undefined) !==
      (input.namespaceUuid !== undefined),
    { message: "Exactly one of mcpServerUuid or namespaceUuid is required" },
  );
export const RefreshToolsResponseSchema = z.object({
  success: z.boolean(),
  count: z.number(),
  results: z
    .array(
      z.object({
        serverUuid: z.string(),
        success: z.boolean(),
        count: z.number(),
        error: z.string().optional(),
      }),
    )
    .optional(),
  error: z.string().optional(),
});

export type GetToolsByMcpServerUuidRequest = z.infer<
  typeof GetToolsByMcpServerUuidRequestSchema
>;
export type GetToolsByMcpServerUuidResponse = z.infer<
  typeof GetToolsByMcpServerUuidResponseSchema
>;
export type CreateToolRequest = z.infer<typeof CreateToolRequestSchema>;
export type CreateToolResponse = z.infer<typeof CreateToolResponseSchema>;
export type RefreshToolsRequest = z.infer<typeof RefreshToolsRequestSchema>;
export type RefreshToolsResponse = z.infer<typeof RefreshToolsResponseSchema>;

export const ToolCreateInputSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  toolSchema: ToolJsonSchema,
  ...storedCatalogFields,
  mcp_server_uuid: z.string(),
});
export const ToolUpsertInputSchema = z.object({
  tools: z.array(
    McpToolSchema.extend({
      description: z.string().nullable().optional(),
      inputSchema: legacyInputSchema.optional(),
    }),
  ),
  mcpServerUuid: z.string(),
});
export type ToolCreateInput = z.infer<typeof ToolCreateInputSchema>;
export type ToolUpsertInput = z.infer<typeof ToolUpsertInputSchema>;

export const DatabaseToolSchema = ToolSchema.extend({
  uuid: z.string(),
  created_at: z.date(),
  updated_at: z.date(),
  mcp_server_uuid: z.string(),
});
export type DatabaseTool = z.infer<typeof DatabaseToolSchema>;
