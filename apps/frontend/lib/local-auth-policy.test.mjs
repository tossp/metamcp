import assert from "node:assert/strict";
import test from "node:test";

import {
  canSignInLocally,
  getLocalRegistrationPolicy,
  loadLocalAuthPolicy,
} from "./local-auth-policy.ts";

const configFor = (basicAuthDisabled, signupDisabled) => ({
  getBasicAuthDisabled: { query: async () => basicAuthDisabled },
  getSignupDisabled: { query: async () => signupDisabled },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

test("initial/loading policy never enables local login or registration", () => {
  assert.equal(canSignInLocally(null), false);
  assert.equal(getLocalRegistrationPolicy(null), "unavailable");
});

for (const [basic, signup, signInAllowed, registration] of [
  [false, false, true, "allowed"],
  [true, false, false, "basic-auth-disabled"],
  [false, true, true, "signup-disabled"],
  [true, true, false, "signup-disabled"],
]) {
  test(`actual loader/decisions: basic disabled=${basic}, signup disabled=${signup}`, async () => {
    const policy = await loadLocalAuthPolicy(configFor(basic, signup));
    assert.deepEqual(policy, {
      basicAuthDisabled: basic,
      signupDisabled: signup,
    });
    assert.equal(canSignInLocally(policy), signInAllowed);
    assert.equal(getLocalRegistrationPolicy(policy), registration);
  });
}

test("both reads start concurrently and no policy resolves before both complete", async () => {
  const basic = deferred();
  const signup = deferred();
  const calls = [];
  const loading = loadLocalAuthPolicy({
    getBasicAuthDisabled: {
      query: () => {
        calls.push("basic");
        return basic.promise;
      },
    },
    getSignupDisabled: {
      query: () => {
        calls.push("signup");
        return signup.promise;
      },
    },
  });
  let settled = false;
  void loading.then(() => (settled = true));
  assert.deepEqual(calls, ["basic", "signup"]);
  basic.resolve(false);
  await Promise.resolve();
  assert.equal(settled, false);
  signup.resolve(false);
  assert.equal(getLocalRegistrationPolicy(await loading), "allowed");
});

for (const field of ["getBasicAuthDisabled", "getSignupDisabled"]) {
  for (const synchronous of [false, true]) {
    test(`${field} ${synchronous ? "throws" : "rejects"}: actual loader fails closed`, async () => {
      const config = configFor(false, false);
      config[field].query = () => {
        const error = new Error("configuration unavailable");
        if (synchronous) throw error;
        return Promise.reject(error);
      };
      const policy = await loadLocalAuthPolicy(config);
      assert.equal(
        canSignInLocally(policy),
        field !== "getBasicAuthDisabled",
        "signup discovery failure must not disable established password login",
      );
      assert.equal(getLocalRegistrationPolicy(policy), "unavailable");
      assert.equal(
        field === "getBasicAuthDisabled"
          ? policy.basicAuthDisabled
          : policy.signupDisabled,
        null,
      );
    });
  }
}

for (const invalid of [undefined, null, "false", 0, {}]) {
  test(`non-boolean config cannot enable local paths (${JSON.stringify(invalid)})`, async () => {
    const unknownBasic = await loadLocalAuthPolicy(configFor(invalid, false));
    assert.equal(canSignInLocally(unknownBasic), false);
    assert.equal(getLocalRegistrationPolicy(unknownBasic), "unavailable");
    const unknownSignup = await loadLocalAuthPolicy(configFor(false, invalid));
    assert.equal(getLocalRegistrationPolicy(unknownSignup), "unavailable");
  });
}

test("fresh reads reflect policy changes without relying on previously allowed values", async () => {
  const config = configFor(false, false);
  const previous = await loadLocalAuthPolicy(config);
  assert.equal(getLocalRegistrationPolicy(previous), "allowed");

  config.getBasicAuthDisabled.query = async () => true;
  const basicDisabled = await loadLocalAuthPolicy(config);
  assert.equal(
    getLocalRegistrationPolicy(basicDisabled),
    "basic-auth-disabled",
  );
  assert.equal(canSignInLocally(basicDisabled), false);

  config.getBasicAuthDisabled.query = async () => false;
  config.getSignupDisabled.query = async () => true;
  assert.equal(
    getLocalRegistrationPolicy(await loadLocalAuthPolicy(config)),
    "signup-disabled",
  );

  config.getSignupDisabled.query = async () => {
    throw new Error("configuration unavailable");
  };
  assert.equal(
    getLocalRegistrationPolicy(await loadLocalAuthPolicy(config)),
    "unavailable",
  );
  assert.equal(getLocalRegistrationPolicy(previous), "allowed");
});

test("local policy discovery does not request SSO provider settings", async () => {
  const config = {
    ...configFor(true, false),
    getAuthProviders: {
      query: () => assert.fail("SSO discovery remains the existing page flow"),
    },
  };
  assert.equal(
    getLocalRegistrationPolicy(await loadLocalAuthPolicy(config)),
    "basic-auth-disabled",
  );
});
