import { createHash } from "node:crypto";

import { parse as shellParseArgs } from "shell-quote";
import { findActualExecutable } from "spawn-rx";

import logger from "@/utils/logger";

import { ProcessManagedStdioTransport } from "../stdio-transport/process-managed-transport";
import {
  createInspectorEnvironment,
  InspectorEnvironmentError,
} from "./inspector-environment";

export const INSPECTOR_STDIO_POLICY_VERSION = "restricted-env-v1";
export const MAX_STDIO_COOLDOWN_ENTRIES = 1024;
const STDIO_COOLDOWN_DURATION_MS = 10_000;
const QUICK_FAILURE_THRESHOLD_MS = 5_000;

export class InspectorStdioCooldownRegistry {
  private readonly entries = new Map<string, number>();

  constructor(private readonly maxEntries = MAX_STDIO_COOLDOWN_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("Cooldown capacity must be a positive integer");
    }
  }

  get(key: string, now = Date.now()): number | undefined {
    this.sweepExpired(now);
    return this.entries.get(key);
  }

  set(key: string, expiresAt: number, now = Date.now()): void {
    this.sweepExpired(now);
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, expiresAt);
  }

  getSize(now = Date.now()): number {
    this.sweepExpired(now);
    return this.entries.size;
  }

  private sweepExpired(now: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}

const stdioCooldowns = new InspectorStdioCooldownRegistry();

export interface InspectorStdioQuery {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  configId?: unknown;
}

export interface InspectorStdioLaunchInput {
  query: InspectorStdioQuery;
  actorId?: string;
  terminationGracePeriodMs?: number;
}

export interface InspectorStdioLaunchIdentity {
  configId?: string;
  fingerprint: string;
}

export class InspectorStdioLaunchError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly reason:
      | "invalid_request"
      | "restricted_environment"
      | "cooldown"
      | "spawn_failed",
  ) {
    super(message);
    this.name = "InspectorStdioLaunchError";
  }
}

type InspectorStdioLauncher = (
  input: InspectorStdioLaunchInput,
) => Promise<ProcessManagedStdioTransport>;

const launchDetails = new WeakMap<
  ProcessManagedStdioTransport,
  InspectorStdioLaunchIdentity & {
    homeDirectory: string;
    rootDirectory: string;
    tempDirectory: string;
  }
>();

function normalizeConfigId(value: unknown): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new InspectorStdioLaunchError(
      "Inspector configId must be a UUID",
      400,
      "invalid_request",
    );
  }
  return value;
}

function parseLaunchQuery(query: InspectorStdioQuery) {
  if (typeof query.command !== "string" || query.command.length === 0) {
    throw new InspectorStdioLaunchError(
      "Inspector command is required",
      400,
      "invalid_request",
    );
  }
  if (query.args !== undefined && typeof query.args !== "string") {
    throw new InspectorStdioLaunchError(
      "Inspector arguments must be a string",
      400,
      "invalid_request",
    );
  }

  const parsedArgs = shellParseArgs(query.args ?? "");
  if (parsedArgs.some((arg) => typeof arg !== "string")) {
    throw new InspectorStdioLaunchError(
      "Inspector arguments must not contain shell operators",
      400,
      "invalid_request",
    );
  }

  const { cmd, args } = findActualExecutable(
    query.command,
    parsedArgs as string[],
  );
  return {
    command: cmd,
    args,
    configId: normalizeConfigId(query.configId),
  };
}

export function createInspectorStdioFingerprint(
  command: string,
  args: string[],
): string {
  const canonicalConfiguration = JSON.stringify({
    args,
    command,
    policyVersion: INSPECTOR_STDIO_POLICY_VERSION,
  });
  return createHash("sha256").update(canonicalConfiguration).digest("hex");
}

function createCooldownKey(
  actorId: string | undefined,
  configId: string | undefined,
  fingerprint: string,
): string {
  return JSON.stringify({
    actorId: actorId ?? "authenticated",
    configId: configId ?? "unassociated",
    fingerprint,
  });
}

