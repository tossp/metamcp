import { DatabaseOAuthSession, OAuthSessionUpdateInput } from "@repo/zod-types";
import { and, eq, gt, sql } from "drizzle-orm";

import { invalidateCatalogConnections } from "../../lib/metamcp/tool-catalog-events";
import { db } from "../index";
import { mcpServersTable, oauthSessionsTable } from "../schema";

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_STATE_EXPIRES_AT_SQL = sql`NOW() + (${OAUTH_STATE_TTL_MS} * INTERVAL '1 millisecond')`;

export interface OAuthTokenUpdateOptions {
  /** Internal refresh_token grant, not an option accepted by public RPCs. */
  tokenRenewal?: boolean;
  expectedCatalogRevision?: number;
  expectedRefreshToken?: string;
}

function normalizedScope(scope: unknown): string {
  return typeof scope === "string"
    ? [...new Set(scope.trim().split(/\s+/))].sort().join(" ")
    : "";
}

export class OAuthSessionsRepository {
  constructor(private readonly database: typeof db = db) {}

  async findByMcpServerUuid(
    mcpServerUuid: string,
    actorUserId: string,
  ): Promise<
    (DatabaseOAuthSession & { tool_catalog_revision: number }) | undefined
  > {
    if (!actorUserId) return undefined;

    const [session] = await this.database
      .select({
        uuid: oauthSessionsTable.uuid,
        mcp_server_uuid: oauthSessionsTable.mcp_server_uuid,
        owner_user_id: oauthSessionsTable.owner_user_id,
        tool_catalog_revision: mcpServersTable.tool_catalog_revision,
        client_information: oauthSessionsTable.client_information,
        tokens: oauthSessionsTable.tokens,
        code_verifier: oauthSessionsTable.code_verifier,
        expected_state: oauthSessionsTable.expected_state,
        expected_state_expires_at: oauthSessionsTable.expected_state_expires_at,
        created_at: oauthSessionsTable.created_at,
        updated_at: oauthSessionsTable.updated_at,
      })
      .from(oauthSessionsTable)
      .innerJoin(
        mcpServersTable,
        eq(mcpServersTable.uuid, oauthSessionsTable.mcp_server_uuid),
      )
      .where(
        and(
          eq(oauthSessionsTable.mcp_server_uuid, mcpServerUuid),
          eq(oauthSessionsTable.owner_user_id, actorUserId),
          eq(mcpServersTable.user_id, actorUserId),
        ),
      )
      .limit(1);

    return session;
  }

  async upsert(
    input: OAuthSessionUpdateInput,
    actorUserId: string,
    options: OAuthTokenUpdateOptions = {},
  ): Promise<DatabaseOAuthSession | undefined> {
    if (!actorUserId) return undefined;
    const saved = await this.database.transaction(async (tx) => {
      const [ownedServer] = await tx
        .select({
          uuid: mcpServersTable.uuid,
          revision: mcpServersTable.tool_catalog_revision,
        })
        .from(mcpServersTable)
        .where(
          and(
            eq(mcpServersTable.uuid, input.mcp_server_uuid),
            eq(mcpServersTable.user_id, actorUserId),
          ),
        )
        .for("update");

      if (!ownedServer) return undefined;

      const [existingSession] = await tx
        .select({
          owner_user_id: oauthSessionsTable.owner_user_id,
          tokens: oauthSessionsTable.tokens,
        })
        .from(oauthSessionsTable)
        .where(eq(oauthSessionsTable.mcp_server_uuid, input.mcp_server_uuid))
        .for("update");

      if (existingSession && existingSession.owner_user_id !== actorUserId) {
        return undefined;
      }

      let tokens = input.tokens;
      let identityChanged =
        tokens !== undefined || input.client_information !== undefined;
      if (options.tokenRenewal) {
        // A delayed renewal may not overwrite an explicit reauthorization.
        if (
          !tokens ||
          !existingSession?.tokens ||
          !options.expectedRefreshToken ||
          existingSession.tokens.refresh_token !==
            options.expectedRefreshToken ||
          (options.expectedCatalogRevision !== undefined &&
            ownedServer.revision !== options.expectedCatalogRevision)
        )
          return undefined;
        const oldScope = existingSession.tokens.scope;
        if (tokens.scope === undefined && typeof oldScope === "string")
          tokens = { ...tokens, scope: oldScope };
        identityChanged =
          input.client_information !== undefined ||
          normalizedScope(tokens.scope) !== normalizedScope(oldScope);
      }
      if (identityChanged) {
        await tx
          .update(mcpServersTable)
          .set({
            tool_catalog_revision: sql`${mcpServersTable.tool_catalog_revision} + 1`,
            tool_catalog_refreshed_at: null,
          })
          .where(eq(mcpServersTable.uuid, input.mcp_server_uuid));
      }
      const stateUpdate =
        input.expected_state !== undefined
          ? {
              expected_state: input.expected_state,
              expected_state_expires_at: OAUTH_STATE_EXPIRES_AT_SQL,
            }
          : {};

      const [row] = await tx
        .insert(oauthSessionsTable)
        .values({
          mcp_server_uuid: input.mcp_server_uuid,
          owner_user_id: actorUserId,
          ...(input.client_information !== undefined && {
            client_information: input.client_information,
          }),
          ...(tokens !== undefined && { tokens }),
          ...(input.code_verifier !== undefined && {
            code_verifier: input.code_verifier,
          }),
          ...stateUpdate,
        })
        .onConflictDoUpdate({
          target: oauthSessionsTable.mcp_server_uuid,
          set: {
            owner_user_id: actorUserId,
            ...(input.client_information !== undefined && {
              client_information: input.client_information,
            }),
            ...(tokens !== undefined && { tokens }),
            ...(input.code_verifier !== undefined && {
              code_verifier: input.code_verifier,
            }),
            ...stateUpdate,
            updated_at: sql`NOW()`,
          },
        })
        .returning();

      return {
        session: row,
        revision: identityChanged ? ownedServer.revision + 1 : undefined,
      };
    });
    if (saved?.revision !== undefined)
      await invalidateCatalogConnections(input.mcp_server_uuid, saved.revision);
    return saved?.session;
  }

