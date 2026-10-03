import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { isSafeToRetryToolCall } from "./session-error";
import { parseToolName } from "./tool-name-parser";

const UNCERTAIN_RESULT =
  "如果这次操作会新增、修改或删除数据，请先确认是否已完成，避免重复提交。";

/** Presentation only: call after recovery and auditing, never to decide retries. */
export function formatToolCallError(error: unknown, toolName: string): unknown {
  if (!(error instanceof Error)) return error;

  const code = error instanceof McpError ? error.code : ErrorCode.InternalError;
  const localError = error.constructor === Error && !("code" in error);
  if (
    error instanceof McpError &&
    ![
      ErrorCode.InternalError,
      ErrorCode.ConnectionClosed,
      ErrorCode.RequestTimeout,
    ].includes(code)
  )
    return error;
  const prefix = `MCP error ${code}: `;
  let detail = error.message;
  // Each SDK hop can prepend the same diagnostic code. Remove only that
  // exact prefix for presentation; recovery still uses the untouched error.
  if (error instanceof McpError) {
    while (detail.startsWith(prefix)) detail = detail.slice(prefix.length);
  }
  const parsed = parseToolName(toolName);
  const target = parsed
    ? `「${parsed.serverName}」的「${parsed.originalToolName}」工具`
    : `「${toolName}」工具`;
  let message: string;

  if (detail === "Not connected" || detail === "Connection closed") {
    message = `与${target}的连接已断开，本次调用未能正常完成。请检查后端服务是否在线，并在客户端重新连接 MetaMCP。${UNCERTAIN_RESULT}`;
  } else if (isSafeToRetryToolCall(error, false)) {
    message = `${target}的连接会话已失效。请在客户端重新连接 MetaMCP 并刷新工具列表后再试。`;
  } else if (
    ["Request timed out", "Maximum total timeout exceeded", "Timeout"].includes(
      detail,
    )
  ) {
    message = `等待${target}响应超时，暂时无法确认操作是否完成。检索操作可稍后重试；新增、修改或删除操作请先核对结果，避免重复提交。`;
  } else if (
    localError &&
    (detail.startsWith("No session available for server ") ||
      detail.startsWith("Failed to re-initialize session for server "))
  ) {
    message = `暂时无法连接${target}，本次操作未执行。请检查后端服务是否在线、连接配置是否正确，再在客户端重新连接 MetaMCP。`;
  } else if (
    localError &&
    (detail.startsWith("Unknown tool: ") ||
      /^Server .+ no longer present in namespace .+$/.test(detail))
  ) {
    message = `${target}当前不可用，可能已被移除或停用。请刷新工具列表，并检查服务及工具是否已启用。`;
  } else if (
    code === ErrorCode.InternalError &&
    ["Internal error", "Internal server error", "Unknown error"].includes(
      detail,
    )
  ) {
    message = `${target}在处理请求时发生内部错误，暂时无法确认操作结果。请检查后端服务状态，或联系管理员查看错误日志。${UNCERTAIN_RESULT}`;
  } else {
    // Keep actionable business, validation and permission errors intact.
    return error;
  }

  const friendly = new McpError(
    code,
    message,
    error instanceof McpError ? error.data : undefined,
  );
  // McpError adds a diagnostic prefix locally; keep the wire message readable.
  friendly.message = message;
  friendly.cause = error;
  return friendly;
}
