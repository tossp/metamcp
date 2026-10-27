import type { OAuthClientInformation } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../index", () => ({ db: {} }));
vi.mock("../../../lib/metamcp/tool-catalog-events", () => ({
  invalidateCatalogConnections: vi.fn(),
}));
const { invalidateCatalogConnections } =
  await import("../../../lib/metamcp/tool-catalog-events");
beforeEach(() => vi.clearAllMocks());

const { OAUTH_STATE_TTL_MS, OAuthSessionsRepository } =
  await import("../oauth-sessions.repo");

const SERVER_ID = "00000000-0000-0000-0000-000000000001";
const ACTOR_ID = "user-1";

function createUpsertDatabase(serverOwner: string | null = ACTOR_ID) {
  const valuesCalls: Record<string, unknown>[] = [];
  const setCalls: Record<string, unknown>[] = [];
  const revisionUpdates: Record<string, unknown>[] = [];
  let stored: Record<string, unknown> | undefined;
  let revision = 0;

  const database = {
    transaction: vi.fn(async (callback: (tx: unknown) => unknown) => {
      let selectCount = 0;
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({
              for: async () => {
                selectCount += 1;
                if (selectCount === 1) {
                  return serverOwner === ACTOR_ID
                    ? [{ uuid: SERVER_ID, revision }]
                    : [];
                }
                return stored
                  ? [
                      {
                        owner_user_id: stored.owner_user_id,
                        tokens: stored.tokens,
                      },
                    ]
                  : [];
              },
            }),
          }),
        }),
        update: () => ({
          set: (values: Record<string, unknown>) => {
            revisionUpdates.push(values);
            revision++;
            return { where: async () => [] };
          },
        }),
        insert: () => ({
          values: (values: Record<string, unknown>) => {
            valuesCalls.push(values);
            return {
              onConflictDoUpdate: ({
                set,
              }: {
                set: Record<string, unknown>;
              }) => {
                setCalls.push(set);
                return {
                  returning: async () => {
                    const now = new Date();
                    const { updated_at: _ignored, ...setValues } = set;
                    stored = stored
                      ? { ...stored, ...setValues, updated_at: now }
                      : {
                          uuid: "session-1",
                          client_information: {},
                          tokens: null,
                          code_verifier: null,
                          expected_state: null,
                          expected_state_expires_at: null,
                          created_at: now,
                          updated_at: now,
                          ...values,
                        };
                    return [stored];
                  },
                };
              },
            };
          },
        }),
      };
      return callback(tx);
    }),
  };

  return {
    database,
    valuesCalls,
    setCalls,
    revisionUpdates,
    getStored: () => stored,
    revision: () => revision,
  };
}