function logLifecycle(
  identity: InspectorStdioLaunchIdentity,
  event: string,
  exitCode?: number | null,
) {
  logger.info(
    `[inspector.stdio] configId=${identity.configId ?? "unassociated"} fingerprint=${identity.fingerprint.slice(0, 12)} event=${event} exitCode=${exitCode ?? "none"}`,
  );
}

export async function launchInspectorStdioTransport({
  query,
  actorId,
  terminationGracePeriodMs,
}: InspectorStdioLaunchInput): Promise<ProcessManagedStdioTransport> {
  let parsed: ReturnType<typeof parseLaunchQuery>;
  try {
    parsed = parseLaunchQuery(query);
  } catch (error) {
    if (error instanceof InspectorStdioLaunchError) {
      throw error;
    }
    throw new InspectorStdioLaunchError(
      "Inspector command configuration is invalid",
      400,
      "invalid_request",
    );
  }

  const fingerprint = createInspectorStdioFingerprint(
    parsed.command,
    parsed.args,
  );
  const identity = { configId: parsed.configId, fingerprint };
  const cooldownKey = createCooldownKey(actorId, parsed.configId, fingerprint);
  const now = Date.now();
  const cooldownEnd = stdioCooldowns.get(cooldownKey, now);
  if (cooldownEnd !== undefined && cooldownEnd > now) {
    logLifecycle(identity, "cooldown-rejected");
    throw new InspectorStdioLaunchError(
      "Inspector child is temporarily in cooldown",
      429,
      "cooldown",
    );
  }

  let environment;
  try {
    environment = await createInspectorEnvironment(query.env);
  } catch (error) {
    if (error instanceof InspectorEnvironmentError) {
      logLifecycle(identity, `environment-rejected-${error.reason}`);
      throw new InspectorStdioLaunchError(
        error.message,
        400,
        "restricted_environment",
      );
    }
    logLifecycle(identity, "environment-initialization-failed");
    throw new InspectorStdioLaunchError(
      "Inspector restricted environment initialization failed",
      500,
      "restricted_environment",
    );
  }

  const startedAt = Date.now();
  let finalized = false;
  const finalize = async (setCooldown: boolean) => {
    if (finalized) {
      return;
    }
    finalized = true;
    if (setCooldown) {
      const now = Date.now();
      stdioCooldowns.set(cooldownKey, now + STDIO_COOLDOWN_DURATION_MS, now);
    }
    await environment.cleanup();
  };

  const transport = new ProcessManagedStdioTransport({
    args: parsed.args,
    command: parsed.command,
    env: environment.env,
    envMode: "exact",
    lifecycleLogging: false,
    stderr: "pipe",
    terminationGracePeriodMs,
  });

  launchDetails.set(transport, {
    ...identity,
    homeDirectory: environment.homeDirectory,
    rootDirectory: environment.rootDirectory,
    tempDirectory: environment.tempDirectory,
  });

  transport.addInternalLifecycleListener(async (event) => {
    const quickFailure =
      !event.closeRequested &&
      Date.now() - startedAt < QUICK_FAILURE_THRESHOLD_MS;
    logLifecycle(
      identity,
      event.error ? "spawn-error" : "child-close",
      event.code,
    );
    await finalize(quickFailure || Boolean(event.error));
  });

  try {
    logLifecycle(identity, "spawn");
    await transport.start();
    return transport;
  } catch {
    await transport.close();
    await finalize(true);
    throw new InspectorStdioLaunchError(
      "Inspector child failed to start",
      502,
      "spawn_failed",
    );
  }
}

export function getInspectorStdioLaunchDetails(
  transport: ProcessManagedStdioTransport,
) {
  return launchDetails.get(transport);
}

export function createInspectorStdioRouteAdapters(
  launch: InspectorStdioLauncher = launchInspectorStdioTransport,
) {
  return {
    mcp: (input: InspectorStdioLaunchInput) => launch(input),
    sse: (input: InspectorStdioLaunchInput) => launch(input),
    stdio: (input: InspectorStdioLaunchInput) => launch(input),
  };
}

export const inspectorStdioRouteAdapters = createInspectorStdioRouteAdapters();