  async consumeExpectedState(
    mcpServerUuid: string,
    actorUserId: string,
    expectedState: string | undefined,
  ): Promise<DatabaseOAuthSession | undefined> {
    if (!actorUserId || !expectedState) return undefined;

    return this.database.transaction(async (tx) => {
      const [ownedServer] = await tx
        .select({ uuid: mcpServersTable.uuid })
        .from(mcpServersTable)
        .where(
          and(
            eq(mcpServersTable.uuid, mcpServerUuid),
            eq(mcpServersTable.user_id, actorUserId),
          ),
        )
        .for("update");

      if (!ownedServer) return undefined;

      const [consumed] = await tx
        .update(oauthSessionsTable)
        .set({
          expected_state: null,
          expected_state_expires_at: null,
          updated_at: sql`NOW()`,
        })
        .where(
          and(
            eq(oauthSessionsTable.mcp_server_uuid, mcpServerUuid),
            eq(oauthSessionsTable.owner_user_id, actorUserId),
            eq(oauthSessionsTable.expected_state, expectedState),
            gt(oauthSessionsTable.expected_state_expires_at, sql`NOW()`),
          ),
        )
        .returning();

      return consumed;
    });
  }

  async deleteByMcpServerUuid(
    mcpServerUuid: string,
    actorUserId: string,
  ): Promise<DatabaseOAuthSession | undefined> {
    if (!actorUserId) return undefined;

    const deleted = await this.database.transaction(async (tx) => {
      const [ownedServer] = await tx
        .select({
          uuid: mcpServersTable.uuid,
          revision: mcpServersTable.tool_catalog_revision,
        })
        .from(mcpServersTable)
        .where(
          and(
            eq(mcpServersTable.uuid, mcpServerUuid),
            eq(mcpServersTable.user_id, actorUserId),
          ),
        )
        .for("update");

      if (!ownedServer) return undefined;

      const [deletedSession] = await tx
        .delete(oauthSessionsTable)
        .where(
          and(
            eq(oauthSessionsTable.mcp_server_uuid, mcpServerUuid),
            eq(oauthSessionsTable.owner_user_id, actorUserId),
          ),
        )
        .returning();

      if (deletedSession) {
        await tx
          .update(mcpServersTable)
          .set({
            tool_catalog_revision: sql`${mcpServersTable.tool_catalog_revision} + 1`,
            tool_catalog_refreshed_at: null,
          })
          .where(eq(mcpServersTable.uuid, mcpServerUuid));
      }
      return deletedSession
        ? { session: deletedSession, revision: ownedServer.revision + 1 }
        : undefined;
    });
    if (deleted)
      await invalidateCatalogConnections(mcpServerUuid, deleted.revision);
    return deleted?.session;
  }
}

export const oauthSessionsRepository = new OAuthSessionsRepository();
