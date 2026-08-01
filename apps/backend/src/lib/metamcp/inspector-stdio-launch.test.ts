/* eslint-disable turbo/no-undeclared-env-vars */
import { randomUUID } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { ProcessManagedStdioTransport } from "../stdio-transport/process-managed-transport";
import {
  createInspectorStdioRouteAdapters,
  getInspectorStdioLaunchDetails,
  InspectorStdioCooldownRegistry,
  launchInspectorStdioTransport,
  MAX_STDIO_COOLDOWN_ENTRIES,
} from "./inspector-stdio-launch";

const transports: ProcessManagedStdioTransport[] = [];
const savedEnvironment = { ...process.env };

afterEach(async () => {
  await Promise.allSettled(
    transports.splice(0).map((transport) => transport.close()),
  );
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, savedEnvironment);
  vi.restoreAllMocks();
});

function queryForScript(script: string, configId = randomUUID()) {
  return {
    args: `-e ${JSON.stringify(script)}`,
    command: process.execPath,
    configId,
    env: "{}",
  };
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

describe("launchInspectorStdioTransport", () => {
  it("spawns with restricted env and removes isolated HOME/TMPDIR on close", async () => {
    process.env.PATH = savedEnvironment.PATH;
    process.env.LANG = "inspector-lang";
    process.env.LC_ALL = "inspector-lc";
    process.env.TZ = "inspector-tz";
    process.env.HOME = "/host/home-canary";
    process.env.HTTPS_PROXY = "http://proxy-canary";
    process.env.NODE_EXTRA_CA_CERTS = "/host/ca-canary";
    process.env.AWS_SECRET_ACCESS_KEY = "cloud-canary";
    process.env.METAMCP_SECRET_CANARY = "host-secret";

    const script =
      'require("node:fs").writeFileSync(process.env.HOME+"/probe.json",JSON.stringify(process.env));setInterval(()=>{},1000)';
    const transport = await launchInspectorStdioTransport({
      actorId: "actor-a",
      query: queryForScript(script),
    });
    transports.push(transport);
    const details = getInspectorStdioLaunchDetails(transport);
    expect(details).toBeDefined();

    const childEnvironment = JSON.parse(
      await waitForFile(`${details?.homeDirectory}/probe.json`),
    ) as Record<string, string>;
    expect(childEnvironment).toEqual({
      HOME: details?.homeDirectory,
      LANG: "inspector-lang",
      LC_ALL: "inspector-lc",
      PATH: savedEnvironment.PATH,
      TMPDIR: details?.tempDirectory,
      TZ: "inspector-tz",
    });

    const publicCloseHook = vi.fn();
    transport.onclose = publicCloseHook;
    await transport.close();
    expect(publicCloseHook).toHaveBeenCalledOnce();
    await expect(access(details?.rootDirectory ?? "")).rejects.toThrow();
  });

  it.each([
    ['{"PATH":"/request/path"}', "restricted_environment"],
    ['{"VALUE":"${CANARY}"}', "restricted_environment"],
  ])("rejects request environment %s before spawn", async (env, reason) => {
    await expect(
      launchInspectorStdioTransport({
        query: { ...queryForScript("setInterval(()=>{},1000)"), env },
      }),
    ).rejects.toMatchObject({ reason });
  });

  it("cleans a quick abnormal exit and applies cooldown without env in the key", async () => {
    const query = queryForScript("process.exit(7)");
    const transport = await launchInspectorStdioTransport({ query });
    transports.push(transport);
    const details = getInspectorStdioLaunchDetails(transport);
    await transport.waitForClose();
    await expect(access(details?.rootDirectory ?? "")).rejects.toThrow();

    await expect(
      launchInspectorStdioTransport({ query }),
    ).rejects.toMatchObject({
      reason: "cooldown",
      statusCode: 429,
    });
  });

  it("reaps SIGKILL and removes directories after a child ignores SIGTERM", async () => {
    const transport = await launchInspectorStdioTransport({
      query: queryForScript(
        'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
      ),
      terminationGracePeriodMs: 50,
    });
    transports.push(transport);
    const details = getInspectorStdioLaunchDetails(transport);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await transport.close();
    await expect(access(details?.rootDirectory ?? "")).rejects.toThrow();
  });

  it("deduplicates concurrent close calls and finalizes the directory once", async () => {
    const transport = await launchInspectorStdioTransport({
      query: queryForScript("setInterval(()=>{},1000)"),
    });
    transports.push(transport);
    const details = getInspectorStdioLaunchDetails(transport);
    const lifecycleEvents = vi.fn();
    transport.addInternalLifecycleListener(lifecycleEvents);
    const killSpy = vi.spyOn(process, "kill");

    await Promise.all([
      transport.close(),
      transport.close(),
      transport.close(),
    ]);

    const terminationCalls = killSpy.mock.calls.filter(
      ([, signal]) => signal === "SIGTERM" || signal === "SIGKILL",
    );
    expect(terminationCalls).toHaveLength(1);
    expect(lifecycleEvents).toHaveBeenCalledOnce();
    await expect(access(details?.rootDirectory ?? "")).rejects.toThrow();
  });

  it("returns spawn failure then cooldown for a nonexistent executable", async () => {
    const rootsBefore = new Set(
      (await readdir(tmpdir())).filter((name) =>
        name.startsWith("metamcp-inspector-"),
      ),
    );
    const query = {
      args: "",
      command: `/definitely-missing-inspector-${Date.now()}`,
      configId: randomUUID(),
      env: "{}",
    };
    await expect(
      launchInspectorStdioTransport({ query }),
    ).rejects.toMatchObject({
      reason: "spawn_failed",
    });
    const rootsAfter = (await readdir(tmpdir())).filter(
      (name) => name.startsWith("metamcp-inspector-") && !rootsBefore.has(name),
    );
    expect(rootsAfter).toEqual([]);
    await expect(
      launchInspectorStdioTransport({ query }),
    ).rejects.toMatchObject({
      reason: "cooldown",
    });
  });
});

describe("InspectorStdioCooldownRegistry", () => {
  it("sweeps expired entries when a different key is read", () => {
    const cooldowns = new InspectorStdioCooldownRegistry(4);
    cooldowns.set("config-a:fingerprint-a", 100, 0);

    expect(cooldowns.get("config-b:fingerprint-b", 101)).toBeUndefined();
    expect(cooldowns.getSize(101)).toBe(0);
  });

  it("keeps size bounded and evicts oldest entries before inserting", () => {
    const cooldowns = new InspectorStdioCooldownRegistry();
    const expiresAt = 10_000;
    for (let index = 0; index < MAX_STDIO_COOLDOWN_ENTRIES + 500; index += 1) {
      cooldowns.set(`config-${index}:fingerprint-${index}`, expiresAt, 0);
      expect(cooldowns.getSize(0)).toBeLessThanOrEqual(
        MAX_STDIO_COOLDOWN_ENTRIES,
      );
    }

    expect(cooldowns.getSize(0)).toBe(MAX_STDIO_COOLDOWN_ENTRIES);
    expect(cooldowns.get("config-0:fingerprint-0", 0)).toBeUndefined();
    expect(
      cooldowns.get(
        `config-${MAX_STDIO_COOLDOWN_ENTRIES + 499}:fingerprint-${MAX_STDIO_COOLDOWN_ENTRIES + 499}`,
        0,
      ),
    ).toBe(expiresAt);
  });

  it("preserves an active cooldown until its expiry", () => {
    const cooldowns = new InspectorStdioCooldownRegistry(2);
    cooldowns.set("active", 110, 100);

    expect(cooldowns.get("active", 109)).toBe(110);
    expect(cooldowns.get("active", 110)).toBeUndefined();
  });
});

describe("Inspector STDIO route adapters", () => {
  it("routes /stdio, /mcp STDIO, and /sse STDIO through one launch function", async () => {
    const transport = {} as ProcessManagedStdioTransport;
    const launch = vi.fn().mockResolvedValue(transport);
    const adapters = createInspectorStdioRouteAdapters(launch);
    const input = { query: queryForScript("process.exit(0)") };

    await expect(adapters.stdio(input)).resolves.toBe(transport);
    await expect(adapters.mcp(input)).resolves.toBe(transport);
    await expect(adapters.sse(input)).resolves.toBe(transport);
    expect(launch).toHaveBeenCalledTimes(3);
    expect(launch).toHaveBeenNthCalledWith(1, input);
    expect(launch).toHaveBeenNthCalledWith(2, input);
    expect(launch).toHaveBeenNthCalledWith(3, input);
  });
});
