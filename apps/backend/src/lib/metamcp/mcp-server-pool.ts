import { ServerParameters } from "@repo/zod-types";

import logger from "@/utils/logger";

import { configService } from "../config.service";
import { ConnectedClient, connectMetaMcpClient } from "./client";
import { serverRequiresForwardedHeaders } from "./header-forwarding";
import { metamcpLogStore } from "./log-store";
import { PoolRevisionFence } from "./pool-revision-fence";
import { PoolSessionLifecycle } from "./pool-session-lifecycle";
import { serverErrorTracker } from "./server-error-tracker";
import { subscribeCatalogInvalidation } from "./tool-catalog-events";

export interface McpServerPoolStatus {
  idle: number;
  active: number;
  activeSessionIds: string[];
  idleServerUuids: string[];
  perServerCounts?: Record<string, number>;
  maxConnectionsPerServer?: number;
}

export class McpServerPool {
  // Singleton instance
  private static instance: McpServerPool | null = null;

  // Idle sessions: serverUuid -> ConnectedClient (no sessionId assigned yet)
  private idleSessions: Record<string, ConnectedClient> = {};

  // Active sessions: sessionId -> Record<serverUuid, ConnectedClient>
  private activeSessions: Record<string, Record<string, ConnectedClient>> = {};

  // Mapping: sessionId -> Set<serverUuid> for cleanup tracking
  private sessionToServers: Record<string, Set<string>> = {};

  // Session creation timestamps: sessionId -> timestamp
  private sessionTimestamps: Record<string, number> = {};

  // Server parameters cache: serverUuid -> ServerParameters
  private serverParamsCache: Record<string, ServerParameters> = {};

  // Keep connection creation scoped to the caller's authentication/session context.
  private acquiringSessions = new Map<
    string,
    Promise<ConnectedClient | undefined>
  >();
  private invalidatingClients = new WeakMap<ConnectedClient, Promise<void>>();

  // Track ongoing idle session creation to prevent duplicates
  private creatingIdleSessions: Set<string> = new Set();
  private creatingIdleRevisions = new Map<string, number | undefined>();
  private revisions = new PoolRevisionFence();

  // Generation counter per server UUID: stale active/idle acquisitions must
  // discard their result after configuration invalidation.
  private idleSessionGenerations: Record<string, number> = {};

  private readonly lifecycle = new PoolSessionLifecycle(
    () => ({
      activeSessions: this.activeSessions,
      idleSessions: this.idleSessions,
      sessionTimestamps: this.sessionTimestamps,
      sessionToServers: this.sessionToServers,
      serverParamsCache: this.serverParamsCache,
      invalidatingClients: this.invalidatingClients,
      creatingIdleSessions: this.creatingIdleSessions,
      creatingIdleRevisions: this.creatingIdleRevisions,
      idleSessionGenerations: this.idleSessionGenerations,
      revisions: this.revisions,
    }),
    (sessionId, uuid, client) =>
      this.invalidateServerConnection(sessionId, uuid, client),
    (uuid, params, namespaceUuid) =>
      this.createIdleSession(uuid, params, namespaceUuid),
  );

  // Session cleanup timer
  private cleanupTimer: NodeJS.Timeout | null = null;

  // Health check timer for idle sessions
  private healthCheckTimer: NodeJS.Timeout | null = null;

  // Background idle sessions by namespace: namespaceUuid -> any
  private backgroundIdleSessionsByNamespace: Map<string, Map<string, unknown>> =
    new Map();

  // Default number of idle sessions per server UUID
  private readonly defaultIdleCount: number;

  // Maximum total connections (idle + active) to prevent runaway process spawning
  private readonly maxTotalConnections: number;

  // Maximum connections per individual server UUID (prevents per-server process explosion)
  private readonly maxConnectionsPerServer: number;

  private constructor(
    defaultIdleCount: number = 1,
    maxTotalConnections: number = parseInt(
      process.env.MAX_TOTAL_CONNECTIONS || "100",
      10,
    ),
    maxConnectionsPerServer: number = 5,
  ) {
    this.defaultIdleCount = defaultIdleCount;
    this.maxTotalConnections = maxTotalConnections;
    this.maxConnectionsPerServer = maxConnectionsPerServer;
    this.startCleanupTimer();
    this.startHealthCheckTimer();
  }

