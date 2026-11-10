export interface LocalAuthPolicy {
  basicAuthDisabled: boolean | null;
  signupDisabled: boolean | null;
}

interface LocalAuthConfig {
  getBasicAuthDisabled: { query: () => Promise<boolean> };
  getSignupDisabled: { query: () => Promise<boolean> };
}

export type RegistrationPolicy =
  "allowed" | "signup-disabled" | "basic-auth-disabled" | "unavailable";

async function readDisabledFlag(
  query: () => Promise<boolean>,
): Promise<boolean | null> {
  try {
    const disabled = await query();
    return typeof disabled === "boolean" ? disabled : null;
  } catch {
    // Unknown policy must never enable a local authentication path.
    return null;
  }
}

export async function loadLocalAuthPolicy(
  config: LocalAuthConfig,
): Promise<LocalAuthPolicy> {
  const [basicAuthDisabled, signupDisabled] = await Promise.all([
    readDisabledFlag(() => config.getBasicAuthDisabled.query()),
    readDisabledFlag(() => config.getSignupDisabled.query()),
  ]);
  return { basicAuthDisabled, signupDisabled };
}

export function canSignInLocally(policy: LocalAuthPolicy | null): boolean {
  return policy?.basicAuthDisabled === false;
}

export function getLocalRegistrationPolicy(
  policy: LocalAuthPolicy | null,
): RegistrationPolicy {
  if (
    !policy ||
    policy.basicAuthDisabled === null ||
    policy.signupDisabled === null
  ) {
    return "unavailable";
  }
  if (policy.signupDisabled) return "signup-disabled";
  if (policy.basicAuthDisabled) return "basic-auth-disabled";
  return "allowed";
}
