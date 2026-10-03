import {
  type OAuthAuthorizationParams,
  OAuthAuthorizationParamsSchema,
} from "@repo/zod-types";
import express from "express";

import logger from "@/utils/logger";

import { auth } from "../../auth";
import { oauthRepository } from "../../db/repositories";
import {
  generateSecureAuthCode,
  getBaseUrl,
  isRegisteredRedirectUri,
  rateLimitAuth,
  validateRedirectUri,
} from "./utils";

const authorizationRouter = express.Router();

function invalidAuthorization(res: express.Response) {
  return res.status(400).json({
    error: "invalid_request",
    error_description:
      "Invalid authorization parameters or unregistered redirect_uri",
  });
}

/**
 * OAuth 2.0 Authorization Endpoint
 * Handles authorization requests from MCP clients
 */
authorizationRouter.get("/oauth/authorize", rateLimitAuth, async (req, res) => {
  try {
    const {
      response_type,
      client_id,
      redirect_uri,
      scope,
      state,
      code_challenge,
      code_challenge_method,
    } = req.query;

    logger.info("OAuth authorize request:", {
      response_type,
      client_id,
      redirect_uri,
      scope,
      state,
      code_challenge_method,
    });

    // Validate required parameters
    if (response_type !== "code") {
      return res.status(400).json({
        error: "unsupported_response_type",
        error_description: "Only 'code' response type is supported",
      });
    }

    const parsed = OAuthAuthorizationParamsSchema.safeParse({
      client_id,
      redirect_uri,
      scope,
      state,
      code_challenge,
      code_challenge_method,
    });
    if (!parsed.success) return invalidAuthorization(res);
    const oauthParams = parsed.data;

    // OAuth 2.1 Security: Validate redirect URI format
    if (!validateRedirectUri(oauthParams.redirect_uri)) {
      return res.status(400).json({
        error: "invalid_request",
        error_description: "Invalid redirect_uri format or insecure scheme",
      });
    }

    // Validate client_id against registered clients
    const clientData = await oauthRepository.getClient(oauthParams.client_id);
    const finalClientId = oauthParams.client_id; // Track which client_id to use

    if (!clientData) {
      // Client not found - direct them to use dynamic client registration
      const baseUrl = getBaseUrl(req);
      return res.status(400).json({
        error: "invalid_client",
        error_description:
          "Client not registered. Please register your client first.",
        registration_endpoint: `${baseUrl}/oauth/register`,
        documentation:
          "Use the registration endpoint to dynamically register your OAuth client before authorization.",
      });
    } else {
      // Validate redirect_uri against registered redirect_uris for existing clients
      if (!isRegisteredRedirectUri(oauthParams.redirect_uri, clientData)) {
        return res.status(400).json({
          error: "invalid_request",
          error_description: "redirect_uri is not registered for this client",
        });
      }
    }

    logger.info(
      `Using client_id: ${finalClientId} (original: ${client_id}) for redirect_uri: ${redirect_uri}`,
    );

    const baseUrl = getBaseUrl(req);

    // Check if user is already authenticated by verifying better-auth session
    if (req.headers.cookie) {
      try {
        // Verify the session using better-auth
        const sessionUrl = new URL("/api/auth/get-session", baseUrl);
        const headers = new Headers();
        headers.set("cookie", req.headers.cookie);

        const sessionRequest = new Request(sessionUrl.toString(), {
          method: "GET",
          headers,
        });

        const sessionResponse = await auth.handler(sessionRequest);

        if (sessionResponse.ok) {
          const sessionData = (await sessionResponse.json()) as {
            user?: { id: string };
          };

          if (sessionData?.user?.id) {
            // User is already authenticated, generate authorization code directly
            const code = generateSecureAuthCode();

            // Store authorization code with associated data
            await oauthRepository.setAuthCode(code, {
              client_id: oauthParams.client_id,
              redirect_uri: oauthParams.redirect_uri,
              scope: oauthParams.scope || "admin",
              user_id: sessionData.user.id,
              code_challenge: oauthParams.code_challenge,
              code_challenge_method: oauthParams.code_challenge_method,
              expires_at: Date.now() + 10 * 60 * 1000, // 10 minutes
            });

            // Redirect back to the MCP client with authorization code
            const redirectUrl = new URL(oauthParams.redirect_uri);
            redirectUrl.searchParams.set("code", code);
            if (oauthParams.state) {
              redirectUrl.searchParams.set("state", oauthParams.state);
            }

            return res.redirect(redirectUrl.toString());
          }
        }
      } catch (error) {
        logger.info("Session verification failed, proceeding to login:", error);
        // Continue to login flow if session verification fails
      }
    }

    // User is not authenticated, redirect to login page
    const authUrl = new URL("/login", baseUrl);
    const encodedParams = Buffer.from(JSON.stringify(oauthParams)).toString(
      "base64url",
    );
    authUrl.searchParams.set(
      "callbackUrl",
      `/oauth/callback?params=${encodedParams}`,
    );

    // Redirect to frontend login page
    res.redirect(authUrl.toString());
  } catch (error) {
    logger.error("Error in OAuth authorize endpoint:", error);
    res.status(500).json({
      error: "server_error",
      error_description: "Internal server error",
    });
  }
});