  /**
   * Get the singleton instance
   */
  static getInstance(
    defaultIdleCount: number = 1,
    maxConnectionsPerServer: number = 5,
  ): McpServerPool {
    if (!McpServerPool.instance) {
      const envMax = parseInt(process.env.MAX_TOTAL_CONNECTIONS || "", 10);
      const maxConn = Number.isFinite(envMax) && envMax > 0 ? envMax : 100;
      McpServerPool.instance = new McpServerPool(
        defaultIdleCount,
        maxConn,
        maxConnectionsPerServer,
      );
    }
    return McpServerPool.instance;
  }

  /**
   * Count all connections (idle + active + pending) for a specific server UUID
   */
  private countConnectionsForServer(serverUuid: string): number {
    let count = 0;

    // Count idle session
    if (this.idleSessions[serverUuid]) {
      count += 1;
    }

    // Count active sessions across all sessionIds
    for (const sessionServers of Object.values(this.activeSessions)) {
      if (sessionServers[serverUuid]) {
        count += 1;
      }
    }

    // Count pending idle creation
    if (this.creatingIdleSessions.has(serverUuid)) {
      count += 1;
    }

    return count;
  }

  /**
   * Check if we can create another connection for a specific server
   */
  private canCreateConnectionForServer(serverUuid: string): boolean {
    const count = this.countConnectionsForServer(serverUuid);
    if (count >= this.maxConnectionsPerServer) {
      logger.warn(
        `Per-server connection limit reached for ${serverUuid}: ${count}/${this.maxConnectionsPerServer}`,
      );
      return false;
    }
    return true;
  }

  /**
   * Find the oldest active connection for a server UUID (for reuse when at cap)
   */
  private findOldestActiveConnectionForServer(
    serverUuid: string,
  ): ConnectedClient | undefined {
    let oldestSessionId: string | undefined;
    let oldestTimestamp = Infinity;

    for (const [sessionId, sessionServers] of Object.entries(
      this.activeSessions,
    )) {
      if (sessionServers[serverUuid]) {
        const timestamp = this.sessionTimestamps[sessionId] || Infinity;
        if (timestamp < oldestTimestamp) {
          oldestTimestamp = timestamp;
          oldestSessionId = sessionId;
        }
      }
    }

    if (oldestSessionId) {
      return this.activeSessions[oldestSessionId]?.[serverUuid];
    }
    return undefined;
  }

  /**
   * Get or create a session for a specific MCP server
   */
  async getSession(
    sessionId: string,
    serverUuid: string,
    params: ServerParameters,
    namespaceUuid?: string,
  ): Promise<ConnectedClient | undefined> {
    const generation = this.idleSessionGenerations[serverUuid] ?? 0;
    if (
      params.uuid !== serverUuid ||
      (params.tool_catalog_revision !== undefined &&
        !(await this.validateConfiguration(params))) ||
      !this.revisions.allows(params) ||
      (this.idleSessionGenerations[serverUuid] ?? 0) !== generation
    )
      return undefined;
    const key = JSON.stringify([
      sessionId,
      serverUuid,
      generation,
      params.tool_catalog_revision,
    ]);
    const acquisition =
      this.acquiringSessions.get(key) ??
      this.acquireSession(
        sessionId,
        serverUuid,
        params,
        generation,
        namespaceUuid,
      );
    this.acquiringSessions.set(key, acquisition);
    try {
      const client = await acquisition;
      return (this.idleSessionGenerations[serverUuid] ?? 0) === generation &&
        this.revisions.allows(params)
        ? client
        : undefined;
    } finally {
      if (this.acquiringSessions.get(key) === acquisition) {
        this.acquiringSessions.delete(key);
      }
    }
  }

