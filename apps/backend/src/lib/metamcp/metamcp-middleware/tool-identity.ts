import { parseToolName } from "../tool-name-parser";
import { resolveNamespaceServer } from "./namespace-tool-scope";

export async function resolveToolIdentity(
  toolName: string,
  namespaceUuid?: string,
): Promise<{
  mcpServerUuid?: string;
  mcpServerName?: string;
}> {
  const parsed = parseToolName(toolName);
  if (!parsed || !namespaceUuid) {
    return {};
  }

  const server = await resolveNamespaceServer(namespaceUuid, parsed.serverName);

  return {
    mcpServerUuid: server?.uuid,
    mcpServerName: server?.name ?? parsed.serverName,
  };
}
