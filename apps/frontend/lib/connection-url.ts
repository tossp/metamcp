import type { McpServerType } from "@repo/zod-types";
import { z } from "zod";

interface ConnectionUrlOptions {
  mcpServerUuid: string;
  transportType: McpServerType;
  url: string;
  isMetaMCP?: boolean;
  includeInactiveServers?: boolean;
}

/** Build proxy URLs without accepting saved STDIO launch data from the page. */
export function buildConnectionUrl(
  {
    mcpServerUuid,
    transportType,
    url,
    isMetaMCP = false,
    includeInactiveServers = false,
  }: ConnectionUrlOptions,
  appUrl: string,
): URL {
  if (isMetaMCP) {
    const proxyUrl = new URL(url, appUrl);
    if (includeInactiveServers) {
      proxyUrl.searchParams.append("includeInactiveServers", "true");
    }
    return proxyUrl;
  }

  let proxyUrl: URL;
  switch (transportType) {
    case "STDIO":
      // Fail closed: never fall back to command/args/env supplied by the caller.
      if (!z.string().uuid().safeParse(mcpServerUuid).success) {
        throw new Error("A valid saved STDIO configuration ID is required");
      }
      proxyUrl = new URL("/mcp-proxy/server/stdio", appUrl);
      proxyUrl.searchParams.append("configId", mcpServerUuid);
      break;
    case "SSE":
      proxyUrl = new URL("/mcp-proxy/server/sse", appUrl);
      proxyUrl.searchParams.append("url", url);
      break;
    case "STREAMABLE_HTTP":
      proxyUrl = new URL("/mcp-proxy/server/mcp", appUrl);
      proxyUrl.searchParams.append("url", url);
      break;
    default:
      throw new Error("Unsupported transport type");
  }
  proxyUrl.searchParams.append("transportType", transportType);
  return proxyUrl;
}