  private async acquireSession(
    sessionId: string,
    serverUuid: string,
    params: ServerParameters,
    generation: number,
    namespaceUuid?: string,
  ): Promise<ConnectedClient | undefined> {
    if (
      (this.idleSessionGenerations[serverUuid] ?? 0) !== generation ||
      !this.revisions.allows(params)
    ) {
      return undefined;
    }
    // Update server params cache
    this.serverParamsCache[serverUuid] = params;

    // A session ID alone cannot authorize reuse across configuration revisions.
    const active = this.activeSessions[sessionId]?.[serverUuid];
    if (active && !this.revisions.matches(active, params)) {
      void this.invalidateServerConnection(sessionId, serverUuid, active);
    }
    const idle = this.idleSessions[serverUuid];
    if (idle && !this.revisions.matches(idle, params)) {
      void this.invalidateServerConnection(sessionId, serverUuid, idle);
    }
    // Check if we already have an active session for this sessionId and server
    if (this.activeSessions[sessionId]?.[serverUuid]) {
      // Touch timestamp on every access so SESSION_LIFETIME acts as idle timeout, not hard TTL
      this.sessionTimestamps[sessionId] = Date.now();
      return this.activeSessions[sessionId][serverUuid];
    }

    // Initialize session if it doesn't exist
    if (!this.activeSessions[sessionId]) {
      this.activeSessions[sessionId] = {};
      this.sessionToServers[sessionId] = new Set();
      this.sessionTimestamps[sessionId] = Date.now();
    }

    // Check if we have an idle session for this server that we can convert.
    // Skip idle reuse for servers with forward_headers since each client may
    // need unique credentials forwarded to the backend MCP server.
    if (!serverRequiresForwardedHeaders(params)) {
      const idleClient = this.idleSessions[serverUuid];
      if (idleClient) {
        // Convert idle session to active session
        delete this.idleSessions[serverUuid];
        this.activeSessions[sessionId][serverUuid] = idleClient;
        this.sessionToServers[sessionId].add(serverUuid);

        logger.info(
          `Converted idle session to active for server ${serverUuid}, session ${sessionId}`,
        );

        // Create a new idle session to replace the one we just used (ASYNC - NON-BLOCKING)
        this.createIdleSessionAsync(serverUuid, params, namespaceUuid);

        return idleClient;
      }
    }

    // No idle session available — check per-server cap before spawning
    if (!this.canCreateConnectionForServer(serverUuid)) {
      // Forwarded credentials belong to one client; never share at the cap.
      if (serverRequiresForwardedHeaders(params)) return undefined;
      // At cap: reuse the oldest active connection instead of spawning
      const reusable = this.findOldestActiveConnectionForServer(serverUuid);
      if (reusable && this.revisions.matches(reusable, params)) {
        logger.info(
          `Reusing existing connection for server ${serverUuid} (at per-server cap ${this.maxConnectionsPerServer})`,
        );
        this.activeSessions[sessionId][serverUuid] = reusable;
        this.sessionToServers[sessionId].add(serverUuid);
        return reusable;
      }
    }

    const newClient = await this.createNewConnection(params, namespaceUuid);
    if (!newClient) {
      return undefined;
    }
    if (
      (this.idleSessionGenerations[serverUuid] ?? 0) !== generation ||
      !this.revisions.allows(params)
    ) {
      await this.invalidateServerConnection(sessionId, serverUuid, newClient);
      return undefined;
    }

    // Re-check after the async gap: a concurrent getSession() call for the same
    // (sessionId, serverUuid) pair may have stored a connection while we were awaiting
    // createNewConnection(). If so, discard ours to avoid leaking the spawned process.
    if (this.activeSessions[sessionId]?.[serverUuid]) {
      newClient.cleanup().catch((error) => {
        logger.error(
          `Error cleaning up duplicate connection for server ${params.uuid}:`,
          error,
        );
      });
      return this.activeSessions[sessionId][serverUuid];
    }

    this.activeSessions[sessionId][serverUuid] = newClient;
    this.sessionToServers[sessionId].add(serverUuid);

    logger.info(
      `Created new active session for server ${serverUuid}, session ${sessionId}`,
    );

    // Only pre-warm idle pool for servers that don't require forwarded headers.
    // Idle sessions are created without per-client headers, so they can't be
    // reused when per-client header forwarding is configured.
    if (!serverRequiresForwardedHeaders(params)) {
      this.createIdleSessionAsync(serverUuid, params, namespaceUuid);
    }

    return newClient;
  }

  /** Check persisted metadata; a delayed conversion must not adopt today's generation. */
  private async validateConfiguration(
    params: ServerParameters,
  ): Promise<boolean> {
    return this.lifecycle.validateConfiguration(params);
  }

