import { and, eq } from "drizzle-orm";

import { db } from "../../../db/index";
import {
  mcpServersTable,
  namespaceServerMappingsTable,
  namespaceToolMappingsTable,
  toolsTable,
} from "../../../db/schema";
import { exposedServerName } from "./exposed-server-name";

interface ToolOverride {
  overrideName?: string | null;
  overrideTitle?: string | null;
  overrideDescription?: string | null;
  overrideAnnotations?: Record<string, unknown> | null;
}

export interface ScopedToolPolicy extends ToolOverride {
  status: string | null;
}
export interface ScopedServerPolicy {
  uuid: string;
  status: string;
  tools: Map<string, ScopedToolPolicy | null>;
}

/** One request-local projection; never retains membership or policy across requests. */
export async function loadNamespaceToolPolicies(namespaceUuid: string) {
  const rows = await db
    .select({
      serverUuid: mcpServersTable.uuid,
      serverName: mcpServersTable.name,
      serverStatus: namespaceServerMappingsTable.status,
      toolName: toolsTable.name,
      status: namespaceToolMappingsTable.status,
      overrideName: namespaceToolMappingsTable.override_name,
      overrideTitle: namespaceToolMappingsTable.override_title,
      overrideDescription: namespaceToolMappingsTable.override_description,
      overrideAnnotations: namespaceToolMappingsTable.override_annotations,
    })
    .from(namespaceServerMappingsTable)
    .innerJoin(
      mcpServersTable,
      eq(mcpServersTable.uuid, namespaceServerMappingsTable.mcp_server_uuid),
    )
    .leftJoin(
      namespaceToolMappingsTable,
      and(
        eq(
          namespaceToolMappingsTable.namespace_uuid,
          namespaceServerMappingsTable.namespace_uuid,
        ),
        eq(namespaceToolMappingsTable.mcp_server_uuid, mcpServersTable.uuid),
      ),
    )
    .leftJoin(
      toolsTable,
      and(
        eq(toolsTable.uuid, namespaceToolMappingsTable.tool_uuid),
        eq(toolsTable.mcp_server_uuid, mcpServersTable.uuid),
      ),
    )
    .where(eq(namespaceServerMappingsTable.namespace_uuid, namespaceUuid));

  const servers = new Map<string, ScopedServerPolicy | null>();
  for (const row of rows) {
    const name = exposedServerName(row.serverName);
    let server = servers.get(name);
    if (server === null) continue;
    if (server && server.uuid !== row.serverUuid) {
      servers.set(name, null);
      continue;
    }
    if (!server) {
      server = {
        uuid: row.serverUuid,
        status: row.serverStatus,
        tools: new Map(),
      };
      servers.set(name, server);
    }
    if (row.toolName !== null) {
      server.tools.set(
        row.toolName,
        server.tools.has(row.toolName)
          ? null
          : {
              status: row.status,
              overrideName: row.overrideName,
              overrideTitle: row.overrideTitle,
              overrideDescription: row.overrideDescription,
              overrideAnnotations: row.overrideAnnotations,
            },
      );
    }
  }
  return servers;
}

/** Resolve the current namespace membership, never a globally named server. */
export async function resolveNamespaceServer(
  namespaceUuid: string,
  serverName: string,
) {
  const memberships = await db
    .select({
      uuid: mcpServersTable.uuid,
      name: mcpServersTable.name,
      status: namespaceServerMappingsTable.status,
    })
    .from(mcpServersTable)
    .innerJoin(
      namespaceServerMappingsTable,
      eq(namespaceServerMappingsTable.mcp_server_uuid, mcpServersTable.uuid),
    )
    .where(eq(namespaceServerMappingsTable.namespace_uuid, namespaceUuid));

  // The proxy exposes a sanitized prefix, not the raw database name. Filter
  // all namespace memberships before checking uniqueness; do not limit first.
  const servers = memberships.filter(
    (server) => exposedServerName(server.name) === serverName,
  );

  // Count all memberships, including inactive ones: an inactive namesake must
  // not make an otherwise ambiguous exposed server prefix appear unique.
  if (servers.length > 1) {
    throw new Error("Ambiguous server name in namespace");
  }
  const server = servers[0];
  return server
    ? { ...server, name: exposedServerName(server.name) }
    : undefined;
}

export async function requireNamespaceServer(
  namespaceUuid: string,
  serverName: string,
) {
  const server = await resolveNamespaceServer(namespaceUuid, serverName);
  if (!server || server.status !== "ACTIVE") {
    throw new Error("Server is not active in this namespace");
  }
  return server;
}
