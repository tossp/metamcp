import { createHash } from "node:crypto";

import type { OAuthTokenPairInput } from "../../db/repositories/oauth.repo";
import { generateSecureAccessToken, generateSecureRefreshToken } from "./utils";

export const ACCESS_TOKEN_EXPIRY = 3600;
export const REFRESH_TOKEN_EXPIRY = 7 * 24 * 3600;

export interface PreparedTokenPair {
  persistence: OAuthTokenPairInput;
  accessToken: string;
  refreshToken: string;
}

export function prepareTokenPair(now = Date.now()): PreparedTokenPair {
  const accessToken = generateSecureAccessToken();
  const refreshToken = generateSecureRefreshToken();

  return {
    accessToken,
    refreshToken,
    persistence: {
      access_token: accessToken,
      expires_at: now + ACCESS_TOKEN_EXPIRY * 1000,
      refresh_token: refreshToken,
      refresh_token_expires_at: now + REFRESH_TOKEN_EXPIRY * 1000,
    },
  };
}

export function pkceChallengeFromVerifier(verifier: string): string {
  return createHash("sha256")
    .update(Buffer.from(verifier, "utf8"))
    .digest("base64url");
}

export function isValidPkceVerifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 43 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._~-]+$/.test(value)
  );
}
