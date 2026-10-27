import { ToolSchema as SdkToolSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  CreateToolRequestSchema,
  DatabaseToolSchema,
  McpToolSchema,
  RefreshToolsRequestSchema,
  RefreshToolsResponseSchema,
  ToolSchema,
  ToolUpsertInputSchema,
} from "@repo/zod-types";
import { describe, expect, it } from "vitest";

const uuid = "00000000-0000-4000-8000-000000000001";
const tool = {
  name: "search",
  title: "Search",
  description: "Search records",
  inputSchema: {
    type: "object",
    properties: { term: { type: "string", minLength: 1 } },
    required: ["term"],
    additionalProperties: false,
    $defs: { record: { type: "object" } },
    "x-schema": { retained: true },
  },
  outputSchema: { type: "object", additionalProperties: true },
  annotations: { readOnlyHint: true, title: "Read", "x-hint": 1 },
  _meta: { "vendor/data": { enabled: true } },
  "x-tool": { retained: [1, 2] },
};

describe("shared tool schema", () => {
  it("keeps complete protocol metadata, JSON schema keywords and unknown extensions", () => {
    expect(McpToolSchema.parse(tool)).toEqual(tool);
    // SDK validation accepts this shape, but its parser strips unknown fields.
    // The shared schema must retain them instead of returning SDK-parsed data.
    expect(SdkToolSchema.safeParse(McpToolSchema.parse(tool)).success).toBe(
      true,
    );
    expect(
      CreateToolRequestSchema.parse({ mcpServerUuid: uuid, tools: [tool] })
        .tools,
    ).toEqual([tool]);
    expect(
      ToolUpsertInputSchema.parse({ mcpServerUuid: uuid, tools: [tool] }).tools,
    ).toEqual([tool]);
  });

  it("keeps legacy create/upsert payloads valid", () => {
    expect(
      CreateToolRequestSchema.safeParse({
        mcpServerUuid: uuid,
        tools: [{ name: "old", inputSchema: {} }],
      }).success,
    ).toBe(true);
    expect(
      ToolUpsertInputSchema.safeParse({
        mcpServerUuid: uuid,
        tools: [{ name: "old", description: null }],
      }).success,
    ).toBe(true);
    expect(
      ToolUpsertInputSchema.safeParse({ mcpServerUuid: uuid, tools: [] })
        .success,
    ).toBe(true);
  });

  it("keeps the legacy database serializer valid with optional new fields", () => {
    const stored = {
      uuid,
      name: "old",
      description: null,
      toolSchema: { type: "object", additionalProperties: false },
      mcp_server_uuid: uuid,
      created_at: new Date(),
      updated_at: new Date(),
    };
    expect(DatabaseToolSchema.parse(stored)).toEqual(stored);
    const serialized = {
      ...stored,
      created_at: stored.created_at.toISOString(),
      updated_at: stored.updated_at.toISOString(),
    };
    expect(ToolSchema.parse(serialized)).toEqual(serialized);
    expect(
      DatabaseToolSchema.parse({
        ...stored,
        catalog_revision: 3,
        definition: tool,
      }).definition,
    ).toEqual(tool);
    expect(
      DatabaseToolSchema.parse({ ...stored, definition: null }).definition,
    ).toBeNull();
  });

  it.each([
    { ...tool, title: 1 },
    { ...tool, outputSchema: { type: "string" } },
    { ...tool, annotations: { readOnlyHint: "true" } },
  ])("validates known fields", (invalid) => {
    expect(McpToolSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("refresh tools contract", () => {
  it.each([{ mcpServerUuid: uuid }, { namespaceUuid: uuid }])(
    "accepts exactly one selector",
    (input) => {
      expect(RefreshToolsRequestSchema.parse(input)).toEqual(input);
    },
  );
  it.each([
    {},
    { mcpServerUuid: uuid, namespaceUuid: uuid },
    { mcpServerUuid: "invalid" },
    { namespaceUuid: null },
  ])("rejects invalid selectors", (input) => {
    expect(RefreshToolsRequestSchema.safeParse(input).success).toBe(false);
  });
  it("supports aggregate and backward-compatible result shapes", () => {
    expect(
      RefreshToolsResponseSchema.parse({ success: true, count: 0 }),
    ).toEqual({ success: true, count: 0 });
    const result = {
      success: false,
      count: 1,
      results: [
        { serverUuid: uuid, success: false, count: 0, error: "unavailable" },
      ],
      error: "partial failure",
    };
    expect(RefreshToolsResponseSchema.parse(result)).toEqual(result);
  });
});