  /**
   * Create a new connection for a server
   */
  private async createNewConnection(
    params: ServerParameters,
    namespaceUuid?: string,
  ): Promise<ConnectedClient | undefined> {
    const generation = this.idleSessionGenerations[params.uuid] ?? 0;
    if (
      (params.tool_catalog_revision !== undefined &&
        !(await this.validateConfiguration(params))) ||
      !this.revisions.allows(params) ||
      (this.idleSessionGenerations[params.uuid] ?? 0) !== generation
    )
      return undefined;
    // Check connection limit before attempting to create
    if (!this.canCreateConnection()) {
      logger.warn(
        `Skipping connection for server ${params.name} (${params.uuid}) - connection limit reached`,
      );
      return undefined;
    }

    logger.info(
      `Creating new connection for server ${params.name} (${params.uuid}) with namespace: ${namespaceUuid || "none"}`,
    );
    metamcpLogStore.addLog(
      params.name,
      "info",
      `Creating new connection for namespace ${namespaceUuid || "none"}`,
    );

    const connectedClient = await connectMetaMcpClient(
      params,
      (exitCode, signal) => {
        if (
          !this.revisions.allows(params) ||
          (this.idleSessionGenerations[params.uuid] ?? 0) !== generation
        )
          return;
        logger.info(
          `Crash handler callback called for server ${params.name} (${params.uuid}) with namespace: ${namespaceUuid || "none"}`,
        );

        // Handle process crash - always set up crash handler
        if (namespaceUuid) {
          // If we have a namespace context, use it
          this.handleServerCrash(
            params.uuid,
            namespaceUuid,
            exitCode,
            signal,
          ).catch((error) => {
            logger.error(
              `Error handling server crash for ${params.uuid} in ${namespaceUuid}:`,
              error,
            );
          });
        } else {
          // If no namespace context, still track the crash globally
          this.handleServerCrashWithoutNamespace(
            params.uuid,
            exitCode,
            signal,
          ).catch((error) => {
            logger.error(
              `Error handling server crash for ${params.uuid} (no namespace):`,
              error,
            );
          });
        }
      },
    );
    if (!connectedClient) {
      return undefined;
    }

    this.revisions.bind(connectedClient, params);
    let valid = false;
    try {
      valid =
        (params.tool_catalog_revision === undefined ||
          (await this.validateConfiguration(params))) &&
        this.revisions.allows(params) &&
        (this.idleSessionGenerations[params.uuid] ?? 0) === generation;
    } finally {
      if (!valid)
        await this.invalidateServerConnection(
          "stale-acquire",
          params.uuid,
          connectedClient,
        );
    }
    return valid ? connectedClient : undefined;
  }

  /**
   * Create an idle session for a server (blocking version for initial setup)
   */
  private async createIdleSession(
    serverUuid: string,
    params: ServerParameters,
    namespaceUuid?: string,
  ): Promise<void> {
    const generation = this.idleSessionGenerations[serverUuid] ?? 0;
    if (
      params.uuid !== serverUuid ||
      serverRequiresForwardedHeaders(params) ||
      (params.tool_catalog_revision !== undefined &&
        !(await this.validateConfiguration(params))) ||
      !this.revisions.allows(params) ||
      (this.idleSessionGenerations[serverUuid] ?? 0) !== generation
    )
      return;
    // Recheck the idle guard after metadata validation, before creating.
    if (
      this.idleSessions[serverUuid] ||
      this.creatingIdleSessions.has(serverUuid)
    ) {
      return;
    }

    // Don't create if at per-server cap
    if (!this.canCreateConnectionForServer(serverUuid)) {
      return;
    }

    this.creatingIdleSessions.add(serverUuid);
    this.creatingIdleRevisions.set(serverUuid, params.tool_catalog_revision);

    try {
      const newClient = await this.createNewConnection(params, namespaceUuid);
      if (newClient) {
        const currentGeneration = this.idleSessionGenerations[serverUuid] ?? 0;
        if (
          !this.idleSessions[serverUuid] &&
          currentGeneration === generation &&
          this.revisions.allows(params)
        ) {
          this.idleSessions[serverUuid] = newClient;
          logger.info(`Created idle session for server ${serverUuid}`);
          metamcpLogStore.addLog(
            params.name,
            "info",
            `Created idle session for server ${serverUuid}`,
          );
        } else {
          // Either a concurrent call already stored an idle session, or
          // invalidateIdleSession() bumped the generation while we were awaiting,
          // meaning our result is stale. Discard it.
          newClient.cleanup().catch((error) => {
            logger.error(
              `Error cleaning up duplicate idle session for ${serverUuid}:`,
              error,
            );
          });
        }
      }
    } finally {
      // Only release the guard if we're still the current creation for this
      // server. If the generation was bumped while we were awaiting (e.g. by
      // invalidateIdleSession), the guard now belongs to the newer creation
      // and must not be removed here.
      if (
        (this.idleSessionGenerations[serverUuid] ?? 0) === generation &&
        this.creatingIdleRevisions.get(serverUuid) ===
          params.tool_catalog_revision
      ) {
        this.creatingIdleSessions.delete(serverUuid);
        this.creatingIdleRevisions.delete(serverUuid);
      }
    }
  }

