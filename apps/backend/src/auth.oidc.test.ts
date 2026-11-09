import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { toNodeHandler } from "better-auth/node";
import express from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { database } = vi.hoisted(() => ({
  database: {
    user: [] as Record<string, unknown>[],
    account: [] as Record<string, unknown>[],
    session: [] as Record<string, unknown>[],
    verification: [] as Record<string, unknown>[],
  },
}));

// Exercise the production auth configuration; replace only external persistence
// and settings. The OIDC provider and application exchange real local HTTP.
vi.mock("./db/index", () => ({ db: {} }));
vi.mock("better-auth/adapters/drizzle", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return { drizzleAdapter: () => memoryAdapter(database) };
});
vi.mock("./lib/config.service", () => ({
  configService: {
    isBasicAuthDisabled: async () => false,
    isSignupDisabled: async () => false,
    isSsoSignupDisabled: async () => false,
  },
}));
vi.mock("./utils/logger", () => ({ default: { info: vi.fn() } }));

const clientId = "oidc-migration-test-client";
const clientSecret = "oidc-migration-test-secret";
const profile = {
  sub: "oidc-existing-subject",
  name: "OIDC test user",
  email: "oidc@example.test",
  email_verified: true,
};
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "test-key",
  alg: "RS256",
};

describe("Better Auth 1.7 OIDC callback migration", () => {
  let provider: Server;
  let application: Server;
  let issuer: string;
  let origin: string;
  let nonce: string;
  let challenge: string;
  let invalidNonce = false;
  const tokenRequests: URLSearchParams[] = [];

  beforeAll(async () => {
    const providerApp = express();
    providerApp.use(express.urlencoded({ extended: false }));
    providerApp.get("/.well-known/openid-configuration", (_req, res) => {
      res.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    });
    providerApp.get("/jwks", (_req, res) => res.json({ keys: [jwk] }));
    providerApp.post("/token", (req, res) => {
      const body = new URLSearchParams(req.body);
      tokenRequests.push(body);
      const actualChallenge = createHash("sha256")
        .update(body.get("code_verifier") ?? "")
        .digest("base64url");
      if (
        body.get("code") !== "test-authorization-code" ||
        body.get("grant_type") !== "authorization_code" ||
        body.get("client_id") !== clientId ||
        body.get("client_secret") !== clientSecret ||
        body.get("redirect_uri") !== `${origin}/api/auth/callback/oidc` ||
        actualChallenge !== challenge
      ) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        ...profile,
        iss: issuer,
        aud: clientId,
        iat: now,
        exp: now + 300,
        nonce: invalidNonce ? "wrong-nonce" : nonce,
      };
      const unsigned = [{ alg: "RS256", kid: "test-key", typ: "JWT" }, payload]
        .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
        .join(".");
      const signature = sign("RSA-SHA256", Buffer.from(unsigned), privateKey);
      res.json({
        access_token: "test-access-token",
        token_type: "Bearer",
        expires_in: 300,
        id_token: `${unsigned}.${signature.toString("base64url")}`,
      });
    });
    providerApp.get("/userinfo", (req, res) => {
      if (req.headers.authorization !== "Bearer test-access-token") {
        res.sendStatus(401);
        return;
      }
      res.json(profile);
    });
    provider = createServer(providerApp).listen(0, "127.0.0.1");
    await once(provider, "listening");
    issuer = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

    const app = express();
    application = createServer(app).listen(0, "127.0.0.1");
    await once(application, "listening");
    origin = `http://127.0.0.1:${(application.address() as AddressInfo).port}`;
    for (const [key, value] of Object.entries({
      APP_URL: origin,
      BETTER_AUTH_SECRET: "oidc-migration-local-test-secret-0123456789",
      OIDC_CLIENT_ID: clientId,
      OIDC_CLIENT_SECRET: clientSecret,
      OIDC_PROVIDER_ID: "oidc",
      OIDC_DISCOVERY_URL: `${issuer}/.well-known/openid-configuration`,
      OIDC_SCOPES: "openid email profile",
      OIDC_PKCE: "true",
      EXTRA_TRUSTED_ORIGINS: "",
      BETTER_AUTH_SESSION_EXPIRES_IN_SECONDS: "",
      BETTER_AUTH_SESSION_UPDATE_AGE_SECONDS: "",
    })) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv("OIDC_AUTHORIZATION_URL", undefined);
    const { auth } = await import("./auth");
    app.all("/api/auth/{*path}", toNodeHandler(auth));
  });

  beforeEach(() => {
    for (const rows of Object.values(database)) rows.length = 0;
    tokenRequests.length = 0;
    invalidNonce = false;
  });

  afterAll(async () => {
    for (const server of [application, provider]) {
      if (server)
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    vi.unstubAllEnvs();
  });

  it("uses the new callback and completes signed OIDC login, session and logout", async () => {
    const login = await startLogin();
    expect(login.authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(challenge).not.toBe("");
    expect(nonce).not.toBe("");
    expect(login.authorization.searchParams.get("scope")?.split(" ")).toEqual(
      expect.arrayContaining(["openid", "email", "profile"]),
    );
    const callback = await finishLogin(login);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`${origin}/mcp-servers`);
    expect(tokenRequests).toHaveLength(1);
    expect(database.account).toEqual([
      expect.objectContaining({ providerId: "oidc", accountId: profile.sub }),
    ]);
    const cookie = cookies(callback);
    const session = await fetch(`${origin}/api/auth/get-session`, {
      headers: { Cookie: cookie },
    });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      user: { email: profile.email },
    });
    const logout = await fetch(`${origin}/api/auth/sign-out`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin },
    });
    expect(logout.status).toBe(200);
    expect(database.session).toHaveLength(0);

    const existingUserId = database.user[0]?.id;
    expect(existingUserId).toBeTruthy();
    const repeatedLogin = await finishLogin(await startLogin());
    expect(repeatedLogin.status).toBe(302);
    expect(repeatedLogin.headers.get("location")).toBe(`${origin}/mcp-servers`);
    expect(database.user).toEqual([
      expect.objectContaining({ id: existingUserId }),
    ]);
    expect(database.account).toHaveLength(1);
  });

  it("preserves an existing provider subject binding without creating another user", async () => {
    const now = new Date();
    database.user.push({
      id: "pre-migration-user",
      name: profile.name,
      email: profile.email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    database.account.push({
      id: "pre-migration-account",
      userId: "pre-migration-user",
      providerId: "oidc",
      accountId: profile.sub,
      createdAt: now,
      updatedAt: now,
    });
    const callback = await finishLogin(await startLogin());
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`${origin}/mcp-servers`);
    expect(database.user).toEqual([
      expect.objectContaining({ id: "pre-migration-user" }),
    ]);
    expect(database.account).toEqual([
      expect.objectContaining({
        id: "pre-migration-account",
        userId: "pre-migration-user",
      }),
    ]);
    expect(database.session).toEqual([
      expect.objectContaining({ userId: "pre-migration-user" }),
    ]);
  });

  it("does not expose the retired oauth2 callback route", async () => {
    const response = await fetch(`${origin}/api/auth/oauth2/callback/oidc`, {
      redirect: "manual",
    });
    expect(response.status).toBe(404);
    expect(tokenRequests).toHaveLength(0);
    expect(database.session).toHaveLength(0);
  });

  it("rejects a changed state before exchanging the authorization code", async () => {
    const login = await startLogin();
    const callback = await finishLogin(login, "invalid-state");
    expect(callback.status).toBe(302);
    expect(
      new URL(callback.headers.get("location") ?? "", origin).searchParams.has(
        "error",
      ),
    ).toBe(true);
    expect(tokenRequests).toHaveLength(0);
    expect(database.session).toHaveLength(0);
  });

  it("rejects a validly signed ID token with the wrong nonce", async () => {
    const login = await startLogin();
    invalidNonce = true;
    const callback = await finishLogin(login);
    expect(callback.status).toBe(302);
    expect(
      new URL(callback.headers.get("location") ?? "", origin).searchParams.has(
        "error",
      ),
    ).toBe(true);
    expect(tokenRequests).toHaveLength(1);
    expect(database.session).toHaveLength(0);
  });

  async function startLogin() {
    const response = await fetch(`${origin}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        provider: "oidc",
        callbackURL: `${origin}/mcp-servers`,
        disableRedirect: true,
      }),
    });
    expect(response.status).toBe(200);
    const authorization = new URL(
      ((await response.json()) as { url: string }).url,
    );
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `${origin}/api/auth/callback/oidc`,
    );
    nonce = authorization.searchParams.get("nonce") ?? "";
    challenge = authorization.searchParams.get("code_challenge") ?? "";
    const state = authorization.searchParams.get("state");
    expect(state).toBeTruthy();
    return { authorization, state: state ?? "", cookie: cookies(response) };
  }

  function finishLogin(
    login: { state: string; cookie: string },
    state = login.state,
  ) {
    const url = new URL(`${origin}/api/auth/callback/oidc`);
    url.searchParams.set("code", "test-authorization-code");
    url.searchParams.set("state", state);
    return fetch(url, {
      headers: { Cookie: login.cookie },
      redirect: "manual",
    });
  }
});

function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}
