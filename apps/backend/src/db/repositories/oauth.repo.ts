import {
  OAuthAccessToken,
  OAuthAuthorizationCode,
  OAuthAuthorizationCodeCreateInput,
  OAuthClient,
  OAuthClientCreateInput,
} from "@repo/zod-types";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";

import { db } from "../index";
import {
  oauthAccessTokensTable,
  oauthAuthorizationCodesTable,
  oauthClientsTable,
} from "../schema";

export interface OAuthTokenPairInput {
  access_token: string;
  expires_at: number;
  refresh_token: string;
  refresh_token_expires_at: number;
}

export interface ConsumeAuthorizationCodeInput {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
}

export class OAuthRepository {
  constructor(private readonly database: typeof db = db) {}

  // ===== Registered Clients =====

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const result = await this.database
      .select()
      .from(oauthClientsTable)
      .where(eq(oauthClientsTable.client_id, clientId))
      .limit(1);
    return result[0] || null;
  }

  async upsertClient(clientData: OAuthClientCreateInput): Promise<void> {
    await this.database
      .insert(oauthClientsTable)
      .values(clientData)
      .onConflictDoUpdate({
        target: oauthClientsTable.client_id,
        set: {
          redirect_uris: clientData.redirect_uris,
          updated_at: new Date(),
        },
      });
  }

  // ===== Authorization Codes =====

  async getAuthCode(code: string): Promise<OAuthAuthorizationCode | null> {
    const result = await this.database
      .select()
      .from(oauthAuthorizationCodesTable)
      .where(eq(oauthAuthorizationCodesTable.code, code))
      .limit(1);
    return result[0] || null;
  }

  async setAuthCode(
    code: string,
    data: OAuthAuthorizationCodeCreateInput,
  ): Promise<void> {
    await this.database.insert(oauthAuthorizationCodesTable).values({
      code,
      client_id: data.client_id,
      redirect_uri: data.redirect_uri,
      scope: data.scope,
      user_id: data.user_id,
      code_challenge: data.code_challenge,
      code_challenge_method: data.code_challenge_method,
      expires_at: new Date(data.expires_at),
    });
  }

  async deleteAuthCode(code: string): Promise<void> {
    await this.database
      .delete(oauthAuthorizationCodesTable)
      .where(eq(oauthAuthorizationCodesTable.code, code));
  }

  async consumeAuthorizationCode(
    input: ConsumeAuthorizationCodeInput,
    replacement: OAuthTokenPairInput,
  ): Promise<OAuthAuthorizationCode | null> {
    return this.database.transaction(async (tx) => {
      const [consumed] = await tx
        .delete(oauthAuthorizationCodesTable)
        .where(
          and(
            eq(oauthAuthorizationCodesTable.code, input.code),
            eq(oauthAuthorizationCodesTable.client_id, input.client_id),
            eq(oauthAuthorizationCodesTable.redirect_uri, input.redirect_uri),
            gt(oauthAuthorizationCodesTable.expires_at, sql`NOW()`),
            eq(oauthAuthorizationCodesTable.code_challenge_method, "S256"),
            eq(
              oauthAuthorizationCodesTable.code_challenge,
              input.code_challenge,
            ),
          ),
        )
        .returning();

      if (!consumed) return null;

      await tx.insert(oauthAccessTokensTable).values(
        this.toTokenPairValues({
          ...replacement,
          client_id: consumed.client_id,
          user_id: consumed.user_id,
          scope: consumed.scope,
        }),
      );

      return consumed;
    });
  }

  // ===== Access Tokens =====

  async getAccessToken(token: string): Promise<OAuthAccessToken | null> {
    const result = await this.database
      .select()
      .from(oauthAccessTokensTable)
      .where(eq(oauthAccessTokensTable.access_token, token))
      .limit(1);
    return result[0] || null;
  }

  async deleteAccessToken(token: string): Promise<void> {
    await this.database
      .delete(oauthAccessTokensTable)
      .where(eq(oauthAccessTokensTable.access_token, token));
  }

  // ===== Refresh Tokens =====

  async getByRefreshToken(refreshToken: string) {
    const result = await this.database
      .select()
      .from(oauthAccessTokensTable)
      .where(eq(oauthAccessTokensTable.refresh_token, refreshToken))
      .limit(1);
    return result[0] || null;
  }

  async rotateRefreshToken(
    refreshToken: string,
    clientId: string,
    replacement: OAuthTokenPairInput,
  ): Promise<OAuthAccessToken | null> {
    return this.database.transaction(async (tx) => {
      const [consumed] = await tx
        .delete(oauthAccessTokensTable)
        .where(
          and(
            eq(oauthAccessTokensTable.refresh_token, refreshToken),
            eq(oauthAccessTokensTable.client_id, clientId),
            gt(oauthAccessTokensTable.refresh_token_expires_at, sql`NOW()`),
          ),
        )
        .returning();

      if (!consumed) return null;

      await tx.insert(oauthAccessTokensTable).values(
        this.toTokenPairValues({
          ...replacement,
          client_id: consumed.client_id,
          user_id: consumed.user_id,
          scope: consumed.scope,
        }),
      );

      return consumed;
    });
  }

  // ===== Cleanup =====

  async cleanupExpired(): Promise<void> {
    const now = new Date();
    await Promise.all([
      this.database
        .delete(oauthAuthorizationCodesTable)
        .where(lt(oauthAuthorizationCodesTable.expires_at, now)),
      // Delete tokens where both access token AND refresh token are expired
      // (or refresh token is null)
      this.database
        .delete(oauthAccessTokensTable)
        .where(
          and(
            lt(oauthAccessTokensTable.expires_at, now),
            lt(oauthAccessTokensTable.refresh_token_expires_at, now),
          ),
        ),
      this.database
        .delete(oauthAccessTokensTable)
        .where(
          and(
            lt(oauthAccessTokensTable.expires_at, now),
            isNull(oauthAccessTokensTable.refresh_token),
          ),
        ),
    ]);
  }

  private toTokenPairValues(
    data: OAuthTokenPairInput & {
      client_id: string;
      user_id: string;
      scope: string;
    },
  ) {
    return {
      access_token: data.access_token,
      client_id: data.client_id,
      user_id: data.user_id,
      scope: data.scope,
      expires_at: new Date(data.expires_at),
      refresh_token: data.refresh_token,
      refresh_token_expires_at: new Date(data.refresh_token_expires_at),
    };
  }
}

export const oauthRepository = new OAuthRepository();
