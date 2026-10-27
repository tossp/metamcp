import { createHmac, randomBytes } from "node:crypto";

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ServerParameters } from "@repo/zod-types";

import type {
  CatalogRecord,
  CatalogSource,
} from "../../db/repositories/tool-catalog.repo";
import { extractForwardedHeaders } from "./header-forwarding";

const FRESH_MS = 10 * 60_000;
const RETRY_MS = 30_000;
const MAX_ENTRIES = 512;
const SAFE_ERROR = "Tool catalog refresh failed";

export interface CatalogOptions {
  includeInactive?: boolean;
  refresh?: boolean;
  headers?: Record<string, string>;
  // Deliberately not used as an identity or an upstream session ID.
  sessionId?: string;
}
export interface CatalogRefreshResult {
  serverUuid: string;
  success: boolean;
  count: number;
  error?: string;
}
export interface CatalogDependencies {
  repository: {
    findByNamespace(
      uuid: string,
      includeInactive?: boolean,
    ): Promise<CatalogRecord[]>;
    findByServerUuid(uuid: string): Promise<CatalogRecord | undefined>;
    publish(uuid: string, revision: number, tools: Tool[]): Promise<boolean>;
  };
  fetchTools(
    source: CatalogSource,
    headers: Record<string, string>,
  ): Promise<Tool[]>;
  notify(uuid: string): void;
  now?: () => number;
  defer?: (task: () => void) => void;
}
interface Entry {
  snapshot?: { tools: Tool[]; refreshedAt: number };
  retryAt: number;
  completedAt?: number;
  scheduled?: boolean;
  inflight?: Promise<CatalogRefreshResult>;
}

/** Canonical JSON compares every SDK field without treating object order as change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function fingerprint(tools: Tool[]): string {
  return tools.map(canonical).sort().join("\n");
}
function isolated(headers: Record<string, string>): boolean {
  return Object.keys(headers).length > 0;
}
function forwarded(
  source: CatalogSource,
  headers: Record<string, string> = {},
) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  // The whitelist helper only consumes forward_headers; never load saved secrets
  // merely to decide a listing's effective identity.
  const metadata = {
    uuid: source.uuid,
    name: source.name,
    forward_headers: source.forward_headers,
  } as ServerParameters;
  return (
    extractForwardedHeaders(normalized, { [source.uuid]: metadata })[
      source.uuid
    ] ?? {}
  );
}

export function createToolCatalogService(deps: CatalogDependencies) {
  const now = deps.now ?? Date.now;
  const defer =
    deps.defer ??
    ((task) => {
      setImmediate(task);
    });
  const secret = randomBytes(32);
  // Includes backoff and pending tasks in the same bound. Active entries are
  // never evicted, otherwise an evicted refresh could duplicate an upstream call.
  const entries = new Map<string, Entry>();
  const failure = (uuid: string): CatalogRefreshResult => ({
    serverUuid: uuid,
    success: false,
    count: 0,
    error: SAFE_ERROR,
  });
  const keyFor = (source: CatalogSource, headers: Record<string, string>) =>
    createHmac("sha256", secret)
      .update(canonical([source.uuid, source.revision, headers]))
      .digest("hex");

  function entryFor(key: string): Entry | undefined {
    const existing = entries.get(key);
    if (existing) {
      entries.delete(key);
      entries.set(key, existing);
      return existing;
    }
    if (entries.size >= MAX_ENTRIES) {
      const victim = [...entries].find(([, e]) => !e.inflight && !e.scheduled);
      if (!victim) return undefined;
      entries.delete(victim[0]);
    }
    const entry: Entry = { retryAt: 0 };
    entries.set(key, entry);
    return entry;
  }

  async function perform(
    record: CatalogRecord,
    headers: Record<string, string>,
    entry: Entry,
  ): Promise<CatalogRefreshResult> {
    const { source } = record;
    try {
      const tools = await deps.fetchTools(source, headers);
      // Recheck metadata immediately before committing either kind of snapshot.
      // DB publish additionally checks revision inside its transaction. Memory
      // writes below are synchronous and keyed by revision; deletes never revive.
      const current = await deps.repository.findByServerUuid(source.uuid);
      if (!current || current.source.revision !== source.revision) {
        return failure(source.uuid);
      }
      const previous = isolated(headers)
        ? entry.snapshot?.tools
        : current.tools;
      const changed =
        previous === undefined || fingerprint(previous) !== fingerprint(tools);
      if (isolated(headers)) {
        entry.snapshot = { tools: structuredClone(tools), refreshedAt: now() };
      } else if (
        !(await deps.repository.publish(source.uuid, source.revision, tools))
      ) {
        return failure(source.uuid);
      }
      entry.retryAt = 0;
      entry.completedAt = now();
      // A notification failure must not turn a committed snapshot into a failure.
      if (changed) {
        try {
          deps.notify(source.uuid);
        } catch {
          /* no credential-bearing logs */
        }
      }
      return { serverUuid: source.uuid, success: true, count: tools.length };
    } catch {
      entry.retryAt = now() + RETRY_MS;
      return failure(source.uuid);
    }
  }

  function refresh(
    record: CatalogRecord,
    headers: Record<string, string>,
    entry: Entry,
    manual: boolean,
  ): Promise<CatalogRefreshResult> {
    if (entry.inflight) return entry.inflight;
    if (!manual && entry.retryAt > now())
      return Promise.resolve(failure(record.source.uuid));
    // Insert the pending promise before any dependency executes (including sync
    // fakes), so lazy and manual requests share exactly the same refresh.
    const pending = Promise.resolve().then(() =>
      perform(record, headers, entry),
    );
    entry.inflight = pending;
    void pending.finally(() => {
      if (entry.inflight === pending) entry.inflight = undefined;
    });
    return pending;
  }

  async function listCatalogTools(
    namespaceUuid: string,
    options: CatalogOptions = {},
  ) {
    const records = await deps.repository.findByNamespace(
      namespaceUuid,
      options.includeInactive,
    );
    return records.flatMap((record) => {
      const { source } = record;
      const headers = forwarded(source, options.headers);
      const entry = entryFor(keyFor(source, headers));
      const snapshot = isolated(headers)
        ? entry?.snapshot
        : {
            tools: record.tools,
            refreshedAt: source.refreshedAt?.getTime(),
          };
      if (
        options.refresh !== false &&
        entry &&
        !entry.inflight &&
        !entry.scheduled &&
        entry.retryAt <= now() &&
        (snapshot?.refreshedAt === undefined ||
          now() - snapshot.refreshedAt >= FRESH_MS)
      ) {
        entry.scheduled = true;
        defer(() => {
          entry.scheduled = false;
          // A manual refresh might have completed between scheduling and running.
          if (
            entry.completedAt !== undefined &&
            now() - entry.completedAt < FRESH_MS
          )
            return;
          void refresh(record, headers, entry, false);
        });
      }
      return (snapshot?.tools ?? []).map((tool) => ({
        serverUuid: source.uuid,
        serverName: source.name,
        revision: source.revision,
        tool: structuredClone(tool),
      }));
    });
  }

  async function refreshCatalogTools(
    serverUuid: string,
    options: CatalogOptions = {},
  ) {
    try {
      const record = await deps.repository.findByServerUuid(serverUuid);
      if (!record) return failure(serverUuid);
      const headers = forwarded(record.source, options.headers);
      const entry = entryFor(keyFor(record.source, headers));
      if (!entry) return failure(serverUuid);
      return await refresh(record, headers, entry, true);
    } catch {
      return failure(serverUuid);
    }
  }
  return { listCatalogTools, refreshCatalogTools };
}
