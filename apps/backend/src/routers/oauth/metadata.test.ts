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
    ["https://mcp.example/prefix/auth", "https://mcp.example/prefix/auth"],
    ["https://mcp.example/prefix/auth/", "https://mcp.example/prefix/auth"],
    ["https://mcp.example/prefix//auth///", "https://mcp.example/prefix//auth"],
  ])(
    "normalizes the issuer for %s without changing endpoints",
    async (baseUrl, issuer) => {
      vi.stubEnv("APP_URL", baseUrl);

      const response = await fetch(
        `${origin}/.well-known/oauth-authorization-server`,
      );
      expect(response.status).toBe(200);
      const metadata = await response.json();

      expect(metadata).toHaveProperty("issuer", issuer);
      expect(metadata).toHaveProperty(
        "issuer",
        expect.not.stringMatching(/\/$/),
      );
      for (const [field, path] of Object.entries({
        authorization_endpoint: "authorize",
        token_endpoint: "token",
        registration_endpoint: "register",
        userinfo_endpoint: "userinfo",
        revocation_endpoint: "revoke",
      })) {
        expect(metadata).toHaveProperty(field, `${baseUrl}/oauth/${path}`);
      }
    },
  );

  it.each(["https://mcp.example", "https://mcp.example/"])(
    "preserves protected resource metadata for %s",
    async (baseUrl) => {
      vi.stubEnv("APP_URL", baseUrl);

      const response = await fetch(
        `${origin}/.well-known/oauth-protected-resource`,
      );
      expect(response.status).toBe(200);
      const metadata = await response.json();

      expect(metadata).toHaveProperty("authorization_servers", [baseUrl]);
      expect(metadata).toHaveProperty("resource", "https://mcp.example/");
      if (!baseUrl.endsWith("/")) {
        const authorizationServer = await fetch(
          `${origin}/.well-known/oauth-authorization-server`,
        );
        expect(authorizationServer.status).toBe(200);
        expect(await authorizationServer.json()).toHaveProperty(
          "issuer",
          baseUrl,
        );
      }
    },
  );
});
