import type { ServerParameters } from "@repo/zod-types";

import type { ConnectedClient } from "./client";

// Load once, lazily: synthetic/unversioned pools must not initialize the DB.
// Coalesce module loading, not revision reads; concurrent callers must resolve
// the same module (including its test mock) rather than race its initialization.
let repositoryModule:
  Promise<typeof import("../../db/repositories/tool-catalog.repo")> | undefined;

/** Read catalog metadata only, never saved launch parameters or credentials. */
export async function readServerRevision(
  uuid: string,
): Promise<number | undefined> {
  const { toolCatalogRepository } = await (repositoryModule ??=
    import("../../db/repositories/tool-catalog.repo"));
  return toolCatalogRepository.findRevisionByServerUuid(uuid);
}

export async function isCurrentServerRevision(
  params: ServerParameters,
): Promise<boolean> {
  return (
    params.tool_catalog_revision === undefined ||
    (await readServerRevision(params.uuid)) === params.tool_catalog_revision
  );
}

/** Monotonic revision floor complements the pool's explicit full-reset generation. */
export class PoolRevisionFence {
  private floors = new Map<string, number>();
  private clients = new WeakMap<ConnectedClient, number | undefined>();

  advance(uuid: string, revision: number): void {
    this.floors.set(
      uuid,
      Math.max(this.floors.get(uuid) ?? revision, revision),
    );
  }

  allows(params: ServerParameters): boolean {
    const floor = this.floors.get(params.uuid);
    return (
      floor === undefined ||
      (params.tool_catalog_revision !== undefined &&
        params.tool_catalog_revision >= floor)
    );
  }

  bind(client: ConnectedClient, params: ServerParameters): void {
    this.clients.set(client, params.tool_catalog_revision);
  }

  matches(client: ConnectedClient, params: ServerParameters): boolean {
    return this.clients.get(client) === params.tool_catalog_revision;
  }

  older(client: ConnectedClient, revision: number): boolean {
    const version = this.clients.get(client);
    return version === undefined || version < revision;
  }
}
