import { describe, expect, it, vi } from "vitest";

vi.mock("../../index", () => ({ db: {} }));
vi.mock("@/utils/logger", () => ({
  default: { error: vi.fn() },
}));

const { McpServersRepository } = await import("../mcp-servers.repo");

function createQueryDatabase() {
  const server = { uuid: "server-1", user_id: "owner-1", name: "server" };
  const insertReturning = vi.fn(async () => [server]);
  const selectOrderBy = vi.fn(async () => [server]);
  const selectLimit = vi.fn(async () => [server]);
  const deleteReturning = vi.fn(async () => [server]);
  const database = {
    insert: vi.fn(() => ({
      values: () => ({ returning: insertReturning }),
    })),
    select: vi.fn(() => ({
      from: () => ({
        orderBy: selectOrderBy,
        where: () => ({ limit: selectLimit }),
      }),
    })),
    delete: vi.fn(() => ({
      where: () => ({ returning: deleteReturning }),
    })),
  };
  return {
    database,
    deleteReturning,
    insertReturning,
    selectLimit,
    selectOrderBy,
  };
}

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
  it("uses the injected database for create, find, and delete methods", async () => {
    const fake = createQueryDatabase();
    const repo = new McpServersRepository(fake.database as never);

    await expect(
      repo.create({
        name: "server",
        type: "STDIO",
        command: "node",
        forward_headers: {},
      }),
    ).resolves.toMatchObject({ uuid: "server-1" });
    await expect(repo.findAll()).resolves.toHaveLength(1);
    await expect(repo.findByUuid("server-1")).resolves.toMatchObject({
      uuid: "server-1",
    });
    await expect(repo.deleteByUuid("server-1")).resolves.toMatchObject({
      uuid: "server-1",
    });

    expect(fake.insertReturning).toHaveBeenCalledOnce();
    expect(fake.selectOrderBy).toHaveBeenCalledOnce();
    expect(fake.selectLimit).toHaveBeenCalledOnce();
    expect(fake.deleteReturning).toHaveBeenCalledOnce();
  });

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
