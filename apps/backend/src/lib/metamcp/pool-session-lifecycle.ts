import type { ServerParameters } from "@repo/zod-types";

import logger from "@/utils/logger";

import type { ConnectedClient } from "./client";
import { serverRequiresForwardedHeaders } from "./header-forwarding";
import { PoolRevisionFence, readServerRevision } from "./pool-revision-fence";

/** Only lifecycle-owned references; no connection creation or health policy. */
export interface PoolLifecycleState {
  activeSessions: Record<string, Record<string, ConnectedClient>>;
  idleSessions: Record<string, ConnectedClient>;
  sessionTimestamps: Record<string, number>;
  sessionToServers: Record<string, Set<string>>;
  serverParamsCache: Record<string, ServerParameters>;
  invalidatingClients: WeakMap<ConnectedClient, Promise<void>>;
  creatingIdleSessions: Set<string>;
  creatingIdleRevisions: Map<string, number | undefined>;
  idleSessionGenerations: Record<string, number>;
  revisions: PoolRevisionFence;
}

/**
 * Owns detachment/recycling decisions and configuration invalidation.
 * The state accessor stays live when cleanupAll replaces a map during an await.
 * All detachment decisions precede closing clients; closers retain exactly-once
 * semantics in the pool. Creation and health checks remain the pool's concern.
 */
export class PoolSessionLifecycle {
  constructor(
    private readonly state: () => PoolLifecycleState,
    private readonly closeClient: (
      sessionId: string,
      serverUuid: string,
      client: ConnectedClient,
    ) => Promise<void>,
    private readonly createIdle: (
      serverUuid: string,
      params: ServerParameters,
      namespaceUuid?: string,
    ) => Promise<void>,
  ) {}

  async validateConfiguration(params: ServerParameters): Promise<boolean> {
    if (!this.state().revisions.allows(params)) return false;
    const current = await readServerRevision(params.uuid);
    if (current !== undefined)
      void this.invalidateServerConfiguration(params.uuid, current);
    return (
      current === params.tool_catalog_revision &&
      this.state().revisions.allows(params)
    );
  }

  async cleanupSession(sessionId: string): Promise<void> {
    const activeSession = this.state().activeSessions[sessionId];
    if (!activeSession) {
      return;
    }

    // Detach before any await so a replacement with the same ID survives.
    delete this.state().activeSessions[sessionId];
    delete this.state().sessionTimestamps[sessionId];
    delete this.state().sessionToServers[sessionId];

    let recycled = 0;
    let destroyed = 0;
    const cleanups: Promise<void>[] = [];
    for (const [serverUuid, client] of Object.entries(activeSession)) {
      const pending = this.state().invalidatingClients.get(client);
      if (pending) {
        cleanups.push(pending);
        continue;
      }
      // Cap reuse creates aliases: only the final owner may recycle or close.
      if (
        Object.values(this.state().activeSessions).some((servers) =>
          Object.values(servers).includes(client),
        ) ||
        this.state().idleSessions[serverUuid] === client
      ) {
        continue;
      }
      const params = this.state().serverParamsCache[serverUuid];
      if (
        params &&
        this.state().revisions.allows(params) &&
        this.state().revisions.matches(client, params) &&
        !serverRequiresForwardedHeaders(params) &&
        !this.state().idleSessions[serverUuid]
      ) {
        this.state().idleSessions[serverUuid] = client;
        recycled++;
      } else {
        // Reuse the invalidation guard for exactly-once cleanup, including
        // late failures/configuration invalidation of this captured client.
        cleanups.push(this.closeClient(sessionId, serverUuid, client));
        destroyed++;
      }
    }
    await Promise.all(cleanups);

    logger.info(
      `Cleaned up session ${sessionId} (recycled: ${recycled}, destroyed: ${destroyed})`,
    );
  }

