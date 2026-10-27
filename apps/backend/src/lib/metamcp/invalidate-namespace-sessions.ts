import logger from "@/utils/logger";

import { namespaceMappingsRepository } from "../../db/repositories/namespace-mappings.repo";
import { clearOverrideCache } from "./metamcp-middleware/tool-overrides.functional";
import { metaMcpServerPool } from "./metamcp-server-pool";

/** Invalidate derived namespace sessions after saving an upstream configuration. */
export async function invalidateNamespaceSessionsForServer(
  serverUuid: string,
): Promise<void> {
  const namespaces =
    await namespaceMappingsRepository.findNamespacesByServerUuid(serverUuid);
  if (!namespaces.length) return;
  void metaMcpServerPool.invalidateIdleServers(namespaces).catch(() => {
    logger.error(
      "Namespace idle-session invalidation failed after server update",
    );
  });
  void metaMcpServerPool.invalidateOpenApiSessions(namespaces).catch(() => {
    logger.error(
      "Namespace OpenAPI-session invalidation failed after server update",
    );
  });
  for (const uuid of namespaces) clearOverrideCache(uuid);
}
