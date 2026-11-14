import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

import {
  isBackendSessionLostError,
  isRecoverableBackendError,
  isSafeToRetryToolCall,
} from "./session-error";

async function rejectedPost(status: number, code: number, message: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL("https://backend.invalid/mcp"),
    {
      sessionId: "stale-session",
      fetch: async () =>
        Response.json(
          { jsonrpc: "2.0", id: 1, error: { code, message } },
          { status },
        ),
    },
  );
  try {
    await transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "write" },
    });
    throw new Error("Expected the transport to reject the POST");
  } catch (error) {
    expect(error).toBeInstanceOf(StreamableHTTPError);
    return error;
  } finally {
    await transport.close();
  }
}

describe("session recovery with the installed Streamable HTTP SDK", () => {
  it.each([-32000, -32001, -32600])(
    "recognizes explicit session rejection with RPC code %s",
    async (code) => {
      for (const message of ["Session not found", "MCP session not found"]) {
        const error = await rejectedPost(404, code, message);
        expect(isBackendSessionLostError(error)).toBe(true);
        expect(isRecoverableBackendError(error)).toBe(true);
        expect(isSafeToRetryToolCall(error, false)).toBe(true);
        expect(
          isBackendSessionLostError(new Error("wrapper", { cause: error })),
        ).toBe(true);
        expect(
          isSafeToRetryToolCall(new Error("wrapper", { cause: error }), false),
        ).toBe(false);
      }
    },
  );

  it.each([
    [404, -32000, "Business failure"],
    [404, -32000, "MCP session not found after writing"],
    [404, -32603, "Internal error"],
    [500, -32000, "Business failure"],
  ] as const)(
    "does not retry unrelated HTTP %s / RPC %s errors",
    async (status, code, message) => {
      const error = await rejectedPost(status, code, message);
      expect(isSafeToRetryToolCall(error, true)).toBe(false);
    },
  );

  it("requires HTTP 404 for tool retries even with an explicit session message", async () => {
    const error = await rejectedPost(500, -32000, "MCP session not found");
    expect(isSafeToRetryToolCall(error, true)).toBe(false);
  });

  it("requires a valid complete JSON error body", () => {
    const error = new StreamableHTTPError(
      404,
      'Error POSTing to endpoint: {"error":{"code":-32000,"message":"MCP session not found"}',
    );
    expect(isSafeToRetryToolCall(error, false)).toBe(false);
  });
});
