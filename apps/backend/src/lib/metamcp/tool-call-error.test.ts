import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { formatToolCallError } from "./tool-call-error";

const tool = "blinko__searchBlinko";

describe("tool error presentation", () => {
  it.each([
    new Error("Not connected"),
    new McpError(-32603, "Not connected"),
    new McpError(-32000, "Connection closed"),
  ])(
    "explains disconnection without claiming the operation was not executed",
    (error) => {
      const result = formatToolCallError(error, tool) as McpError;
      expect(result.message).toContain("连接已断开");
      expect(result.message).toContain("重新连接 MetaMCP");
      expect(result.message).toContain("先确认是否已完成");
      expect(result.message).not.toContain("本次操作未执行");
      expect(result.cause).toBe(error);
    },
  );

  it.each(["Request timed out", "Maximum total timeout exceeded", "Timeout"])(
    "explains %s without encouraging duplicate writes",
    (message) => {
      const original = new McpError(ErrorCode.RequestTimeout, message, {
        timeout: 123,
      });
      const result = formatToolCallError(original, tool) as McpError;
      expect(result.code).toBe(ErrorCode.RequestTimeout);
      expect(result.data).toEqual({ timeout: 123 });
      expect(result.message).toContain("响应超时");
      expect(result.message).toContain("先核对结果");
      expect(original.message).toContain(message);
    },
  );

  it("explains generic internal errors and preserves protocol diagnostics", () => {
    const original = new McpError(-32603, "Internal error", {
      traceId: "trace-1",
    });
    const result = formatToolCallError(original, tool) as McpError;
    expect(result.code).toBe(-32603);
    expect(result.data).toBe(original.data);
    expect(result.message).toContain("「blinko」的「searchBlinko」工具");
    expect(result.message).toContain("发生内部错误");
    expect(result.message).toContain("查看错误日志");
    expect(original.message).toBe("MCP error -32603: Internal error");
  });

  it.each([
    new McpError(-32001, "Business error"),
    new McpError(-32602, "Missing required argument: content"),
    new McpError(-32602, "Not connected"),
    new McpError(-32603, "No session available for server backend"),
    new McpError(-32603, "Quota exceeded"),
    new Error("Access denied to tool"),
    new Error("Not connected to billing after write"),
    "Not connected",
    { code: -32603, message: "Internal error" },
  ])("preserves specific or unstructured errors: %s", (error) => {
    expect(formatToolCallError(error, tool)).toBe(error);
  });

  it("explains an explicit session rejection", () => {
    const original = new Error(
      'Error POSTing to endpoint (HTTP 404): {"error":{"code":-32600,"message":"Session not found"}}',
    );
    expect((formatToolCallError(original, tool) as Error).message).toContain(
      "连接会话已失效",
    );
  });

  it.each([
    "No session available for server backend",
    "Failed to re-initialize session for server backend after backend session loss",
  ])("explains a pre-execution connection failure", (detail) => {
    const result = formatToolCallError(new Error(detail), tool) as Error;
    expect(result.message).toContain("本次操作未执行");
    expect(result.message).not.toContain("server backend");
  });

  it("handles an unavailable tool whose name has no backend prefix", () => {
    const result = formatToolCallError(
      new Error("Unknown tool: custom"),
      "custom",
    ) as Error;
    expect(result.message).toContain("「custom」工具当前不可用");
    expect(result.message).toContain("刷新工具列表");
  });
});
