import { afterEach, describe, expect, it, vi } from "vitest";

import { hasValidS256Pkce, validateRedirectUri } from "./utils";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("validateRedirectUri", () => {
  it.each([
    "http://LOCALHOST:49152/callback",
    "http://127.0.0.1:49153/callback",
    "http://[::1]:49154/callback",
  ])("accepts native HTTP loopback: %s", (uri) => {
    expect(validateRedirectUri(uri)).toBe(true);
  });

  it.each([
    "https://example.com/callback",
    "http://example.com/callback",
    "http://192.168.1.10/callback",
    "http://localhost.example.com/callback",
    "http://localhost./callback",
    "http://127.1/callback",
    "http://2130706433/callback",
    "http://0x7f000001/callback",
    "http://[0:0:0:0:0:0:0:1]/callback",
    "http://localhost@evil.example/callback",
    "http://user:password@localhost/callback",
    "http://@localhost/callback",
    "http://localhost/callback#fragment",
    "http://localhost/callback#",
    "https://localhost/callback",
    "http://localhost:99999/callback",
    " http://localhost/callback",
    "javascript:alert(1)",
    ["http://localhost/callback"],
    { toString: () => "http://localhost/callback" },
    null,
  ])("rejects other targets or ambiguous input: %j", (uri) => {
    vi.stubEnv("APP_URL", "https://gateway.example");
    expect(validateRedirectUri(uri)).toBe(false);
  });

  it("allows only the exact configured application origin", () => {
    vi.stubEnv("APP_URL", "https://gateway.example/");
    expect(validateRedirectUri("https://gateway.example/oauth/callback")).toBe(
      true,
    );
    expect(validateRedirectUri("http://gateway.example/oauth/callback")).toBe(
      false,
    );
    expect(
      validateRedirectUri("https://gateway.example:8443/oauth/callback"),
    ).toBe(false);
    expect(
      validateRedirectUri(
        "https://gateway.example.evil.example/oauth/callback",
      ),
    ).toBe(false);
    expect(validateRedirectUri("https://@gateway.example/oauth/callback")).toBe(
      false,
    );
    expect(validateRedirectUri("https://gateway.example/oauth/callback#")).toBe(
      false,
    );
    vi.stubEnv("APP_URL", "https://gateway.example:8443");
    expect(
      validateRedirectUri("https://gateway.example:8443/oauth/callback"),
    ).toBe(true);
    expect(validateRedirectUri("https://gateway.example/oauth/callback")).toBe(
      false,
    );
  });

  it.each(["", "invalid", "https://user:password@gateway.example"])(
    "fails closed for an invalid APP_URL: %s",
    (value) => {
      vi.stubEnv("APP_URL", value);
      expect(
        validateRedirectUri("https://gateway.example/oauth/callback"),
      ).toBe(false);
      expect(validateRedirectUri("http://localhost:49152/callback")).toBe(true);
    },
  );

  it("does not permit external addresses in development either", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_URL", "http://localhost:12008");
    expect(validateRedirectUri("http://192.168.1.10/callback")).toBe(false);
    expect(validateRedirectUri("http://localhost:12008/oauth/callback")).toBe(
      true,
    );
  });

  it("retains the optional allowedHosts constraint", () => {
    expect(
      validateRedirectUri("http://localhost:49152/callback", ["localhost"]),
    ).toBe(true);
    expect(
      validateRedirectUri("http://localhost:49152/callback", ["example.com"]),
    ).toBe(false);
  });
});

describe("hasValidS256Pkce", () => {
  const challenge = "A".repeat(43);

  it("accepts an explicit S256 method with a valid base64url challenge", () => {
    expect(hasValidS256Pkce(challenge, "S256")).toBe(true);
  });

  it.each([
    [undefined, undefined],
    [challenge, undefined],
    [challenge, "plain"],
    ["short", "S256"],
    [`${"A".repeat(42)}=`, "S256"],
  ])("rejects missing, plain, or malformed PKCE: %s / %s", (value, method) => {
    expect(hasValidS256Pkce(value, method)).toBe(false);
  });
});
