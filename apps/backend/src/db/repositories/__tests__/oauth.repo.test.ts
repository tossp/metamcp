import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the WHERE conditions handed to each delete so we can assert the
// cleanup issues all of its statements. The db connection is faked; the real
// drizzle condition builders (lt/and/isNull) run against the real table
// schemas, which is exactly the code path the regression below exercises.
const whereCalls: unknown[] = [];

vi.mock("../../index", () => {
  return {
    db: {
      delete: () => ({
        where: (condition: unknown) => {
          whereCalls.push(condition);
          return Promise.resolve(undefined);
        },
      }),
    },
  };
});

// Import AFTER vi.mock so the repo binds to the fake db.
const { OAuthRepository, oauthRepository } = await import("../oauth.repo");

describe("OAuthRepository.cleanupExpired", () => {
  beforeEach(() => {
    whereCalls.length = 0;
  });

  it("builds and runs every cleanup delete without throwing", async () => {
    // Regression: the "refresh token is null" branch used
    // `isNotNull(...).not()`, which throws a TypeError at query-build time
    // because drizzle's SQL has no `.not()`. It must build via `isNull(...)`.
    await expect(oauthRepository.cleanupExpired()).resolves.toBeUndefined();

    // Three deletes: expired auth codes, fully-expired tokens, null-refresh
    // tokens. Each must have built a WHERE condition.
    expect(whereCalls).toHaveLength(3);
    for (const condition of whereCalls) {
      expect(condition).toBeDefined();
    }
  });
});

describe("OAuthRepository atomic grant consumption", () => {
  const replacement = {
    access_token: "access-new",
    expires_at: Date.now() + 60_000,
    refresh_token: "refresh-new",
    refresh_token_expires_at: Date.now() + 120_000,
  };

  function transactionDatabase(consumed: Record<string, unknown>) {
    const events: string[] = [];
    const inserted: unknown[] = [];
    const tx = {
      delete: () => {
        events.push("delete");
        return {
          where: () => {
            events.push("where");
            return {
              returning: async () => {
                events.push("returning");
                return [consumed];
              },
            };
          },
        };
      },
      insert: () => {
        events.push("insert");
        return {
          values: async (values: unknown) => {
            events.push("values");
            inserted.push(values);
          },
        };
      },
    };
    const database = {
      transaction: async (callback: (transaction: typeof tx) => unknown) => {
        events.push("transaction");
        return callback(tx);
      },
    };
    return { database, events, inserted };
  }

  it("deletes the matching code with returning before inserting its token pair", async () => {
    const consumed = {
      code: "code-1",
      client_id: "client-1",
      redirect_uri: "https://client.example/callback",
      scope: "admin",
      user_id: "user-1",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      expires_at: new Date(Date.now() + 60_000),
      created_at: new Date(),
    };
    const { database, events, inserted } = transactionDatabase(consumed);
    const repository = new OAuthRepository(database as never);

    await expect(
      repository.consumeAuthorizationCode(
        {
          code: "code-1",
          client_id: "client-1",
          redirect_uri: "https://client.example/callback",
          code_challenge: "challenge",
        },
        replacement,
      ),
    ).resolves.toEqual(consumed);

    expect(events).toEqual([
      "transaction",
      "delete",
      "where",
      "returning",
      "insert",
      "values",
    ]);
    expect(inserted[0]).toMatchObject({
      client_id: "client-1",
      user_id: "user-1",
      scope: "admin",
      access_token: "access-new",
      refresh_token: "refresh-new",
    });
  });

  it("deletes the matching refresh token with returning before inserting replacement", async () => {
    const consumed = {
      access_token: "access-old",
      client_id: "client-1",
      user_id: "user-1",
      scope: "admin",
      expires_at: new Date(),
      refresh_token: "refresh-old",
      refresh_token_expires_at: new Date(Date.now() + 60_000),
      created_at: new Date(),
    };
    const { database, events } = transactionDatabase(consumed);
    const repository = new OAuthRepository(database as never);

    await expect(
      repository.rotateRefreshToken("refresh-old", "client-1", replacement),
    ).resolves.toEqual(consumed);
    expect(events).toEqual([
      "transaction",
      "delete",
      "where",
      "returning",
      "insert",
      "values",
    ]);
  });
});
