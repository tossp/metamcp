import type { OAuthClient } from "@repo/zod-types";
import { randomBytes } from "crypto";
import express from "express";

import logger from "@/utils/logger";

export function isValidS256CodeChallenge(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function hasValidS256Pkce(
  codeChallenge: unknown,
  codeChallengeMethod: unknown,
): codeChallenge is string {
  return (
    codeChallengeMethod === "S256" && isValidS256CodeChallenge(codeChallenge)
  );
}

/**
 * Generate cryptographically secure authorization code
 * Follows OAuth 2.1 security requirements
 */
export function generateSecureAuthCode(): string {
  const randomPart = randomBytes(32).toString("base64url");
  return `mcp_code_${randomPart}`;
}

/**
 * Generate cryptographically secure access token
 * Follows OAuth 2.1 security requirements
 */
export function generateSecureAccessToken(): string {
  const randomPart = randomBytes(32).toString("base64url");
  return `mcp_token_${randomPart}`;
}

/**
 * Generate cryptographically secure refresh token
 * Follows OAuth 2.1 security requirements
 */
export function generateSecureRefreshToken(): string {
  const randomPart = randomBytes(32).toString("base64url");
  return `mcp_refresh_${randomPart}`;
}

/**
 * Generate cryptographically secure client ID
 * Follows OAuth 2.1 security requirements
 */
export function generateSecureClientId(): string {
  const randomPart = randomBytes(16).toString("base64url");
  return `mcp_client_${randomPart}`;
}

/**
 * Generate cryptographically secure client secret
 * Follows OAuth 2.1 security requirements
 */
export function generateSecureClientSecret(): string {
  const randomPart = randomBytes(32).toString("base64url");
  return `mcp_secret_${randomPart}`;
}

/** Application-origin or native HTTP loopback; registration matching is separate. */
export function validateRedirectUri(
  uri: unknown,
  allowedHosts?: string[],
): boolean {
  try {
    if (
      typeof uri !== "string" ||
      /[\s\\]/.test(uri) ||
      uri.includes("#") ||
      /^https?:\/\/[^/?#]*@/i.test(uri)
    )
      return false;
    const parsedUri = new URL(uri);
    if (
      !["https:", "http:"].includes(parsedUri.protocol) ||
      parsedUri.username ||
      parsedUri.password
    )
      return false;
    // Check the literal authority too: URL() normalizes short/decimal/hex IPv4
    // and expanded IPv6. Those aliases are not part of our native-client policy.
    const loopback =
      parsedUri.protocol === "http:" &&
      /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?]|$)/i.test(
        uri,
      );
    let applicationOrigin = false;
    if (process.env.APP_URL) {
      try {
        const application = new URL(process.env.APP_URL);
        applicationOrigin =
          ["https:", "http:"].includes(application.protocol) &&
          !application.username &&
          !application.password &&
          parsedUri.origin === application.origin;
      } catch {
        // Invalid configuration never enables arbitrary external redirects.
      }
    }
    if (!loopback && !applicationOrigin) return false;
    return !allowedHosts?.length || allowedHosts.includes(parsedUri.hostname);
  } catch {
    return false;
  }
}

export function isRegisteredRedirectUri(
  uri: unknown,
  client: Pick<OAuthClient, "redirect_uris"> | null,
): uri is string {
  return (
    typeof uri === "string" &&
    validateRedirectUri(uri) &&
    !!client?.redirect_uris.includes(uri)
  );
}

/**
 * Helper function to get the correct base URL from request
 * Prioritizes APP_URL environment variable, then checks proxy headers
 */
export function getBaseUrl(req: express.Request): string {
  // Prioritize APP_URL environment variable
  if (process.env.APP_URL) {
    return process.env.APP_URL;
  }

  // Check for forwarded headers from Next.js proxy
  const forwardedHost = req.headers["x-forwarded-host"] as string;
  const forwardedProto = req.headers["x-forwarded-proto"] as string;

  if (forwardedHost) {
    const protocol = forwardedProto || "http";
    return `${protocol}://${forwardedHost}`;
  }

  // Fallback to request host
  return `${req.protocol}://${req.get("host")}`;
}

