import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findByUuid, launchSaved, launchTemporary } = vi.hoisted(() => ({
  findByUuid: vi.fn(),
  launchSaved: vi.fn(),
  launchTemporary: vi.fn(),
}));
vi.mock("../../db/repositories", () => ({
  mcpServersRepository: { findByUuid },
}));
vi.mock("./inspector-stdio-launch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inspector-stdio-launch")>()),
  launchInspectorSavedStdioTransport: launchSaved,
  launchInspectorStdioTransport: launchTemporary,
}));

import {
  inspectorStdioRouteAdapters,
  launchInspectorConfiguredStdio,
} from "./inspector-stdio-config";

const configId = randomUUID();
const saved = {
  uuid: configId,
  user_id: "owner",
  type: "STDIO",
  command: "/saved/command",
  args: ["argument with spaces", "quoted'argument", "${LITERAL_ARG}"],
  env: { DAV_PASSWORD: "virtual-saved-secret" },
};
const input = { actorId: "owner", query: { configId } };

beforeEach(() => {
  vi.clearAllMocks();
  findByUuid.mockResolvedValue(saved);
  launchSaved.mockResolvedValue("transport");
  launchTemporary.mockResolvedValue("temporary");
});

describe("saved Inspector configuration", () => {
  it.each(["owner", null])(
    "allows own or public configuration (%s)",
    async (owner) => {
      findByUuid.mockResolvedValue({ ...saved, user_id: owner });
      await expect(launchInspectorConfiguredStdio(input)).resolves.toBe(
        "transport",
      );
      expect(findByUuid).toHaveBeenCalledExactlyOnceWith(configId);
      expect(launchSaved).toHaveBeenCalledExactlyOnceWith(
        { configId, command: saved.command, args: saved.args, env: saved.env },
        "owner",
        undefined,
      );
      expect(launchTemporary).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, { ...saved, user_id: "other-owner" }])(
    "does not distinguish missing from inaccessible configuration",
    async (record) => {
      findByUuid.mockResolvedValue(record);
      await expect(launchInspectorConfiguredStdio(input)).rejects.toMatchObject(
        {
          statusCode: 404,
          reason: "unavailable",
          message: "Inspector configuration is not available",
        },
      );
      expect(launchSaved).not.toHaveBeenCalled();
      expect(launchTemporary).not.toHaveBeenCalled();
    },
  );

  it("requires actor identity even for public configurations", async () => {
    findByUuid.mockResolvedValue({ ...saved, user_id: null });
    await expect(
      launchInspectorConfiguredStdio({ query: { configId } }),
    ).rejects.toMatchObject({
      statusCode: 401,
      reason: "unauthorized",
    });
    expect(findByUuid).not.toHaveBeenCalled();
    expect(launchSaved).not.toHaveBeenCalled();
  });

  it.each(["bad-id", [configId], { id: configId }, 1])(
    "rejects malformed configId",
    async (value) => {
      await expect(
        launchInspectorConfiguredStdio({
          ...input,
          query: { configId: value },
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        reason: "invalid_request",
      });
      expect(findByUuid).not.toHaveBeenCalled();
      expect(launchSaved).not.toHaveBeenCalled();
      expect(launchTemporary).not.toHaveBeenCalled();
    },
  );

  it.each([
    { command: "/override" },
    { command: "" },
    { args: "" },
    { args: "--override" },
    { env: "{}" },
    { env: '{"PASSWORD":"request-secret"}' },
  ])("rejects all request overrides before lookup", async (override) => {
    await expect(
      launchInspectorConfiguredStdio({
        ...input,
        query: { configId, ...override },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      reason: "invalid_request",
    });
    expect(findByUuid).not.toHaveBeenCalled();
    expect(launchSaved).not.toHaveBeenCalled();
    expect(launchTemporary).not.toHaveBeenCalled();
  });

  it.each([
    { type: "SSE" },
    { type: "STREAMABLE_HTTP" },
    { command: null },
    { command: " " },
    { command: "bad\0command" },
    { args: null },
    { args: [1] },
    { args: ["bad\0argument"] },
  ])("rejects invalid saved STDIO configuration", async (fields) => {
    findByUuid.mockResolvedValue({ ...saved, ...fields });
    await expect(launchInspectorConfiguredStdio(input)).rejects.toMatchObject({
      statusCode: 400,
      reason: "invalid_request",
    });
    expect(launchSaved).not.toHaveBeenCalled();
    expect(launchTemporary).not.toHaveBeenCalled();
  });

  it("returns a fixed error when repository access fails", async () => {
    findByUuid.mockRejectedValue(
      new Error("database query containing a virtual secret"),
    );
    await expect(launchInspectorConfiguredStdio(input)).rejects.toMatchObject({
      statusCode: 500,
      reason: "configuration_failed",
      message: "Inspector configuration could not be loaded",
    });
    expect(launchSaved).not.toHaveBeenCalled();
    expect(launchTemporary).not.toHaveBeenCalled();
  });

  it("preserves restricted temporary launch without a saved reference", async () => {
    const temporaryInput = {
      actorId: "owner",
      query: { command: "node", args: "", env: "{}" },
    };
    await expect(launchInspectorConfiguredStdio(temporaryInput)).resolves.toBe(
      "temporary",
    );
    expect(launchTemporary).toHaveBeenCalledExactlyOnceWith(temporaryInput);
    expect(findByUuid).not.toHaveBeenCalled();
    expect(launchSaved).not.toHaveBeenCalled();
  });

  it.each(["stdio", "sse", "mcp"] as const)(
    "uses saved authorization for the %s adapter",
    async (route) => {
      await expect(inspectorStdioRouteAdapters[route](input)).resolves.toBe(
        "transport",
      );
      expect(findByUuid).toHaveBeenCalledExactlyOnceWith(configId);
      expect(launchSaved).toHaveBeenCalledOnce();
      expect(launchTemporary).not.toHaveBeenCalled();
    },
  );
});
