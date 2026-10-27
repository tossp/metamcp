import { toolCatalogRepository } from "../../db/repositories/tool-catalog.repo";
import type { ConnectedClient } from "./client";

const PREFIX = "metamcp-unified-";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ERROR = "Tool catalog self-reference check failed";

type CatalogMembershipRepository = Pick<
  typeof toolCatalogRepository,
  "findByNamespace"
>;

/**
 * Run after the upstream handshake, before discovery (including recovery).
 * Only a real MetaMCP identity plus ACTIVE membership establishes direct
 * self-reference. Saved display names, URLs and credentials are not consulted.
 */
export async function assertNoCatalogSelfReference(
  sourceUuid: string,
  client: ConnectedClient["client"],
  repository: CatalogMembershipRepository = toolCatalogRepository,
): Promise<void> {
  try {
    const name = client.getServerVersion()?.name;
    if (!name?.startsWith(PREFIX)) return;
    const targetNamespace = name.slice(PREFIX.length);
    if (!UUID.test(targetNamespace)) return;

    // Never include inactive mappings: they do not contribute to aggregation.
    // This existing repository query projects only directory metadata/tools.
    const members = await repository.findByNamespace(
      targetNamespace.toLowerCase(),
      false,
    );
    if (members.some(({ source }) => source.uuid === sourceUuid)) {
      throw new Error(SAFE_ERROR);
    }
  } catch {
    // Fail closed without reflecting remote identity, DB errors or their causes.
    throw new Error(SAFE_ERROR);
  }
}
