import { describe, expect, it, vi } from "vitest";

vi.mock("../../index", () => ({ db: {} }));
vi.mock("@/utils/logger", () => ({
  default: { error: vi.fn() },
}));

const { McpServersRepository } = await import("../mcp-servers.repo");

function createDatabase(currentOwner: string | null) {
  const deleteWhere = vi.fn(async () => []);
  const updateReturning = vi.fn(async () => [
    { uuid: "server-1", user_id: null, name: "server" },
  ]);
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({ for: async () => [{ user_id: currentOwner }] }),
      }),
    }),
    delete: () => ({ where: deleteWhere }),
    update: () => ({
      set: () => ({ where: () => ({ returning: updateReturning }) }),
    }),
  };
  return {
    database: {
      transaction: async (callback: (value: unknown) => unknown) =>
        callback(tx),
    },
    deleteWhere,
  };
}

describe("McpServersRepository OAuth invalidation", () => {
  it("deletes the OAuth session transactionally when a server is publicized", async () => {
    const fake = createDatabase("owner-1");
    const repo = new McpServersRepository(fake.database as never);

    await repo.update({ uuid: "server-1", user_id: null });

    expect(fake.deleteWhere).toHaveBeenCalledTimes(1);
  });

  it("keeps the OAuth session when ownership is unchanged", async () => {
    const fake = createDatabase("owner-1");
    const repo = new McpServersRepository(fake.database as never);

    await repo.update({ uuid: "server-1", user_id: "owner-1" });

    expect(fake.deleteWhere).not.toHaveBeenCalled();
  });
});
