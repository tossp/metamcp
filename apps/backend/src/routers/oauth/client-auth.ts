import { createHash, timingSafeEqual } from "node:crypto";

import type { OAuthClient } from "@repo/zod-types";
import type express from "express";

import type { OAuthRepository } from "../../db/repositories/oauth.repo";

const DUMMY_STORED_SECRET = "metamcp-oauth-dummy-client-secret";

export type ClientAuthenticationResult =
  | { ok: true; client: OAuthClient }
  | {
      ok: false;
      status: 400 | 401;
      error: "invalid_request" | "invalid_client";
      error_description: string;
    };

function secretDigest(secret: string): Buffer {
  return createHash("sha256").update(Buffer.from(secret, "utf8")).digest();
}

export function constantTimeSecretEqual(
  suppliedSecret: string | undefined,
  storedSecret: string | null | undefined,
): boolean {
  const suppliedDigest = secretDigest(suppliedSecret ?? "");
  const storedDigest = secretDigest(storedSecret || DUMMY_STORED_SECRET);
  const equal = timingSafeEqual(suppliedDigest, storedDigest);
  return Boolean(storedSecret) && Boolean(suppliedSecret) && equal;
}

function parseBasicCredentials(
  authorization: string,
): { clientId: string; clientSecret: string } | null {
  const match = /^Basic\s+([^\s]+)$/i.exec(authorization);
  if (!match) return null;

  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 1) return null;
    return {
      clientId: decoded.slice(0, separator),
      clientSecret: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

export async function authenticateTokenClient(
  req: express.Request,
  repository: Pick<OAuthRepository, "getClient">,
): Promise<ClientAuthenticationResult> {
  const body = req.body as Record<string, unknown>;
  const authorization = req.headers.authorization;
  const hasBasic =
    typeof authorization === "string" && /^Basic(?:\s|$)/i.test(authorization);
  const hasBodyClientId = Object.hasOwn(body, "client_id");
  const hasBodySecret = Object.hasOwn(body, "client_secret");

  if (hasBasic && (hasBodyClientId || hasBodySecret)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      error_description:
        "Client credentials must use exactly one authentication method",
    };
  }

  const basic = hasBasic ? parseBasicCredentials(authorization) : null;
  const bodyClientId =
    typeof body.client_id === "string" ? body.client_id : undefined;
  const bodyClientSecret =
    typeof body.client_secret === "string" ? body.client_secret : undefined;
  const presentedClientId = basic?.clientId ?? bodyClientId;

  if (!presentedClientId) {
    constantTimeSecretEqual(basic?.clientSecret ?? bodyClientSecret, null);
    return invalidClient();
  }

  const client = await repository.getClient(presentedClientId);
  if (!client) {
    constantTimeSecretEqual(basic?.clientSecret ?? bodyClientSecret, null);
    return invalidClient();
  }

  if (hasBasic) {
    const secretMatches = constantTimeSecretEqual(
      basic?.clientSecret,
      client.client_secret,
    );
    if (
      !basic ||
      client.token_endpoint_auth_method !== "client_secret_basic" ||
      !secretMatches
    ) {
      return invalidClient();
    }
  } else if (hasBodySecret) {
    const secretMatches = constantTimeSecretEqual(
      bodyClientSecret,
      client.client_secret,
    );
    if (
      !bodyClientId ||
      client.token_endpoint_auth_method !== "client_secret_post" ||
      !secretMatches
    ) {
      return invalidClient();
    }
  } else {
    constantTimeSecretEqual(undefined, client.client_secret);
    if (!bodyClientId || client.token_endpoint_auth_method !== "none") {
      return invalidClient();
    }
  }

  return { ok: true, client };
}

function invalidClient(): ClientAuthenticationResult {
  return {
    ok: false,
    status: 401,
    error: "invalid_client",
    error_description: "Invalid client credentials",
  };
}
