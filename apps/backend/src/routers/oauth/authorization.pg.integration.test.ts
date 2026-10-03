/* eslint-disable @typescript-eslint/no-non-null-assertion -- HTTP fixtures assert status before reading required response fields */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { toNodeHandler } from "better-auth/node";
import { drizzle } from "drizzle-orm/node-postgres";
import express from "express";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const redirectUri = "http://127.0.0.1:34219/callback/test-client";
const params = {
  client_id: "client",
  redirect_uri: redirectUri,
  scope: "admin",
  state: "terminal-state",
  code_challenge: challenge,
  code_challenge_method: "S256",
};
const callback = (value: unknown) =>
  `/oauth/callback?params=${Buffer.from(JSON.stringify(value)).toString("base64url")}`;

// Real HTTP, Better Auth sessions and PostgreSQL; only the DB dependency points
// at an isolated schema. Never loads production env files or credentials.
describe.skipIf(!databaseUrl)(
  "OAuth loopback callback PostgreSQL and HTTP",
  () => {
    const schemaName = `oauth_redirect_${process.pid}_${Date.now()}`;
    let admin: Pool;
    let pool: Pool;
    let server: Server;
    let origin: string;
    let cookie: string;
    let userId: string;

    beforeAll(async () => {
      vi.stubEnv("DATABASE_URL", databaseUrl!);
      vi.stubEnv(
        "BETTER_AUTH_SECRET",
        "oauth26-isolated-test-secret-012345678901234567890",
      );
      vi.stubEnv("OIDC_CLIENT_ID", "");
      vi.stubEnv("OIDC_CLIENT_SECRET", "");
      admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`CREATE SCHEMA "${schemaName}"`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schemaName}`,
      });
      const journal = JSON.parse(
        await readFile(
          new URL("../../../drizzle/meta/_journal.json", import.meta.url),
          "utf8",
        ),
      );
      for (const { tag } of journal.entries) {
        const migration = await readFile(
          new URL(`../../../drizzle/${tag}.sql`, import.meta.url),
          "utf8",
        );
        await pool.query(migration.replaceAll('"public".', `"${schemaName}".`));
      }
      const schema = await import("../../db/schema");
      const db = drizzle(pool, { schema });
      vi.doMock("../../db/index", () => ({ db, pool }));
      const { OAuthRepository } =
        await import("../../db/repositories/oauth.repo");
      vi.doMock("../../db/repositories", () => ({
        oauthRepository: new OAuthRepository(db),
      }));
      const app = express();
      server = createServer(app);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      vi.stubEnv("APP_URL", origin);
      const { auth } = await import("../../auth");
      app.all("/api/auth/{*path}", toNodeHandler(auth));
      app.use(express.json(), express.urlencoded({ extended: false }));
      app.use((await import("./authorization")).default);
      app.use((await import("./registration")).default);
      app.use((await import("./token")).default);
      const signup = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          email: "redirect@example.test",
          password: "OAuth26-test-password!",
          name: "Redirect test",
        }),
      });
      expect(signup.status).toBe(200);
      cookie = signup.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; ");
      userId = ((await signup.json()) as { user: { id: string } }).user.id;
    }, 30000);

    beforeEach(async () => {
      await pool.query(
        "TRUNCATE oauth_authorization_codes, oauth_access_tokens, oauth_clients CASCADE",
      );
      await pool.query(
        "INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ('client', 'Terminal', $1)",
        [[redirectUri]],
      );
    });

    afterAll(async () => {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
        await admin.end();
      }
      vi.doUnmock("../../db/index");
      vi.doUnmock("../../db/repositories");
      vi.unstubAllEnvs();
    });

    const get = (path: string, session = cookie) =>
      fetch(new URL(path, origin), {
        redirect: "manual",
        headers: { cookie: session },
      });
    async function countCodes() {
      return (
        await pool.query(
          "SELECT count(*)::int AS count FROM oauth_authorization_codes",
        )
      ).rows[0].count;
    }
    async function expectRejected(path: string, session = cookie) {
      const response = await get(path, session);
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(await countCodes()).toBe(0);
    }

    it("rejects an unregistered external callback without issuing a code", async () => {
      await expectRejected(
        callback({
          ...params,
          redirect_uri: "https://oauth-check.invalid/probe",
        }),
      );
    });

    it("rejects external callbacks even if previously registered", async () => {
      const external = "https://oauth-check.invalid/probe";
      await pool.query("UPDATE oauth_clients SET redirect_uris = $1", [
        [external],
      ]);
      await expectRejected(callback({ ...params, redirect_uri: external }));
      await expectRejected(
        `/oauth/authorize?${new URLSearchParams({ ...params, redirect_uri: external, response_type: "code" })}`,
      );
    });

    it.each([
      { client_id: "unknown" },
      { redirect_uri: "http://127.0.0.1:34220/callback/test-client" },
      { redirect_uri: "http://127.0.0.1:34219/other" },
      { redirect_uri: "http://localhost:34219/callback/test-client" },
      { redirect_uri: "http://127.0.0.1:34219/callback/test-client#fragment" },
    ])(
      "rejects an unknown client or unregistered target: %j",
      async (change) => {
        await expectRejected(callback({ ...params, ...change }));
      },
    );

    it("checks callbacks before sending an unauthenticated browser to login", async () => {
      await expectRejected(
        callback({
          ...params,
          redirect_uri: "https://oauth-check.invalid/probe",
        }),
        "",
      );
    });

    it("returns controlled errors for malformed and ambiguous inputs", async () => {
      for (const path of [
        "/oauth/callback?params=not-json",
        callback(null),
        callback([]),
        callback({ ...params, client_id: ["client"] }),
        callback({ ...params, redirect_uri: { host: "localhost" } }),
        `${callback(params)}&params=duplicate`,
        `${callback(params)}&code=ambiguous`,
        "/oauth/callback?code=a&code=b",
        "/oauth/authorize?response_type=code&client_id=a&client_id=b",
      ])
        await expectRejected(path);
    });

    it.each([
      "http://localhost:19876/callback",
      redirectUri,
      "http://[::1]:34219/callback",
    ])("preserves terminal copy/paste and PKCE exchange: %s", async (uri) => {
      await pool.query("UPDATE oauth_clients SET redirect_uris = $1", [[uri]]);
      const authorization = await get(
        `/oauth/authorize?${new URLSearchParams({ ...params, redirect_uri: uri, response_type: "code", resource: `${origin}/` })}`,
        "",
      );
      expect(authorization.status).toBe(302);
      const login = new URL(authorization.headers.get("location")!);
      expect(login.pathname).toBe("/login");
      expect(await countCodes()).toBe(0);
      // Reuse a real Better Auth login session after the login redirect. The Next
      // login UI and external OIDC provider are not part of this HTTP harness.
      const result = await get(login.searchParams.get("callbackUrl")!);
      expect(result.status).toBe(302);
      const pasted = new URL(result.headers.get("location")!);
      expect(pasted.origin + pasted.pathname).toBe(uri);
      expect(pasted.searchParams.get("state")).toBe(params.state);
      const grant = {
        grant_type: "authorization_code",
        client_id: "client",
        code: pasted.searchParams.get("code")!,
        redirect_uri: uri,
        code_verifier: verifier,
      };
      const exchange = (data: typeof grant) =>
        fetch(`${origin}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(data),
        });
      expect(
        (await exchange({ ...grant, code_verifier: "w".repeat(43) })).status,
      ).toBe(400);
      const token = await exchange(grant);
      expect(token.status).toBe(200);
      expect(
        ((await token.json()) as { access_token: string }).access_token,
      ).toMatch(/^mcp_token_/);
      expect((await exchange(grant)).status).toBe(400);
    });

    it("preserves authorize for an already authenticated terminal request", async () => {
      const response = await get(
        `/oauth/authorize?${new URLSearchParams({ ...params, response_type: "code" })}`,
      );
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("location")!).origin).toBe(
        "http://127.0.0.1:34219",
      );
      expect(await countCodes()).toBe(1);
    });

    it("revalidates client registration after login", async () => {
      const response = await get(
        `/oauth/authorize?${new URLSearchParams({ ...params, response_type: "code" })}`,
        "",
      );
      const resume = new URL(
        response.headers.get("location")!,
      ).searchParams.get("callbackUrl")!;
      await pool.query("UPDATE oauth_clients SET redirect_uris = $1", [
        ["http://localhost:12345/changed"],
      ]);
      await expectRejected(resume);
    });

    it("applies loopback policy to registration", async () => {
      for (const uri of [redirectUri, "https://oauth-check.invalid/probe"]) {
        const response = await fetch(`${origin}/oauth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ redirect_uris: [uri] }),
        });
        expect(response.status).toBe(uri === redirectUri ? 201 : 400);
      }
    });

    it("allows registered application callbacks and displays its own callback as plain text", async () => {
      const uri = `${origin}/oauth/callback`;
      await pool.query("UPDATE oauth_clients SET redirect_uris = $1", [[uri]]);
      const response = await get(callback({ ...params, redirect_uri: uri }));
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!);
      expect(location.origin + location.pathname).toBe(uri);
      location.searchParams.set("state", "<script>alert(1)</script>");
      const display = await get(location.toString());
      expect(display.status).toBe(200);
      expect(display.headers.get("content-type")).toContain("text/plain");
    });

    it("revalidates stored code redirects, including legacy self-callback targets", async () => {
      const insert = async (uri: string) => {
        await pool.query("DELETE FROM oauth_authorization_codes");
        await pool.query(
          "INSERT INTO oauth_authorization_codes (code,client_id,redirect_uri,user_id,code_challenge,code_challenge_method,expires_at) VALUES ('test-code','client',$1,$2,$3,'S256',NOW()+INTERVAL '10 minutes')",
          [uri, userId, challenge],
        );
      };
      for (const uri of [
        "https://oauth-check.invalid/probe",
        `${origin}/oauth/callback`,
        "http://127.0.0.1:34220/other",
      ]) {
        await insert(uri);
        const response = await get("/oauth/callback?code=test-code");
        expect(response.status).toBe(400);
        expect(response.headers.get("location")).toBeNull();
      }
      await insert(redirectUri);
      const allowed = await get("/oauth/callback?code=test-code&state=test");
      expect(allowed.status).toBe(302);
      expect(new URL(allowed.headers.get("location")!).origin).toBe(
        "http://127.0.0.1:34219",
      );
      // A local callback path containing /oauth/callback is still a terminal URL;
      // it must not trigger the removed HTML code-display branch.
      const local = "http://127.0.0.1:34219/oauth/callback";
      await pool.query("UPDATE oauth_clients SET redirect_uris = $1", [
        [local],
      ]);
      await insert(local);
      expect((await get("/oauth/callback?code=test-code")).status).toBe(302);
    });
  },
);