  /**
   * Create an idle session for a server asynchronously (non-blocking)
   */
  private createIdleSessionAsync(
    serverUuid: string,
    params: ServerParameters,
    namespaceUuid?: string,
  ): void {
    // Don't create if we already have an idle session or are already creating one
    if (
      serverRequiresForwardedHeaders(params) ||
      !this.revisions.allows(params)
    )
      return;
    if (
      this.idleSessions[serverUuid] ||
      this.creatingIdleSessions.has(serverUuid)
    ) {
      return;
    }

    // Check per-server cap before spawning a background idle
    if (!this.canCreateConnectionForServer(serverUuid)) {
      return;
    }

    // Mark that we're creating an idle session for this server
    this.creatingIdleSessions.add(serverUuid);
    this.creatingIdleRevisions.set(serverUuid, params.tool_catalog_revision);
    const generation = this.idleSessionGenerations[serverUuid] ?? 0;

    // Create the session in the background (fire and forget)
    this.createNewConnection(params, namespaceUuid)
      .then((newClient) => {
        const currentGeneration = this.idleSessionGenerations[serverUuid] ?? 0;
        if (
          newClient &&
          !this.idleSessions[serverUuid] &&
          currentGeneration === generation &&
          this.revisions.allows(params)
        ) {
          this.idleSessions[serverUuid] = newClient;
          logger.info(
            `Created background idle session for server [${params.name}] ${serverUuid}`,
          );
          metamcpLogStore.addLog(
            params.name,
            "info",
            `Created background idle session for server ${serverUuid}`,
          );
          if (namespaceUuid) {
            this.setBackgroundIdleSessionsByNamespace(
              namespaceUuid,
              new Map().set("status", "created"),
            );
          }
        } else if (newClient) {
          // Either we already have an idle session, or invalidateIdleSession()
          // bumped the generation while we were awaiting (stale result). Discard it.
          newClient.cleanup().catch((error) => {
            logger.error(
              `Error cleaning up extra idle session for ${serverUuid}:`,
              error,
            );
          });
        }
      })
      .catch((error) => {
        logger.error(
          `Error creating background idle session for ${serverUuid}:`,
          error,
        );
      })
      .finally(() => {
        // Only release the guard if we're still the current creation for this
        // server. If the generation was bumped while we were awaiting (e.g. by
        // invalidateIdleSession), the guard now belongs to the newer creation
        // and must not be removed here.
        if (
          (this.idleSessionGenerations[serverUuid] ?? 0) === generation &&
          this.creatingIdleRevisions.get(serverUuid) ===
            params.tool_catalog_revision
        ) {
          this.creatingIdleSessions.delete(serverUuid);
          this.creatingIdleRevisions.delete(serverUuid);
        }
      });
  }

  /**
   * Ensure idle sessions exist for all servers
   */
  async ensureIdleSessions(
    serverParams: Record<string, ServerParameters>,
    namespaceUuid?: string,
  ): Promise<void> {
    const promises = Object.entries(serverParams).map(
      async ([uuid, params]) => {
        if (!this.idleSessions[uuid]) {
          await this.createIdleSession(uuid, params, namespaceUuid);
        }
      },
    );

    await Promise.allSettled(promises);
  }

  /**
   * Cleanup a session by sessionId.
   * Recycles healthy connections back to the idle pool instead of destroying them.
   */
  async cleanupSession(sessionId: string): Promise<void> {
    return this.lifecycle.cleanupSession(sessionId);
  }

