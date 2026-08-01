import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/repositories", () => ({
  oauthSessionsRepository: {
    findByMcpServerUuid: vi.fn(),
    upsert: vi.fn(),
    consumeExpectedState: vi.fn(),
  },
  mcpServersRepository: {
    findByUuid: vi.fn(),
  },
}));

vi.mock("../lib/oauth-upstream/refresh-on-401", () => ({
  tryRefreshUpstreamTokens: vi.fn(),
}));

vi.mock("../utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ORIGINAL_APP_URL = process.env.APP_URL;
const USER_ID = "user-1";
const SERVER_UUID = "00000000-0000-0000-0000-000000000abc";

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const ownedServer = (userId: string | null = USER_ID) => ({
  uuid: SERVER_UUID,
  name: "test-server",
  type: "STREAMABLE_HTTP" as const,
  url: "https://upstream.example.com/mcp",
  user_id: userId,
});

const consumedSession = () => ({
  uuid: "00000000-0000-0000-0000-000000000def",
  mcp_server_uuid: SERVER_UUID,
  owner_user_id: USER_ID,
  code_verifier: "PKCE_VERIFIER",
  client_information: {
    client_id: "client-1",
    client_secret: "client-secret",
    token_endpoint: "https://upstream.example.com/token",
    token_endpoint_auth_method: "client_secret_post",
  },
  tokens: null,
  expected_state: null,
  expected_state_expires_at: null,
  created_at: new Date(),
  updated_at: new Date(),
});

async function loadModule() {
  const repos = await import("../db/repositories");
  const refresh = await import("../lib/oauth-upstream/refresh-on-401");
  const { oauthImplementations } = await import("./oauth.impl");
  return {
    oauthImplementations,
    findSession: repos.oauthSessionsRepository
      .findByMcpServerUuid as ReturnType<typeof vi.fn>,
    upsert: repos.oauthSessionsRepository.upsert as ReturnType<typeof vi.fn>,
    consume: repos.oauthSessionsRepository.consumeExpectedState as ReturnType<
      typeof vi.fn
    >,
    findServer: repos.mcpServersRepository.findByUuid as ReturnType<
      typeof vi.fn
    >,
    refresh: refresh.tryRefreshUpstreamTokens as ReturnType<typeof vi.fn>,
  };
}

describe("oauthImplementations owner and state isolation", () => {
  beforeEach(() => {
    process.env.APP_URL = "https://metamcp.example.com";
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.APP_URL = ORIGINAL_APP_URL;
    vi.restoreAllMocks();
  });

  it("atomically consumes state before upstream exchange and owner-guards token persistence", async () => {
    const { oauthImplementations, consume, findServer, upsert } =
      await loadModule();
    findServer.mockResolvedValue(ownedServer());
    consume.mockResolvedValue(consumedSession());
    upsert.mockResolvedValue(consumedSession());

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        const urlString = String(url);
        if (urlString.includes("/.well-known/")) {
          return new Response("not found", { status: 404 });
        }
        expect(urlString).toBe("https://upstream.example.com/token");
        expect(init?.method).toBe("POST");
        const body = init?.body as URLSearchParams;
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("code");
        expect(body.get("redirect_uri")).toBe(
          "https://metamcp.example.com/fe-oauth/callback",
        );
        expect(body.get("code_verifier")).toBe("PKCE_VERIFIER");
        expect(body.get("client_id")).toBe("client-1");
        expect(body.get("client_secret")).toBe("client-secret");
        return jsonResponse(200, {
          access_token: "access-token",
          token_type: "Bearer",
        });
      });

    const result = await oauthImplementations.exchangeToken(
      { mcp_server_uuid: SERVER_UUID, code: "code", state: "state" },
      USER_ID,
    );

    expect(result.success).toBe(true);
    expect(consume).toHaveBeenCalledWith(SERVER_UUID, USER_ID, "state");
    expect(consume.mock.invocationCallOrder[0]).toBeLessThan(
      fetchSpy.mock.invocationCallOrder[0],
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        mcp_server_uuid: SERVER_UUID,
        tokens: expect.objectContaining({ access_token: "access-token" }),
      }),
      USER_ID,
    );
  });

  it.each([
    "missing state",
    "NULL persisted state",
    "expired state",
    "mismatched state",
    "already consumed state",
  ])("returns one invalid_state response for %s", async () => {
    const { oauthImplementations, consume, findServer, upsert } =
      await loadModule();
    findServer.mockResolvedValue(ownedServer());
    consume.mockResolvedValue(undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await oauthImplementations.exchangeToken(
      { mcp_server_uuid: SERVER_UUID, code: "code", state: "bad-state" },
      USER_ID,
    );

    expect(result).toMatchObject({ success: false, error: "invalid_state" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("does not restore consumed state after an upstream failure", async () => {
    const { oauthImplementations, consume, findServer, upsert } =
      await loadModule();
    findServer.mockResolvedValue(ownedServer());
    consume.mockResolvedValue(consumedSession());
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/.well-known/")) {
        return new Response("not found", { status: 404 });
      }
      return jsonResponse(400, {
        error: "invalid_grant",
        error_description: "code rejected",
      });
    });

    const result = await oauthImplementations.exchangeToken(
      { mcp_server_uuid: SERVER_UUID, code: "code", state: "state" },
      USER_ID,
    );

    expect(result).toMatchObject({ success: false, error: "invalid_grant" });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["public", ownedServer(null)],
    ["different owner", ownedServer("user-2")],
  ])("uses resource_unavailable for a %s server", async (_label, server) => {
    const { oauthImplementations, consume, findServer } = await loadModule();
    findServer.mockResolvedValue(server);

    const result = await oauthImplementations.exchangeToken(
      { mcp_server_uuid: SERVER_UUID, code: "code", state: "state" },
      USER_ID,
    );

    expect(result).toEqual({
      success: false,
      error: "resource_unavailable",
      error_description: "OAuth resource is unavailable",
    });
    expect(consume).not.toHaveBeenCalled();
  });

  it("passes actor userId through get and upsert without serializing owner/state", async () => {
    const { oauthImplementations, findSession, upsert } = await loadModule();
    const session = consumedSession();
    findSession.mockResolvedValue(session);
    upsert.mockResolvedValue(session);

    const getResult = await oauthImplementations.get(
      { mcp_server_uuid: SERVER_UUID },
      USER_ID,
    );
    const upsertResult = await oauthImplementations.upsert(
      { mcp_server_uuid: SERVER_UUID, expected_state: "new-state" },
      USER_ID,
    );

    expect(findSession).toHaveBeenCalledWith(SERVER_UUID, USER_ID);
    expect(upsert).toHaveBeenCalledWith(
      { mcp_server_uuid: SERVER_UUID, expected_state: "new-state" },
      USER_ID,
    );
    expect(getResult).toMatchObject({ success: true });
    expect(upsertResult).toMatchObject({ success: true });
    if (getResult.success) {
      expect(getResult.data).not.toHaveProperty("owner_user_id");
      expect(getResult.data).not.toHaveProperty("expected_state");
      expect(getResult.data).not.toHaveProperty("expected_state_expires_at");
    }
  });

  it("passes actor ownership context into refresh", async () => {
    const { oauthImplementations, findServer, refresh } = await loadModule();
    findServer.mockResolvedValue(ownedServer());
    refresh.mockResolvedValue({ status: "refreshed" });

    const result = await oauthImplementations.refreshToken(
      { mcp_server_uuid: SERVER_UUID },
      USER_ID,
    );

    expect(result.success).toBe(true);
    expect(refresh).toHaveBeenCalledWith({
      uuid: SERVER_UUID,
      name: "frontend-refresh",
      url: "https://upstream.example.com/mcp",
      user_id: USER_ID,
    });
  });
});
