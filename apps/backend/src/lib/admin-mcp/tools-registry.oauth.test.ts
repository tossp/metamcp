import { beforeEach, describe, expect, it, vi } from "vitest";

const oauthGet = vi.fn();
const oauthUpsert = vi.fn();

vi.mock("../../trpc/oauth.impl", () => ({
  oauthImplementations: { get: oauthGet, upsert: oauthUpsert },
}));
vi.mock("../../trpc/api-keys.impl", () => ({ apiKeysImplementations: {} }));
vi.mock("../../trpc/config.impl", () => ({ configImplementations: {} }));
vi.mock("../../trpc/endpoints.impl", () => ({ endpointsImplementations: {} }));
vi.mock("../../trpc/logs.impl", () => ({ logsImplementations: {} }));
vi.mock("../../trpc/mcp-servers.impl", () => ({
  mcpServersImplementations: {},
}));
vi.mock("../../trpc/namespaces.impl", () => ({
  namespacesImplementations: {},
}));
vi.mock("../../trpc/tools.impl", () => ({ toolsImplementations: {} }));

const { ADMIN_TOOLS_BY_NAME } = await import("./tools-registry");

describe("Admin MCP OAuth tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["metamcp_get_oauth_session", oauthGet],
    ["metamcp_upsert_oauth_session", oauthUpsert],
  ])("passes the authenticated userId through %s", async (name, handler) => {
    handler.mockResolvedValue({ success: true });
    const tool = ADMIN_TOOLS_BY_NAME.get(name);
    const input = {
      mcp_server_uuid: "00000000-0000-4000-8000-000000000001",
    };

    await tool?.handler("actor-user", input);

    expect(handler).toHaveBeenCalledWith(input, "actor-user");
  });
});
