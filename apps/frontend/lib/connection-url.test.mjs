import assert from "node:assert/strict";
import test from "node:test";

import { buildConnectionUrl } from "./connection-url.ts";

const appUrl = "https://app.example.invalid";
const configId = "a5e1cbd3-6f80-4a8d-9dc5-18ff61c6a49e";
const options = {
  mcpServerUuid: configId,
  transportType: "STDIO",
  url: "",
};

test("saved STDIO URL contains only configId and transportType, never launch data", () => {
  const password = "virtual-password-37&+/= ?#";
  const launchData = {
    command: "private-command-37",
    args: `--private-argument-37 --password=${password}`,
    env: { PASSWORD: password },
    url: `https://upstream.example.invalid/?password=${password}`,
    bearerToken: password,
    includeInactiveServers: true,
  };
  const result = buildConnectionUrl({ ...options, ...launchData }, appUrl);
  assert.equal(result.origin, appUrl);
  assert.equal(result.pathname, "/mcp-proxy/server/stdio");
  assert.deepEqual(
    [...result.searchParams],
    [
      ["configId", configId],
      ["transportType", "STDIO"],
    ],
  );
  for (const secret of [password, launchData.command, launchData.args]) {
    assert.equal(result.href.includes(secret), false);
    assert.equal(decodeURIComponent(result.href).includes(secret), false);
  }
  assert.equal(result.hash, "");
});

test("saved STDIO fails closed on missing, malformed or injected IDs", () => {
  for (const mcpServerUuid of [
    undefined,
    null,
    "",
    " ",
    "not-a-uuid",
    `${configId}&command=override`,
    `${configId}\n`,
    37,
    {},
  ]) {
    assert.throws(
      () => buildConnectionUrl({ ...options, mcpServerUuid }, appUrl),
      { message: "A valid saved STDIO configuration ID is required" },
    );
  }
});

for (const [transportType, path] of [
  ["SSE", "/mcp-proxy/server/sse"],
  ["STREAMABLE_HTTP", "/mcp-proxy/server/mcp"],
]) {
  test(`${transportType} preserves upstream URL and transport query semantics`, () => {
    const url = "https://upstream.example.invalid/mcp?scope=a%20b&mode=1";
    const result = buildConnectionUrl(
      { ...options, mcpServerUuid: "", transportType, url },
      appUrl,
    );
    assert.equal(result.pathname, path);
    assert.deepEqual(
      [...result.searchParams],
      [
        ["url", url],
        ["transportType", transportType],
      ],
    );
  });
}

test("MetaMCP preserves relative/absolute URLs and includeInactiveServers behavior", () => {
  for (const url of [
    `/mcp-proxy/metamcp/${configId}/sse?existing=value`,
    "https://metamcp.example.invalid/sse?existing=value",
  ]) {
    for (const includeInactiveServers of [false, true]) {
      const result = buildConnectionUrl(
        {
          ...options,
          mcpServerUuid: "",
          isMetaMCP: true,
          url,
          includeInactiveServers,
        },
        appUrl,
      );
      const expected = new URL(url, appUrl);
      if (includeInactiveServers) {
        expected.searchParams.append("includeInactiveServers", "true");
      }
      assert.equal(result.href === expected.href, true);
    }
  }
});

test("unknown transport fails without falling back to raw STDIO", () => {
  assert.throws(
    () => buildConnectionUrl({ ...options, transportType: "unknown" }, appUrl),
    { message: "Unsupported transport type" },
  );
});
