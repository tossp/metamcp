import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import metadataRouter from "./metadata";

const app = express();
app.use(metadataRouter);
const server = createServer(app);
let origin: string;

beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("OAuth metadata routes", () => {
  it.each([
    ["https://mcp.example", "https://mcp.example"],
    ["https://mcp.example/", "https://mcp.example"],
    ["https://mcp.example///", "https://mcp.example"],
    ["https://mcp.example/prefix/auth", "https://mcp.example/prefix/auth"],
    ["https://mcp.example/prefix/auth/", "https://mcp.example/prefix/auth"],
    ["https://mcp.example/prefix//auth///", "https://mcp.example/prefix//auth"],
  ])(
    "keeps authorization server identifiers consistent for %s",
    async (baseUrl, authorizationServerUrl) => {
      vi.stubEnv("APP_URL", baseUrl);

      const authorizationServerResponse = await fetch(
        `${origin}/.well-known/oauth-authorization-server`,
      );
      expect(authorizationServerResponse.status).toBe(200);
      const authorizationServerMetadata =
        await authorizationServerResponse.json();

      expect(authorizationServerMetadata).toHaveProperty(
        "issuer",
        authorizationServerUrl,
      );
      expect(authorizationServerMetadata).toHaveProperty(
        "issuer",
        expect.not.stringMatching(/\/$/),
      );
      const issuer = (authorizationServerMetadata as { issuer: string }).issuer;
      for (const [field, path] of Object.entries({
        authorization_endpoint: "authorize",
        token_endpoint: "token",
        registration_endpoint: "register",
        userinfo_endpoint: "userinfo",
        revocation_endpoint: "revoke",
      })) {
        expect(authorizationServerMetadata).toHaveProperty(
          field,
          `${baseUrl}/oauth/${path}`,
        );
      }

      const protectedResourceResponse = await fetch(
        `${origin}/.well-known/oauth-protected-resource`,
      );
      expect(protectedResourceResponse.status).toBe(200);
      const protectedResourceMetadata = await protectedResourceResponse.json();

      expect(protectedResourceMetadata).toHaveProperty(
        "authorization_servers",
        [authorizationServerUrl],
      );
      expect(protectedResourceMetadata).toHaveProperty(
        "resource",
        baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
      );
      expect(protectedResourceMetadata).toHaveProperty(
        "resource_server_capabilities.introspection_endpoint",
        `${baseUrl}/oauth/introspect`,
      );
      expect(protectedResourceMetadata).toHaveProperty(
        "resource_server_capabilities.revocation_endpoint",
        `${baseUrl}/oauth/revoke`,
      );
      expect(protectedResourceMetadata).toHaveProperty(
        "authorization_servers.0",
        issuer,
      );
      expect(protectedResourceMetadata).toHaveProperty(
        "resource_name",
        "MetaMCP Protected Resource",
      );
    },
  );
});
