import type { OAuthClient } from "@repo/zod-types";
import type express from "express";
import { describe, expect, it, vi } from "vitest";

import {
  authenticateTokenClient,
  constantTimeSecretEqual,
} from "./client-auth";

function client(
  method: OAuthClient["token_endpoint_auth_method"],
  secret: string | null,
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

describe("authenticateTokenClient", () => {
  it("authenticates client_secret_basic only from Basic credentials", async () => {
    const getClient = vi
      .fn()
      .mockResolvedValue(client("client_secret_basic", "secret-value"));
    const authorization = `Basic ${Buffer.from("client-1:secret-value").toString("base64")}`;

    await expect(
      authenticateTokenClient(request({}, authorization), { getClient }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("authenticates client_secret_post only from body credentials", async () => {
    const getClient = vi
      .fn()
      .mockResolvedValue(client("client_secret_post", "secret-value"));

    await expect(
      authenticateTokenClient(
        request({ client_id: "client-1", client_secret: "secret-value" }),
        { getClient },
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it("authenticates a public client only with body client_id and no secret", async () => {
    const getClient = vi.fn().mockResolvedValue(client("none", null));

    await expect(
      authenticateTokenClient(request({ client_id: "client-1" }), {
        getClient,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("rejects Basic plus body credentials before client lookup", async () => {
    const getClient = vi.fn();
    const authorization = `Basic ${Buffer.from("client-1:secret-value").toString("base64")}`;

    await expect(
      authenticateTokenClient(
        request({ client_id: "client-1" }, authorization),
        { getClient },
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: "invalid_request",
    });
    expect(getClient).not.toHaveBeenCalled();
  });

  it.each([
    [null, { client_id: "client-1", client_secret: "wrong" }],
    [client("client_secret_basic", "secret-value"), { client_id: "client-1" }],
    [
      client("client_secret_post", null),
      { client_id: "client-1", client_secret: "x" },
    ],
    [
      client("client_secret_post", ""),
      { client_id: "client-1", client_secret: "" },
    ],
  ])(
    "returns one invalid_client shape for unknown, mismatch, and bad secrets",
    async (storedClient, body) => {
      const getClient = vi.fn().mockResolvedValue(storedClient);

      await expect(
        authenticateTokenClient(request(body), { getClient }),
      ).resolves.toEqual({
        ok: false,
        status: 401,
        error: "invalid_client",
        error_description: "Invalid client credentials",
      });
    },
  );

  it("compares different-length UTF-8 secrets without throwing", () => {
    expect(() =>
      constantTimeSecretEqual("短", "a much longer secret"),
    ).not.toThrow();
    expect(constantTimeSecretEqual("短", "a much longer secret")).toBe(false);
  });
});