  /**
   * Cleanup all sessions
   */
  async cleanupAll(): Promise<void> {
    // Cleanup all active sessions
    const activeSessionIds = Object.keys(this.activeSessions);
    await Promise.allSettled(
      activeSessionIds.map((sessionId) => this.cleanupSession(sessionId)),
    );

    // Cleanup all idle sessions
    await Promise.allSettled(
      Object.entries(this.idleSessions).map(async ([_uuid, client]) => {
        await client.cleanup();
      }),
    );

    // Clear all state
    this.idleSessions = {};
    this.activeSessions = {};
    this.sessionToServers = {};
    this.sessionTimestamps = {};
    this.serverParamsCache = {};

    // Bump all known generations (never reset to {}) so any in-flight idle
    // creation that started before cleanupAll() resolves with a stale value
    // and discards itself. Cover both tracked entries and UUIDs that are only
    // in creatingIdleSessions (which default to 0 and have no map entry yet).
    for (const uuid of new Set([
      ...Object.keys(this.idleSessionGenerations),
      ...this.creatingIdleSessions,
    ])) {
      this.idleSessionGenerations[uuid] =
        (this.idleSessionGenerations[uuid] ?? 0) + 1;
    }
    this.creatingIdleSessions.clear();
    this.creatingIdleRevisions.clear();

    // Clear cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Clear health check timer
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    logger.info("Cleaned up all MCP server pool sessions");
  }

  /**
   * Get pool status for monitoring
   */
  getPoolStatus(): McpServerPoolStatus {
    const idle = Object.keys(this.idleSessions).length;
    const active = Object.keys(this.activeSessions).reduce(
      (total, sessionId) =>
        total + Object.keys(this.activeSessions[sessionId]).length,
      0,
    );

    // Calculate per-server breakdown
    const perServerCounts: Record<string, number> = {};
    for (const serverUuid of Object.keys(this.serverParamsCache)) {
      perServerCounts[serverUuid] = this.countConnectionsForServer(serverUuid);
    }

    return {
      idle,
      active,
      activeSessionIds: Object.keys(this.activeSessions),
      idleServerUuids: Object.keys(this.idleSessions),
      perServerCounts,
      maxConnectionsPerServer: this.maxConnectionsPerServer,
    };
  }

  /**
   * Get total connection count (idle + active + pending)
   */
  private getTotalConnectionCount(): number {
    const idle = Object.keys(this.idleSessions).length;
    const active = Object.keys(this.activeSessions).reduce(
      (total, sessionId) =>
        total + Object.keys(this.activeSessions[sessionId]).length,
      0,
    );
    const pending = this.creatingIdleSessions.size;
    return idle + active + pending;
  }

  /**
   * Check if we can create a new connection (respects maxTotalConnections limit)
   */
  private canCreateConnection(): boolean {
    const total = this.getTotalConnectionCount();
    if (total >= this.maxTotalConnections) {
      logger.warn(
        `Connection limit reached: ${total}/${this.maxTotalConnections}. Refusing to create new connection.`,
      );
      return false;
    }
    return true;
  }

  /**
   * Get active session connections for a specific session (for debugging/monitoring)
   */
  getSessionConnections(
    sessionId: string,
  ): Record<string, ConnectedClient> | undefined {
    return this.activeSessions[sessionId];
  }

  /**
   * Get all active session IDs (for debugging/monitoring)
   */
  getActiveSessionIds(): string[] {
    return Object.keys(this.activeSessions);
  }

  /**
   * Get background idle sessions by namespace
   */
  getBackgroundIdleSessionsByNamespace(): Map<string, Map<string, unknown>> {
    return this.backgroundIdleSessionsByNamespace;
  }

  /**
   * Set background idle sessions by namespace
   */
  setBackgroundIdleSessionsByNamespace(
    namespaceUuid: string,
    options: Map<string, unknown>,
  ): void {
    this.backgroundIdleSessionsByNamespace.set(namespaceUuid, options);
  }

