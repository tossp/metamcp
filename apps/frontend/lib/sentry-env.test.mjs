import assert from "node:assert/strict";
import test from "node:test";

import { parseSentryDsn, serializeSentryDsn } from "./sentry-env.ts";

test("escapes script termination and HTML characters in runtime configuration", () => {
  const input = "</script><script>&\u2028\u2029";
  const serialized = serializeSentryDsn(input);
  assert.equal(/[<>&\u2028\u2029]/u.test(serialized), false);
  assert.equal(JSON.parse(serialized).dsn, input);
});

test("accepts a public DSN, including a self-hosted path prefix", () => {
  for (const dsn of [
    "https://public@example.invalid/9",
    "https://public@example.invalid/sentry/9",
  ]) {
    assert.equal(parseSentryDsn(serializeSentryDsn(dsn)), dsn);
  }
});

test("rejects missing, malformed, non-DSN and secret-bearing configuration", () => {
  for (const value of [
    null,
    [],
    {},
    { dsn: 9 },
    { dsn: "" },
    { dsn: " " },
    { dsn: "javascript:alert(1)" },
    { dsn: "https://example.invalid/9" },
    { dsn: "https://public:secret@example.invalid/9" },
    { dsn: "https://public@example.invalid/9?token=private" },
    { dsn: "https://public@example.invalid/9#fragment" },
    { dsn: "https://public@example.invalid/no-project" },
    { dsn: "https://public@example.invalid/9", token: "private" },
  ]) {
    assert.equal(parseSentryDsn(JSON.stringify(value)), undefined);
  }
  assert.equal(parseSentryDsn("not-json"), undefined);
});