  async invalidateIdleSession(
    serverUuid: string,
    params: ServerParameters,
    namespaceUuid?: string,
  ): Promise<void> {
    logger.info(`Invalidating idle session for server ${serverUuid}`);
    const initialGeneration =
      this.state().idleSessionGenerations[serverUuid] ?? 0;
    if (params.uuid !== serverUuid) return;
    if (params.tool_catalog_revision !== undefined) {
      if (
        !(await this.validateConfiguration(params)) ||
        !this.state().revisions.allows(params) ||
        (this.state().idleSessionGenerations[serverUuid] ?? 0) !==
          initialGeneration
      )
        return;
      this.state().serverParamsCache[serverUuid] = params;
      await this.createIdle(serverUuid, params, namespaceUuid);
      return;
    }
    if (!this.state().revisions.allows(params)) return;

    // Update server params cache
    this.state().serverParamsCache[serverUuid] = params;

    const existingIdleSession = this.state().idleSessions[serverUuid];
    delete this.state().idleSessions[serverUuid];
    const generation =
      (this.state().idleSessionGenerations[serverUuid] ?? 0) + 1;
    this.state().idleSessionGenerations[serverUuid] = generation;
    this.state().creatingIdleSessions.delete(serverUuid);
    this.state().creatingIdleRevisions.delete(serverUuid);
    if (existingIdleSession) {
      await this.closeClient("idle", serverUuid, existingIdleSession);
    }
    if (
      this.state().idleSessionGenerations[serverUuid] === generation &&
      this.state().revisions.allows(params)
    ) {
      await this.createIdle(serverUuid, params, namespaceUuid);
    }
  }

  async cleanupIdleSession(serverUuid: string): Promise<void> {
    logger.info(`Cleaning up idle session for server ${serverUuid}`);

    const existingIdleSession = this.state().idleSessions[serverUuid];
    delete this.state().idleSessions[serverUuid];
    delete this.state().serverParamsCache[serverUuid];
    this.state().idleSessionGenerations[serverUuid] =
      (this.state().idleSessionGenerations[serverUuid] ?? 0) + 1;
    this.state().creatingIdleSessions.delete(serverUuid);
    this.state().creatingIdleRevisions.delete(serverUuid);
    if (existingIdleSession) {
      await this.closeClient("idle", serverUuid, existingIdleSession);
    }
  }

  async ensureIdleSessionForNewServer(
    serverUuid: string,
    params: ServerParameters,
    namespaceUuid?: string,
  ): Promise<void> {
    logger.info(`Ensuring idle session exists for new server ${serverUuid}`);
    const generation = this.state().idleSessionGenerations[serverUuid] ?? 0;
    if (
      params.uuid !== serverUuid ||
      (params.tool_catalog_revision !== undefined &&
        !(await this.validateConfiguration(params))) ||
      !this.state().revisions.allows(params) ||
      (this.state().idleSessionGenerations[serverUuid] ?? 0) !== generation
    )
      return;

    // Update server params cache
    this.state().serverParamsCache[serverUuid] = params;

    // Only create if we don't already have one
    if (
      !this.state().idleSessions[serverUuid] &&
      !this.state().creatingIdleSessions.has(serverUuid)
    ) {
      await this.createIdle(serverUuid, params, namespaceUuid);
    }
  }

  async invalidateServerConfiguration(
    serverUuid: string,
    revision?: number,
  ): Promise<void> {
    if (revision !== undefined)
      this.state().revisions.advance(serverUuid, revision);
    const cached = this.state().serverParamsCache[serverUuid];
    if (
      revision === undefined ||
      (cached?.tool_catalog_revision ?? -1) < revision
    ) {
      delete this.state().serverParamsCache[serverUuid];
    }
    await this.cleanupServerSessions(serverUuid, revision);
  }

  async cleanupServerSessions(
    serverUuid: string,
    revision?: number,
  ): Promise<void> {
    if (revision === undefined) {
      this.state().idleSessionGenerations[serverUuid] =
        (this.state().idleSessionGenerations[serverUuid] ?? 0) + 1;
    }
    if (
      revision === undefined ||
      (this.state().creatingIdleRevisions.get(serverUuid) ?? -1) < revision
    ) {
      this.state().creatingIdleSessions.delete(serverUuid);
      this.state().creatingIdleRevisions.delete(serverUuid);
    }
    const clients = new Set<ConnectedClient>();
    const idleSession = this.state().idleSessions[serverUuid];
    if (
      idleSession &&
      (revision === undefined ||
        this.state().revisions.older(idleSession, revision))
    ) {
      clients.add(idleSession);
      delete this.state().idleSessions[serverUuid];
    }

    for (const [sessionId, sessionServers] of Object.entries(
      this.state().activeSessions,
    )) {
      const client = sessionServers[serverUuid];
      if (
        client &&
        (revision === undefined ||
          this.state().revisions.older(client, revision))
      ) {
        clients.add(client);
        delete sessionServers[serverUuid];
        this.state().sessionToServers[sessionId]?.delete(serverUuid);
      }
    }
    await Promise.all(
      [...clients].map((client) =>
        this.closeClient("configuration", serverUuid, client),
      ),
    );
  }
}