  /** Remove only references to the connection that actually failed. */
  async invalidateServerConnection(
    sessionId: string,
    serverUuid: string,
    failedClient: ConnectedClient,
  ): Promise<void> {
    const pending = this.invalidatingClients.get(failedClient);
    if (pending) return pending;

    // Detach synchronously before cleanup yields. A late error from an old
    // client must never remove a replacement or an unrelated healthy session.
    for (const [sid, sessionServers] of Object.entries(this.activeSessions)) {
      if (sessionServers[serverUuid] === failedClient) {
        delete sessionServers[serverUuid];
        this.sessionToServers[sid]?.delete(serverUuid);
      }
    }
    if (this.idleSessions[serverUuid] === failedClient) {
      delete this.idleSessions[serverUuid];
    }

    const cleanup = Promise.resolve().then(async () => {
      try {
        await failedClient.cleanup();
      } catch (error) {
        logger.error(
          `Error cleaning up failed connection ${sessionId}/${serverUuid}:`,
          error,
        );
      }
    });
    // Keep the settled promise for late failures on this same object. WeakMap
    // releases it once no request retains the failed client.
    this.invalidatingClients.set(failedClient, cleanup);
    await cleanup;
  }

  /**
   * Invalidate and refresh idle session for a specific server
   * This should be called when a server's parameters (command, args, etc.) change
   */
  async invalidateIdleSession(
    serverUuid: string,
    params: ServerParameters,
    namespaceUuid?: string,
  ): Promise<void> {
    return this.lifecycle.invalidateIdleSession(
      serverUuid,
      params,
      namespaceUuid,
    );
  }

  /**
   * Invalidate and refresh idle sessions for multiple servers
   */
  async invalidateIdleSessions(
    serverParams: Record<string, ServerParameters>,
    namespaceUuid?: string,
  ): Promise<void> {
    const promises = Object.entries(serverParams).map(([serverUuid, params]) =>
      this.invalidateIdleSession(serverUuid, params, namespaceUuid),
    );

    await Promise.allSettled(promises);
  }

  /**
   * Clean up idle session for a specific server without creating a new one
   * This should be called when a server is being deleted
   */
  async cleanupIdleSession(serverUuid: string): Promise<void> {
    return this.lifecycle.cleanupIdleSession(serverUuid);
  }

  /**
   * Ensure idle session exists for a newly created server
   * This should be called when a new server is created
   */
  async ensureIdleSessionForNewServer(
    serverUuid: string,
    params: ServerParameters,
    namespaceUuid?: string,
  ): Promise<void> {
    return this.lifecycle.ensureIdleSessionForNewServer(
      serverUuid,
      params,
      namespaceUuid,
    );
  }

  /**
   * Handle server process crash
   */
  async handleServerCrash(
    serverUuid: string,
    namespaceUuid: string,
    exitCode: number | null,
    signal: string | null,
  ): Promise<void> {
    logger.warn(
      `Handling server crash for ${serverUuid} in namespace ${namespaceUuid}`,
    );

    // Record the crash in the error tracker
    await serverErrorTracker.recordServerCrash(serverUuid, exitCode, signal);

    // Clean up any existing sessions for this server
    await this.cleanupServerSessions(serverUuid);
  }

  /**
   * Handle server process crash without namespace context
   * This is used when servers are created without a specific namespace
   */
  async handleServerCrashWithoutNamespace(
    serverUuid: string,
    exitCode: number | null,
    signal: string | null,
  ): Promise<void> {
    logger.warn(
      `Handling server crash for ${serverUuid} (no namespace context)`,
    );

    // Record the crash in the error tracker
    logger.info(`Recording crash for server ${serverUuid}`);
    await serverErrorTracker.recordServerCrash(serverUuid, exitCode, signal);

    // Clean up any existing sessions for this server
    await this.cleanupServerSessions(serverUuid);
  }

  /** Discard all connections and pending acquisitions after a server update. */
  public async invalidateServerConfiguration(
    serverUuid: string,
    revision?: number,
  ): Promise<void> {
    return this.lifecycle.invalidateServerConfiguration(serverUuid, revision);
  }

  /** Detach synchronously; delayed R2 events must not close R2/R3 connections. */
  private async cleanupServerSessions(
    serverUuid: string,
    revision?: number,
  ): Promise<void> {
    return this.lifecycle.cleanupServerSessions(serverUuid, revision);
  }

  /**
   * Check if a server is in error state
   */
  async isServerInErrorState(serverUuid: string): Promise<boolean> {
    return await serverErrorTracker.isServerInErrorState(serverUuid);
  }

  /**
   * Reset error state for a server (e.g., after manual recovery)
   */
  async resetServerErrorState(serverUuid: string): Promise<void> {
    // Reset crash attempts and error status
    await serverErrorTracker.resetServerErrorState(serverUuid);

    logger.info(`Reset error state for server ${serverUuid}`);
  }

