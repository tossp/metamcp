import assert from "node:assert/strict";
import test from "node:test";

import { requireOAuthPersistence } from "./oauth-persistence.ts";

test("rejects when the persistence request throws", async () => {
  await assert.rejects(
    requireOAuthPersistence(async () => {
      throw new Error("network down");
    }, "state persistence failed"),
    /network down/,
  );
});

test("rejects unsuccessful persistence responses", async () => {
  await assert.rejects(
    requireOAuthPersistence(
      async () => ({ success: false, error: "resource unavailable" }),
      "code verifier persistence failed",
    ),
    /resource unavailable/,
  );
});

test("resolves only after a successful persistence response", async () => {
  await assert.doesNotReject(
    requireOAuthPersistence(
      async () => ({ success: true }),
      "persistence failed",
    ),
  );
});
