import type { OAuthClientInformation } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../index", () => ({ db: {} }));

const { OAUTH_STATE_TTL_MS, OAuthSessionsRepository } =
  await import("../oauth-sessions.repo");

const SERVER_ID = "00000000-0000-0000-0000-000000000001";
const ACTOR_ID = "user-1";

function createUpsertDatabase(serverOwner: string | null = ACTOR_ID) {
  const valuesCalls: Record<string, unknown>[] = [];
  const setCalls: Record<string, unknown>[] = [];
  let stored: Record<string, unknown> | undefined;

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
                  return serverOwner === ACTOR_ID ? [{ uuid: SERVER_ID }] : [];
                }
                return stored ? [{ owner_user_id: stored.owner_user_id }] : [];
              },
            }),
          }),
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

  return { database, valuesCalls, setCalls, getStored: () => stored };
}

describe("OAuthSessionsRepository.upsert", () => {
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
  });
});
