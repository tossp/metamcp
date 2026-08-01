import { describe, expect, it, vi } from "vitest";

vi.mock("../../db/repositories", () => ({
  oauthRepository: { upsertClient: vi.fn() },
}));

const { OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED, OAUTH_GRANT_TYPES_SUPPORTED } =
  await import("./metadata");
const { SUPPORTED_REGISTRATION_GRANT_TYPES } = await import("./registration");

describe("OAuth advertised capabilities", () => {
  it("advertises only S256 PKCE", () => {
    expect(OAUTH_CODE_CHALLENGE_METHODS_SUPPORTED).toEqual(["S256"]);
  });

  it("keeps registration and metadata aligned with implemented grants", () => {
    expect(SUPPORTED_REGISTRATION_GRANT_TYPES).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
    expect(OAUTH_GRANT_TYPES_SUPPORTED).toEqual(
      SUPPORTED_REGISTRATION_GRANT_TYPES,
    );
    expect(SUPPORTED_REGISTRATION_GRANT_TYPES).not.toContain(
      "client_credentials",
    );
  });
});
