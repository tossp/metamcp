import express from "express";

import logger from "@/utils/logger";

import { oauthRepository } from "../../db/repositories";
import {
  authenticateTokenClient,
  type ClientAuthenticationResult,
} from "./client-auth";
import {
  ACCESS_TOKEN_EXPIRY,
  isValidPkceVerifier,
  pkceChallengeFromVerifier,
  prepareTokenPair,
} from "./token-service";
import { rateLimitToken } from "./utils";

const tokenRouter = express.Router();
const CLIENT_AUTHENTICATION_CHALLENGE = 'Basic realm="oauth", charset="UTF-8"';

function sendClientAuthenticationFailure(
  res: express.Response,
  result: Extract<ClientAuthenticationResult, { ok: false }>,
) {
  if (result.status === 401 && result.error === "invalid_client") {
    res.setHeader("WWW-Authenticate", CLIENT_AUTHENTICATION_CHALLENGE);
  }

  return res.status(result.status).json({
    error: result.error,
    error_description: result.error_description,
  });
}

/**
 * OAuth 2.0 Token Endpoint
 * Handles token exchange requests from MCP clients
 * Supports authorization_code and refresh_token grant types
 */
tokenRouter.post("/oauth/token", rateLimitToken, async (req, res) => {
  try {
    // Check if body was parsed correctly
    if (!req.body || typeof req.body !== "object") {
      logger.error("Token endpoint: req.body is undefined or invalid", {
        bodyType: typeof req.body,
        contentType: req.headers["content-type"],
        method: req.method,
      });
      return res.status(400).json({
        error: "invalid_request",
        error_description:
          "Request body is missing or malformed. Ensure Content-Type is application/json or application/x-www-form-urlencoded",
      });
    }

    const { grant_type } = req.body;

    if (grant_type === "refresh_token") {
      return handleRefreshTokenGrant(req, res);
    }

    if (grant_type === "authorization_code") {
      return handleAuthorizationCodeGrant(req, res);
    }

    return res.status(400).json({
      error: "unsupported_grant_type",
      error_description:
        "Supported grant types: authorization_code, refresh_token",
    });
  } catch (error) {
    logger.error("Error in OAuth token endpoint:", error);
    res.status(500).json({
      error: "server_error",
      error_description: "Internal server error",
    });
  }
});

/**
 * Handle grant_type=authorization_code
 */
export async function handleAuthorizationCodeGrant(
  req: express.Request,
  res: express.Response,
) {
  const { code, redirect_uri, code_verifier } = req.body;

  // Validate authorization code
  if (typeof code !== "string" || !code) {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "Missing authorization code",
    });
  }

  if (!redirect_uri || typeof redirect_uri !== "string") {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "Missing redirect_uri parameter",
    });
  }

  if (code_verifier === undefined) {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "PKCE code verifier is required",
    });
  }

  const clientAuthentication = await authenticateTokenClient(
    req,
    oauthRepository,
  );
  if (!clientAuthentication.ok) {
    return sendClientAuthenticationFailure(res, clientAuthentication);
  }

  if (!isValidPkceVerifier(code_verifier)) {
    return res.status(400).json({
      error: "invalid_grant",
      error_description: "Invalid authorization code or PKCE verifier",
    });
  }

  const pair = prepareTokenPair();
  const codeData = await oauthRepository.consumeAuthorizationCode(
    {
      code,
      client_id: clientAuthentication.client.client_id,
      redirect_uri,
      code_challenge: pkceChallengeFromVerifier(code_verifier),
    },
    pair.persistence,
  );

  if (!codeData) {
    return res.status(400).json({
      error: "invalid_grant",
      error_description: "Invalid or expired authorization code",
    });
  }

  return res.json({
    access_token: pair.accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_EXPIRY,
    refresh_token: pair.refreshToken,
    scope: codeData.scope,
  });
}

/**
 * Handle grant_type=refresh_token
 * Issues a new access token + refresh token pair (token rotation).
 */
export async function handleRefreshTokenGrant(
  req: express.Request,
  res: express.Response,
) {
  const { refresh_token } = req.body;

  if (typeof refresh_token !== "string" || !refresh_token) {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "Missing refresh_token parameter",
    });
  }

  const clientAuthentication = await authenticateTokenClient(
    req,
    oauthRepository,
  );
  if (!clientAuthentication.ok) {
    return sendClientAuthenticationFailure(res, clientAuthentication);
  }

  const pair = prepareTokenPair();
  const tokenData = await oauthRepository.rotateRefreshToken(
    refresh_token,
    clientAuthentication.client.client_id,
    pair.persistence,
  );

  if (!tokenData) {
    return res.status(400).json({
      error: "invalid_grant",
      error_description: "Invalid or expired refresh token",
    });
  }

  return res.json({
    access_token: pair.accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_EXPIRY,
    refresh_token: pair.refreshToken,
    scope: tokenData.scope,
  });
}

/**
 * OAuth 2.0 Token Introspection Endpoint
 * Allows clients to introspect access tokens
 */
tokenRouter.post("/oauth/introspect", async (req, res) => {
  try {
    // Check if body was parsed correctly
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({
        error: "invalid_request",
        error_description: "Request body is missing or malformed",
      });
    }

    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        error: "invalid_request",
        error_description: "Missing token parameter",
      });
    }

    // Check if token exists and is valid
    const tokenData = await oauthRepository.getAccessToken(token);

    if (!tokenData || !token.startsWith("mcp_token_")) {
      return res.json({
        active: false,
      });
    }

    // Check if token has expired
    if (Date.now() > tokenData.expires_at.getTime()) {
      await oauthRepository.deleteAccessToken(token);
      return res.json({
        active: false,
      });
    }

    // Token is active, return introspection details
    res.json({
      active: true,
      scope: tokenData.scope,
      client_id: tokenData.client_id,
      token_type: "Bearer",
      exp: Math.floor(tokenData.expires_at.getTime() / 1000),
      iat: Math.floor(tokenData.created_at.getTime() / 1000),
      sub: tokenData.user_id,
    });
  } catch (error) {
    logger.error("Error in OAuth introspect endpoint:", error);
    res.status(500).json({
      error: "server_error",
      error_description: "Internal server error",
    });
  }
});

/**
 * OAuth 2.0 Token Revocation Endpoint
 * Allows clients to revoke access tokens or refresh tokens
 */
tokenRouter.post("/oauth/revoke", async (req, res) => {
  try {
    // Check if body was parsed correctly
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({
        error: "invalid_request",
        error_description: "Request body is missing or malformed",
      });
    }

    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        error: "invalid_request",
        error_description: "Missing token parameter",
      });
    }

    // Try revoking as access token
    if (await oauthRepository.getAccessToken(token)) {
      await oauthRepository.deleteAccessToken(token);
    } else {
      // Try revoking as refresh token
      const tokenData = await oauthRepository.getByRefreshToken(token);
      if (tokenData) {
        await oauthRepository.deleteAccessToken(tokenData.access_token);
      }
      // RFC 7009: return success even if token doesn't exist
    }

    // RFC 7009 specifies that revocation endpoint should return 200 OK
    res.status(200).send();
  } catch (error) {
    logger.error("Error in OAuth revoke endpoint:", error);
    res.status(500).json({
      error: "server_error",
      error_description: "Internal server error",
    });
  }
});

export default tokenRouter;
