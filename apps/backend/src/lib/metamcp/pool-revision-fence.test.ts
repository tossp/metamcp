import type { ServerParameters } from "@repo/zod-types";
import { beforeEach, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../db/repositories/tool-catalog.repo", () => ({
  toolCatalogRepository: { findRevisionByServerUuid: fakes.read },
}));

beforeEach(() => {
  vi.resetModules();
  fakes.read.mockReset().mockResolvedValue(1);
});

it("coalesces cold module loading but queries fresh metadata independently for concurrent callers", async () => {
  const { readServerRevision } = await import("./pool-revision-fence");
  expect(
    await Promise.all(
      Array.from({ length: 12 }, () => readServerRevision("server")),
    ),
  ).toEqual(Array(12).fill(1));
  expect(fakes.read).toHaveBeenCalledTimes(12);
  fakes.read.mockResolvedValue(2);
  expect(await readServerRevision("server")).toBe(2);
  expect(fakes.read).toHaveBeenCalledTimes(13);
});

it("legacy synthetic parameters never query repository metadata", async () => {
  const { isCurrentServerRevision } = await import("./pool-revision-fence");
  const params: ServerParameters = {
    uuid: "synthetic",
    name: "Synthetic",
    description: "",
    type: "STREAMABLE_HTTP",
    url: "https://synthetic.invalid/mcp",
    status: "ACTIVE",
    stderr: "pipe",
    created_at: "2026-10-27T00:00:00Z",
  };
  expect(await isCurrentServerRevision(params)).toBe(true);
  expect(fakes.read).not.toHaveBeenCalled();
});
