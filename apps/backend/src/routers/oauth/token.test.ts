import type { OAuthClient } from "@repo/zod-types";
import type express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  getClient: vi.fn(),
  consumeAuthorizationCode: vi.fn(),
  rotateRefreshToken: vi.fn(),
  getAccessToken: vi.fn(),
  deleteAccessToken: vi.fn(),
  getByRefreshToken: vi.fn(),
}));

vi.mock("../../db/repositories", () => ({ oauthRepository: repository }));

const { handleAuthorizationCodeGrant, handleRefreshTokenGrant } =
  await import("./token");

const verifier = "v".repeat(43);

function client(
  method: "none" | "client_secret_basic" | "client_secret_post",
  secret: string | null = null,
): OAuthClient {
  return {
    client_id: "client-1",
    client_secret: secret,
    client_name: "test",
    redirect_uris: ["https://client.example/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: method,
    scope: "admin",
    client_uri: null,
    logo_uri: null,
    contacts: null,
    tos_uri: null,
    policy_uri: null,
    software_id: null,
    software_version: null,
    created_at: new Date(),
  };
}

function request(
  body: Record<string, unknown>,
  authorization?: string,
): express.Request {
  return { body, headers: { authorization } } as express.Request;
}

function response() {
  const state: {
    status?: number;
    body?: unknown;
    headers: Record<string, string | number | readonly string[]>;
  } = { headers: {} };
  const res = {
    setHeader: vi.fn(
      (name: string, value: string | number | readonly string[]) => {
        state.headers[name.toLowerCase()] = value;
        return res;
      },
    ),
    status: vi.fn((status: number) => {
      state.status = status;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      state.body = body;
      return res;
    }),
  } as unknown as express.Response;
  return { res, state };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("OAuth token grants", () => {
  it("returns the authorization-code response contract after atomic consume", async () => {
    repository.getClient.mockResolvedValue(client("none"));
    repository.consumeAuthorizationCode.mockResolvedValue({ scope: "admin" });
    const { res, state } = response();

    await handleAuthorizationCodeGrant(
      request({
        code: "code-1",
        redirect_uri: "https://client.example/callback",
        code_verifier: verifier,
        client_id: "client-1",
      }),
      res,
    );

    expect(repository.consumeAuthorizationCode).toHaveBeenCalledOnce();
    expect(state.status).toBeUndefined();
    expect(state.body).toMatchObject({
      access_token: expect.stringMatching(/^mcp_token_/),
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: expect.stringMatching(/^mcp_refresh_/),
      scope: "admin",
    });
  });

  it("returns the refresh response contract after authenticated rotation", async () => {
    repository.getClient.mockResolvedValue(
      client("client_secret_post", "secret-value"),
    );
    repository.rotateRefreshToken.mockResolvedValue({ scope: "admin" });
    const { res, state } = response();

    await handleRefreshTokenGrant(
      request({
        refresh_token: "refresh-1",
        client_id: "client-1",
        client_secret: "secret-value",
      }),
      res,
    );

    expect(repository.rotateRefreshToken).toHaveBeenCalledWith(
      "refresh-1",
      "client-1",
      expect.objectContaining({
        access_token: expect.stringMatching(/^mcp_token_/),
        refresh_token: expect.stringMatching(/^mcp_refresh_/),
      }),
    );
    expect(state.body).toMatchObject({
      token_type: "Bearer",
      expires_in: 3600,
      scope: "admin",
    });
  });

  it("rejects dual credentials without looking up or consuming a grant", async () => {
    const authorization = `Basic ${Buffer.from("client-1:secret-value").toString("base64")}`;
    const { res, state } = response();

    await handleAuthorizationCodeGrant(
      request(
        {
          code: "code-1",
          redirect_uri: "https://client.example/callback",
          code_verifier: verifier,
          client_id: "client-1",
        },
        authorization,
      ),
      res,
    );

    expect(state).toMatchObject({
      status: 400,
      body: { error: "invalid_request" },
    });
    expect(state.headers).toEqual({});
    expect(repository.getClient).not.toHaveBeenCalled();
    expect(repository.consumeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("sets the standard Basic challenge only for 401 invalid_client", async () => {
    repository.getClient.mockResolvedValue(null);
    const { res, state } = response();

    await handleAuthorizationCodeGrant(
      request({
        code: "code-1",
        redirect_uri: "https://client.example/callback",
        code_verifier: verifier,
        client_id: "unknown-client",
      }),
      res,
    );

    expect(state).toEqual({
      status: 401,
      body: {
        error: "invalid_client",
        error_description: "Invalid client credentials",
      },
      headers: {
        "www-authenticate": 'Basic realm="oauth", charset="UTF-8"',
      },
    });
    expect(repository.consumeAuthorizationCode).not.toHaveBeenCalled();
  });

  it.each([
    [null, { client_id: "client-1" }],
    [
      client("client_secret_post", "expected"),
      { client_id: "client-1", client_secret: "x" },
    ],
    [client("client_secret_basic", "expected"), { client_id: "client-1" }],
  ])(
    "does not consume for unknown, wrong-secret, or method-mismatched clients",
    async (storedClient, credentials) => {
      repository.getClient.mockResolvedValue(storedClient);
      const { res, state } = response();

      await handleAuthorizationCodeGrant(
        request({
          code: "code-1",
          redirect_uri: "https://client.example/callback",
          code_verifier: verifier,
          ...credentials,
        }),
        res,
      );

      expect(state).toMatchObject({
        status: 401,
        body: { error: "invalid_client" },
      });
      expect(state.headers).toEqual({
        "www-authenticate": 'Basic realm="oauth", charset="UTF-8"',
      });
      expect(repository.consumeAuthorizationCode).not.toHaveBeenCalled();
    },
  );

  it("returns invalid_grant for a wrong redirect without a successful consume", async () => {
    repository.getClient.mockResolvedValue(client("none"));
    repository.consumeAuthorizationCode.mockResolvedValue(null);
    const { res, state } = response();

    await handleAuthorizationCodeGrant(
      request({
        code: "code-1",
        redirect_uri: "https://attacker.example/callback",
        code_verifier: verifier,
        client_id: "client-1",
      }),
      res,
    );

    expect(state).toMatchObject({
      status: 400,
      body: { error: "invalid_grant" },
    });
    expect(state.headers).toEqual({});
  });

  it("returns invalid_grant for a wrong valid verifier", async () => {
    repository.getClient.mockResolvedValue(client("none"));
    repository.consumeAuthorizationCode.mockResolvedValue(null);
    const { res, state } = response();

    await handleAuthorizationCodeGrant(
      request({
        code: "code-1",
        redirect_uri: "https://client.example/callback",
        code_verifier: "x".repeat(43),
        client_id: "client-1",
      }),
      res,
    );

    expect(state).toMatchObject({
      status: 400,
      body: { error: "invalid_grant" },
    });
    expect(state.headers).toEqual({});
  });
});
