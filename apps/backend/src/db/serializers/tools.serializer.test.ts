import { GetToolsByMcpServerUuidResponseSchema } from "@repo/zod-types";
import { describe, expect, it } from "vitest";

import { ToolsSerializer } from "./tools.serializer";

const legacy = {
  uuid: "00000000-0000-4000-8000-000000000001",
  name: "lookup",
  description: "legacy",
  toolSchema: { type: "object" as const },
  created_at: new Date(0),
  updated_at: new Date(0),
  mcp_server_uuid: "00000000-0000-4000-8000-000000000002",
};

describe("catalog metadata in the single-server response", () => {
  it("retains complete definitions through serialization and the shared response schema", () => {
    const definition = {
      name: "lookup",
      title: "Lookup",
      description: "full",
      inputSchema: { type: "object" as const, additionalProperties: false },
      outputSchema: { type: "object" as const, "x-vendor": true },
      annotations: { readOnlyHint: true, "x-vendor": "kept" },
      _meta: { revision: 2 },
      "x-vendor": { nested: true },
    };
    const response = GetToolsByMcpServerUuidResponseSchema.parse({
      success: true,
      data: ToolsSerializer.serializeToolList([
        { ...legacy, catalog_revision: 0, definition },
      ]),
    });
    expect(response.data[0]).toMatchObject({
      title: "Lookup",
      catalog_revision: 0,
      definition,
    });
    expect(response.data[0]?.definition).toEqual(definition);
  });

  it("keeps legacy rows readable before their next successful refresh", () => {
    const response = GetToolsByMcpServerUuidResponseSchema.parse({
      success: true,
      data: ToolsSerializer.serializeToolList([legacy]),
    });
    expect(response.data[0]?.name).toBe("lookup");
    expect(response.data[0]?.definition).toBeUndefined();
  });
});