/**
 * Middleware to add JSON parsing for OAuth POST endpoints
 */
export function jsonParsingMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  // Only apply JSON parsing for OAuth POST endpoints that need parsed body
  const needsJsonParsing =
    (req.path.startsWith("/oauth/") && req.method === "POST") ||
    (req.path === "/oauth/register" && req.method === "POST");

  if (needsJsonParsing) {
    return express.json({
      limit: "10mb",
      type: "application/json",
    })(req, res, next);
  }
  next();
}

/**
 * Middleware to add URL-encoded form parsing for OAuth POST endpoints
 */
export function urlencodedParsingMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  // Only apply URL-encoded parsing for OAuth POST endpoints
  const needsUrlencodedParsing =
    (req.path.startsWith("/oauth/") && req.method === "POST") ||
    (req.path === "/oauth/register" && req.method === "POST");

  if (needsUrlencodedParsing) {
    return express.urlencoded({
      extended: true,
      limit: "10mb",
    })(req, res, next);
  }
  next();
}

/**
 * Simple in-memory rate limiter for OAuth endpoints
 * In production, use Redis or similar for distributed rate limiting
 */
class RateLimiter {
  private attempts: Map<string, { count: number; resetTime: number }> =
    new Map();
  private maxAttempts: number;
  private windowMs: number;

  constructor(maxAttempts: number = 10, windowMs: number = 15 * 60 * 1000) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }

  isRateLimited(identifier: string): boolean {
    const now = Date.now();
    const record = this.attempts.get(identifier);

    if (!record || now > record.resetTime) {
      // Reset or create new record
      this.attempts.set(identifier, {
        count: 1,
        resetTime: now + this.windowMs,
      });
      return false;
    }

    if (record.count >= this.maxAttempts) {
      return true;
    }

    record.count++;
    return false;
  }

  reset(identifier: string): void {
    this.attempts.delete(identifier);
  }

  // Clean up old entries periodically
  cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.attempts) {
      if (now > record.resetTime) {
        this.attempts.delete(key);
      }
    }
  }
}

// Create rate limiter instances
const authEndpointLimiter = new RateLimiter(20, 1 * 60 * 1000); // 20 attempts per 1 minute
const tokenEndpointLimiter = new RateLimiter(20, 1 * 60 * 1000); // 20 attempts per 1 minute

// Clean up rate limiter entries every 10 minutes
setInterval(
  () => {
    authEndpointLimiter.cleanup();
    tokenEndpointLimiter.cleanup();
  },
  10 * 60 * 1000,
);

/**
 * Rate limiting middleware for OAuth authorization endpoint
 */
export function rateLimitAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const identifier = req.ip || req.socket?.remoteAddress || "unknown";

  if (authEndpointLimiter.isRateLimited(identifier)) {
    logger.info(
      `[RATE LIMIT] Authorization endpoint rate limited for IP: ${identifier} - Too many authorization attempts`,
    );
    return res.status(429).json({
      error: "too_many_requests",
      error_description:
        "Too many authorization attempts. Please try again later.",
    });
  }

  next();
}

/**
 * Rate limiting middleware for OAuth token endpoint
 */
export function rateLimitToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const identifier = req.ip || req.socket?.remoteAddress || "unknown";

  if (tokenEndpointLimiter.isRateLimited(identifier)) {
    logger.info(
      `[RATE LIMIT] Token endpoint rate limited for IP: ${identifier} - Too many token requests`,
    );
    return res.status(429).json({
      error: "too_many_requests",
      error_description: "Too many token requests. Please try again later.",
    });
  }

  next();
}

/**
 * Security headers middleware for OAuth endpoints
 * Prevents common web vulnerabilities
 */
export function securityHeaders(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  // Prevent clickjacking
  res.setHeader("X-Frame-Options", "DENY");

  // Prevent MIME type sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");

  // XSS protection
  res.setHeader("X-XSS-Protection", "1; mode=block");

  // Referrer policy
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // Content Security Policy for OAuth pages
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none';",
  );

  // Cache control for sensitive endpoints
  if (req.path.includes("/oauth/")) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }

  next();
}
