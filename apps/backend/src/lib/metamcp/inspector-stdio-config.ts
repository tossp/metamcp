import { McpServerTypeEnum } from "@repo/zod-types";

import { mcpServersRepository } from "../../db/repositories";
import {
  createInspectorStdioRouteAdapters,
  InspectorStdioLaunchError,
  InspectorStdioLaunchInput,
  launchInspectorSavedStdioTransport,
  launchInspectorStdioTransport,
  normalizeInspectorConfigId,
} from "./inspector-stdio-launch";

/** Resolve saved configurations inside the authenticated service, never from URL overrides. */
export async function launchInspectorConfiguredStdio(
  input: InspectorStdioLaunchInput,
) {
  const configId = normalizeInspectorConfigId(input.query.configId);
  if (!configId) {
    return launchInspectorStdioTransport(input);
  }

  if (!input.actorId) {
    throw new InspectorStdioLaunchError(
      "Inspector authentication is required",
      401,
      "unauthorized",
    );
  }
  if (
    input.query.command !== undefined ||
    input.query.args !== undefined ||
    input.query.env !== undefined
  ) {
    throw new InspectorStdioLaunchError(
      "Saved Inspector configuration does not accept request overrides",
      400,
      "invalid_request",
    );
  }

  let server;
  try {
    server = await mcpServersRepository.findByUuid(configId);
  } catch {
    throw new InspectorStdioLaunchError(
      "Inspector configuration could not be loaded",
      500,
      "configuration_failed",
    );
  }
  if (
    !server ||
    (server.user_id !== null && server.user_id !== input.actorId)
  ) {
    throw new InspectorStdioLaunchError(
      "Inspector configuration is not available",
      404,
      "unavailable",
    );
  }
  if (
    server.type !== McpServerTypeEnum.enum.STDIO ||
    typeof server.command !== "string" ||
    !server.command.trim() ||
    server.command.includes("\0") ||
    !Array.isArray(server.args) ||
    server.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  ) {
    throw new InspectorStdioLaunchError(
      "Inspector configuration must contain a valid STDIO command",
      400,
      "invalid_request",
    );
  }

  return launchInspectorSavedStdioTransport(
    { configId, command: server.command, args: server.args, env: server.env },
    input.actorId,
    input.terminationGracePeriodMs,
  );
}

export const inspectorStdioRouteAdapters = createInspectorStdioRouteAdapters(
  launchInspectorConfiguredStdio,
);
