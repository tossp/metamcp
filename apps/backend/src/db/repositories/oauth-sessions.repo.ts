import { DatabaseOAuthSession, OAuthSessionUpdateInput } from "@repo/zod-types";
import { and, eq, gt, sql } from "drizzle-orm";

import { db } from "../index";
import { mcpServersTable, oauthSessionsTable } from "../schema";

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_STATE_EXPIRES_AT_SQL = sql`NOW() + (${OAUTH_STATE_TTL_MS} * INTERVAL '1 millisecond')`;

export class OAuthSessionsRepository {
  constructor(private readonly database: typeof db = db) {}

  async findByMcpServerUuid(
    mcpServerUuid: string,
    actorUserId: string,
  ): Promise<DatabaseOAuthSession | undefined> {
    if (!actorUserId) return undefined;

    const [session] = await this.database
      .select({
        uuid: oauthSessionsTable.uuid,
        mcp_server_uuid: oauthSessionsTable.mcp_server_uuid,
        owner_user_id: oauthSessionsTable.owner_user_id,
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
  ): Promise<DatabaseOAuthSession | undefined> {
    if (!actorUserId) return undefined;

    return this.database.transaction(async (tx) => {
      const [ownedServer] = await tx
        .select({ uuid: mcpServersTable.uuid })
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
        .select({ owner_user_id: oauthSessionsTable.owner_user_id })
        .from(oauthSessionsTable)
        .where(eq(oauthSessionsTable.mcp_server_uuid, input.mcp_server_uuid))
        .for("update");

      if (existingSession && existingSession.owner_user_id !== actorUserId) {
        return undefined;
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
          ...(input.tokens !== undefined && { tokens: input.tokens }),
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
            ...(input.tokens !== undefined && { tokens: input.tokens }),
            ...(input.code_verifier !== undefined && {
              code_verifier: input.code_verifier,
            }),
            ...stateUpdate,
            updated_at: sql`NOW()`,
          },
        })
        .returning();

      return row;
    });
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

      const [deletedSession] = await tx
        .delete(oauthSessionsTable)
        .where(
          and(
            eq(oauthSessionsTable.mcp_server_uuid, mcpServerUuid),
            eq(oauthSessionsTable.owner_user_id, actorUserId),
          ),
        )
        .returning();

      return deletedSession;
    });
  }
}

export const oauthSessionsRepository = new OAuthSessionsRepository();