/**
 * OAuth 2.0 Callback Handler
 * Handles the callback from frontend login and redirects back to the OAuth client
 * Verifies user authentication before issuing authorization code
 */
authorizationRouter.get("/oauth/callback", async (req, res) => {
  try {
    let oauthParams: OAuthAuthorizationParams;

    // Check if we have encoded params (from our internal redirect flow)
    const { params } = req.query;

    if (params !== undefined) {
      if (
        Object.keys(req.query).length !== 1 ||
        typeof params !== "string" ||
        params.length > 16384 ||
        !/^[A-Za-z0-9_-]+$/.test(params)
      )
        return invalidAuthorization(res);
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(params, "base64url").toString("utf8"));
      } catch {
        return invalidAuthorization(res);
      }
      const parsed = OAuthAuthorizationParamsSchema.safeParse(decoded);
      if (!parsed.success) return invalidAuthorization(res);
      oauthParams = parsed.data;
    } else {
      // Handle direct callback with individual query parameters
      // This is likely from an external OAuth flow or direct URL access
      const { code, state } = req.query;

      if (
        typeof code !== "string" ||
        !code ||
        (state !== undefined && typeof state !== "string") ||
        Object.keys(req.query).some((key) => key !== "code" && key !== "state")
      )
        return invalidAuthorization(res);

      // If we receive a code directly, look up the code data to get the original parameters
      const codeData = await oauthRepository.getAuthCode(code as string);
      if (codeData) {
        // Check if code has expired
        if (Date.now() > codeData.expires_at.getTime()) {
          await oauthRepository.deleteAuthCode(code as string);
          return res.status(400).send("Authorization code has expired");
        }

        const client = await oauthRepository.getClient(codeData.client_id);
        if (!isRegisteredRedirectUri(codeData.redirect_uri, client))
          return invalidAuthorization(res);

        // Exact local endpoint check, not a substring of a terminal callback.
        const target = new URL(codeData.redirect_uri);
        const internalCallback = new URL("/oauth/callback", getBaseUrl(req));
        if (
          target.origin === internalCallback.origin &&
          target.pathname === internalCallback.pathname
        ) {
          return res
            .type("text/plain")
            .send(
              `OAuth authorization successful\nAuthorization code: ${code}\nState: ${state ?? "none"}\n`,
            );
        }

        // Code exists and is valid, redirect back to the original redirect_uri
        const redirectUrl = new URL(codeData.redirect_uri);
        redirectUrl.searchParams.set("code", code as string);
        if (state) {
          redirectUrl.searchParams.set("state", state as string);
        }
        return res.redirect(redirectUrl.toString());
      } else {
        return res.status(400).json({
          error: "invalid_request",
          error_description: "Invalid authorization parameters",
        });
      }
    }

    const { client_id, redirect_uri, state } = oauthParams;

    // This endpoint is publicly reachable: never assume /authorize ran first.
    const client = await oauthRepository.getClient(client_id);
    if (!isRegisteredRedirectUri(redirect_uri, client))
      return invalidAuthorization(res);

    // Verify user authentication by checking session cookies
    if (!req.headers.cookie) {
      // Redirect back to login if no authentication
      const baseUrl = getBaseUrl(req);
      const loginUrl = new URL("/login", baseUrl);
      loginUrl.searchParams.set("callbackUrl", req.originalUrl);
      return res.redirect(loginUrl.toString());
    }

    // Verify the session using better-auth
    const sessionUrl = new URL("/api/auth/get-session", getBaseUrl(req));
    const headers = new Headers();
    headers.set("cookie", req.headers.cookie);

    const sessionRequest = new Request(sessionUrl.toString(), {
      method: "GET",
      headers,
    });

    const sessionResponse = await auth.handler(sessionRequest);

    if (!sessionResponse.ok) {
      // Redirect back to login if session invalid
      const baseUrl = getBaseUrl(req);
      const loginUrl = new URL("/login", baseUrl);
      loginUrl.searchParams.set("callbackUrl", req.originalUrl);
      return res.redirect(loginUrl.toString());
    }

    const sessionData = (await sessionResponse.json()) as {
      user?: { id: string };
    };

    if (!sessionData?.user?.id) {
      // Redirect back to login if no user
      const baseUrl = getBaseUrl(req);
      const loginUrl = new URL("/login", baseUrl);
      loginUrl.searchParams.set("callbackUrl", req.originalUrl);
      return res.redirect(loginUrl.toString());
    }

    // User is authenticated, generate authorization code
    const code = generateSecureAuthCode();

    // Store authorization code with associated data
    await oauthRepository.setAuthCode(code, {
      client_id,
      redirect_uri,
      scope: oauthParams.scope || "admin",
      user_id: sessionData.user.id,
      code_challenge: oauthParams.code_challenge,
      code_challenge_method: oauthParams.code_challenge_method,
      expires_at: Date.now() + 10 * 60 * 1000, // 10 minutes
    });

    // Redirect back to the MCP client with authorization code
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (state) {
      redirectUrl.searchParams.set("state", state);
    }

    res.redirect(redirectUrl.toString());
  } catch (error) {
    logger.error("Error in OAuth callback:", error);
    res.status(500).send("OAuth callback error");
  }
});

export default authorizationRouter;