  /**
   * Start the automatic cleanup timer for expired sessions
   */
  private startCleanupTimer(): void {
    // Check for expired sessions every 5 minutes
    this.cleanupTimer = setInterval(
      async () => {
        await this.cleanupExpiredSessions();
      },
      5 * 60 * 1000,
    ); // 5 minutes
  }

  /**
   * Clean up expired sessions based on session lifetime setting
   */
  private async cleanupExpiredSessions(): Promise<void> {
    try {
      const sessionLifetime = await configService.getSessionLifetime();

      // If session lifetime is null, sessions are infinite - skip cleanup
      if (sessionLifetime === null) {
        return;
      }

      const now = Date.now();
      const expiredSessionIds: string[] = [];

      // Find expired sessions
      for (const [sessionId, timestamp] of Object.entries(
        this.sessionTimestamps,
      )) {
        if (now - timestamp > sessionLifetime) {
          expiredSessionIds.push(sessionId);
        }
      }

      // Clean up expired sessions
      if (expiredSessionIds.length > 0) {
        logger.info(
          `Cleaning up ${expiredSessionIds.length} expired MCP server pool sessions: ${expiredSessionIds.join(", ")}`,
        );

        await Promise.allSettled(
          expiredSessionIds.map((sessionId) => this.cleanupSession(sessionId)),
        );
      }
    } catch (error) {
      logger.error("Error during automatic session cleanup:", error);
    }
  }

  /**
   * Start the health check timer for idle sessions
   */
  private startHealthCheckTimer(): void {
    // Check idle session health every 60 seconds
    this.healthCheckTimer = setInterval(async () => {
      await this.checkIdleSessionHealth();
    }, 60 * 1000); // 60 seconds
  }

  /**
   * Check health of idle sessions by pinging them.
   * Dead sessions are cleaned up and recreated.
   * Servers in ERROR state whose crash counters have been reset are retried.
   */
  private async checkIdleSessionHealth(): Promise<void> {
    const serverUuids = Object.keys(this.idleSessions);
    if (serverUuids.length === 0) {
      return;
    }

    for (const serverUuid of serverUuids) {
      const client = this.idleSessions[serverUuid];
      if (!client) continue;

      try {
        // Ping with a 5-second timeout
        await client.client.ping({ timeout: 5000 });
      } catch {
        logger.warn(
          `Idle session health check failed for server ${serverUuid}, recreating...`,
        );

        // Clean up the dead session
        try {
          await client.cleanup();
        } catch {
          // Already dead, ignore cleanup errors
        }
        delete this.idleSessions[serverUuid];

        // Reset error state so we can retry
        await serverErrorTracker.resetServerErrorState(serverUuid);

        // Recreate if we have cached params
        const params = this.serverParamsCache[serverUuid];
        if (params) {
          this.createIdleSessionAsync(serverUuid, params);
        }
      }
    }

    // Also check for servers in ERROR state that have cached params but no idle session.
    // If they were reset (e.g., on startup), we should try to recreate them.
    for (const [serverUuid, params] of Object.entries(this.serverParamsCache)) {
      if (
        !this.idleSessions[serverUuid] &&
        !this.creatingIdleSessions.has(serverUuid)
      ) {
        const isError =
          await serverErrorTracker.isServerInErrorState(serverUuid);
        if (!isError) {
          // Not in error and no idle session - try to create one
          this.createIdleSessionAsync(serverUuid, params);
        }
      }
    }
  }

  /**
   * Get session age in milliseconds
   */
  getSessionAge(sessionId: string): number | undefined {
    const timestamp = this.sessionTimestamps[sessionId];
    return timestamp ? Date.now() - timestamp : undefined;
  }

  /**
   * Check if a session is expired
   */
  async isSessionExpired(sessionId: string): Promise<boolean> {
    const age = this.getSessionAge(sessionId);
    if (age === undefined) return false;

    const sessionLifetime = await configService.getSessionLifetime();
    if (sessionLifetime === null) return false; // infinite sessions
    return age > sessionLifetime;
  }
}

// Create a singleton instance
export const mcpServerPool = McpServerPool.getInstance();
subscribeCatalogInvalidation((uuid, revision) =>
  mcpServerPool.invalidateServerConfiguration(uuid, revision),
);
