import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  members: vi.fn(),
  idle: vi.fn(),
  openapi: vi.fn(),
  clear: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../db/repositories/namespace-mappings.repo", () => ({
  namespaceMappingsRepository: { findNamespacesByServerUuid: fakes.members },
}));
vi.mock("./metamcp-server-pool", () => ({
  metaMcpServerPool: {
    invalidateIdleServers: fakes.idle,
    invalidateOpenApiSessions: fakes.openapi,
  },
}));
vi.mock("./metamcp-middleware/tool-overrides.functional", () => ({
  clearOverrideCache: fakes.clear,
}));
vi.mock("@/utils/logger", () => ({ default: { error: fakes.error } }));

import { invalidateNamespaceSessionsForServer } from "./invalidate-namespace-sessions";

beforeEach(() => {
  vi.resetAllMocks();
  fakes.members.mockResolvedValue(["first", "second"]);
  fakes.idle.mockResolvedValue(undefined);
  fakes.openapi.mockResolvedValue(undefined);
});
describe("derived sessions after a server configuration update", () => {
  it("invalidates only the affected namespaces without waiting on idle cleanup", async () => {
    let release!: () => void;
    fakes.idle.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await invalidateNamespaceSessionsForServer("server");
    expect(fakes.members).toHaveBeenCalledWith("server");
    expect(fakes.idle).toHaveBeenCalledWith(["first", "second"]);
    expect(fakes.openapi).toHaveBeenCalledWith(["first", "second"]);
    expect(fakes.clear.mock.calls).toEqual([["first"], ["second"]]);
    release();
  });
  it("does nothing when no namespace references the server", async () => {
    fakes.members.mockResolvedValue([]);
    await invalidateNamespaceSessionsForServer("server");
    expect(fakes.idle).not.toHaveBeenCalled();
    expect(fakes.openapi).not.toHaveBeenCalled();
  });
  it("does not reflect secret-bearing cleanup exceptions into logs", async () => {
    fakes.idle.mockRejectedValue(new Error("fake-secret"));
    fakes.openapi.mockRejectedValue(new Error("fake-secret"));
    await invalidateNamespaceSessionsForServer("server");
    await Promise.resolve();
    expect(fakes.error).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(fakes.error.mock.calls)).not.toContain("fake-secret");
  });
});