describe("OAuthSessionsRepository.upsert", () => {
  const seedTokens = {
    access_token: "fake-old",
    token_type: "Bearer",
    refresh_token: "fake-refresh",
    scope: "read calendar",
  };
  const renewed = {
    access_token: "fake-new",
    token_type: "Bearer",
    refresh_token: "fake-rotated",
  };
  async function prepared() {
    const fake = createUpsertDatabase();
    const repo = new OAuthSessionsRepository(fake.database as never);
    await repo.upsert(
      { mcp_server_uuid: SERVER_ID, tokens: seedTokens },
      ACTOR_ID,
    );
    vi.mocked(invalidateCatalogConnections).mockClear();
    return { fake, repo };
  }
  const renewal = {
    tokenRenewal: true,
    expectedCatalogRevision: 1,
    expectedRefreshToken: "fake-refresh",
  };

  it("retains directory identity and scope during same-grant automatic renewal", async () => {
    const { fake, repo } = await prepared();
    const session = await repo.upsert(
      { mcp_server_uuid: SERVER_ID, tokens: renewed },
      ACTOR_ID,
      renewal,
    );
    expect(session?.tokens).toMatchObject({
      ...renewed,
      scope: "read calendar",
    });
    expect(fake.revision()).toBe(1);
    expect(invalidateCatalogConnections).not.toHaveBeenCalled();
  });

  it("does not treat equivalent scope ordering as a changed authorization", async () => {
    const { fake, repo } = await prepared();
    await repo.upsert(
      {
        mcp_server_uuid: SERVER_ID,
        tokens: { ...renewed, scope: "calendar read read" },
      },
      ACTOR_ID,
      renewal,
    );
    expect(fake.revision()).toBe(1);
    expect(invalidateCatalogConnections).not.toHaveBeenCalled();
  });

  it("invalidates with the new revision when renewal changes permission scope", async () => {
    const { fake, repo } = await prepared();
    await repo.upsert(
      { mcp_server_uuid: SERVER_ID, tokens: { ...renewed, scope: "read" } },
      ACTOR_ID,
      renewal,
    );
    expect(fake.revision()).toBe(2);
    expect(invalidateCatalogConnections).toHaveBeenCalledExactlyOnceWith(
      SERVER_ID,
      2,
    );
  });

  it("does not let a delayed renewal overwrite explicit reauthorization", async () => {
    const { fake, repo } = await prepared();
    await repo.upsert(
      {
        mcp_server_uuid: SERVER_ID,
        tokens: { ...seedTokens, refresh_token: "fake-other-owner" },
      },
      ACTOR_ID,
    );
    const result = await repo.upsert(
      { mcp_server_uuid: SERVER_ID, tokens: renewed },
      ACTOR_ID,
      renewal,
    );
    expect(result).toBeUndefined();
    expect(fake.revision()).toBe(2);
    expect(fake.getStored()?.tokens).toHaveProperty(
      "refresh_token",
      "fake-other-owner",
    );
    expect(fake.valuesCalls).toHaveLength(2);
  });

  it("uses refresh-token CAS even when a legacy caller has no expected revision", async () => {
    const { fake, repo } = await prepared();
    await repo.upsert(
      { mcp_server_uuid: SERVER_ID, tokens: renewed },
      ACTOR_ID,
      renewal,
    );
    const result = await repo.upsert(
      {
        mcp_server_uuid: SERVER_ID,
        tokens: { ...renewed, access_token: "fake-late" },
      },
      ACTOR_ID,
      {
        tokenRenewal: true,
        expectedRefreshToken: "fake-refresh",
      },
    );
    expect(result).toBeUndefined();
    expect(fake.getStored()?.tokens).toHaveProperty("access_token", "fake-new");
    expect(fake.revision()).toBe(1);
  });
  it("writes owner and state expiry on both INSERT and conflict UPDATE", async () => {
    const fake = createUpsertDatabase();
    const repo = new OAuthSessionsRepository(fake.database as never);

    await repo.upsert(
      {
        mcp_server_uuid: SERVER_ID,
        expected_state: "state-1",
      },
      ACTOR_ID,
    );

    const expectedExpiry = fake.valuesCalls[0]
      ?.expected_state_expires_at as SQL;
    const compiledExpiry = new PgDialect().sqlToQuery(expectedExpiry);
    expect(fake.valuesCalls[0]).toMatchObject({
      mcp_server_uuid: SERVER_ID,
      owner_user_id: ACTOR_ID,
      expected_state: "state-1",
    });
    expect(compiledExpiry.sql).toBe("NOW() + ($1 * INTERVAL '1 millisecond')");
    expect(compiledExpiry.params).toEqual([OAUTH_STATE_TTL_MS]);
    expect(fake.setCalls[0]).toMatchObject({
      owner_user_id: ACTOR_ID,
      expected_state: "state-1",
      expected_state_expires_at: expectedExpiry,
    });
  });

  it("implements latest-wins without clearing unrelated fields", async () => {
    const fake = createUpsertDatabase();
    const repo = new OAuthSessionsRepository(fake.database as never);

    await repo.upsert(
      {
        mcp_server_uuid: SERVER_ID,
        client_information: {
          client_id: "client-A",
        } as OAuthClientInformation,
        expected_state: "state-1",
      },
      ACTOR_ID,
    );
    const second = await repo.upsert(
      { mcp_server_uuid: SERVER_ID, expected_state: "state-2" },
      ACTOR_ID,
    );

    expect(second?.expected_state).toBe("state-2");
    expect(second?.client_information).toEqual({ client_id: "client-A" });
    expect(fake.setCalls[1]).not.toHaveProperty("client_information");
    expect(fake.revisionUpdates).toHaveLength(1);
    expect(fake.revisionUpdates[0]).toHaveProperty(
      "tool_catalog_refreshed_at",
      null,
    );
    const revision = new PgDialect().sqlToQuery(
      fake.revisionUpdates[0].tool_catalog_revision as SQL,
    );
    expect(revision.sql).toContain('"mcp_servers"."tool_catalog_revision" + 1');
  });

  it.each([
    ["public server", null],
    ["different owner", "user-2"],
  ])("fails closed for %s", async (_label, owner) => {
    const fake = createUpsertDatabase(owner);
    const repo = new OAuthSessionsRepository(fake.database as never);

    const result = await repo.upsert(
      { mcp_server_uuid: SERVER_ID, code_verifier: "verifier" },
      ACTOR_ID,
    );

    expect(result).toBeUndefined();
    expect(fake.valuesCalls).toHaveLength(0);
    expect(fake.revisionUpdates).toHaveLength(0);
  });
});
