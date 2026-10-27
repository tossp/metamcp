import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import logger from "@/utils/logger";

import { ProcessManagedStdioTransport } from "../stdio-transport/process-managed-transport";
import { createInspectorSavedEnvironment } from "./inspector-environment";
import {
  getInspectorStdioLaunchDetails,
  launchInspectorSavedStdioTransport,
} from "./inspector-stdio-launch";

const cleanups: Array<() => Promise<void>> = [];
const transports: ProcessManagedStdioTransport[] = [];

afterEach(async () => {
  await Promise.allSettled(
    transports.splice(0).map((transport) => transport.close()),
  );
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("saved Inspector environment", () => {
  it("merges explicit saved literals without inheriting host secrets", async () => {
    const environment = await createInspectorSavedEnvironment(
      { DAV_PASSWORD: "virtual-secret", PATH: "/saved/path" },
      {
        PATH: "/host/path",
        LANG: "C",
        DATABASE_URL: "host-secret",
        HTTPS_PROXY: "host-proxy",
        HOME: "/host/home",
      },
    );
    cleanups.push(environment.cleanup);
    expect(environment.env).toEqual({
      DAV_PASSWORD: "virtual-secret",
      PATH: "/saved/path",
      LANG: "C",
      HOME: environment.homeDirectory,
      TMPDIR: environment.tempDirectory,
    });
    await environment.cleanup();
    await expect(access(environment.rootDirectory)).rejects.toThrow();
  });

  it.each<Record<string, string>>([
    { VALUE: "${HOST_SECRET}" },
    { "${HOST_SECRET}": "value" },
    { VALUE: "prefix-${HOST_SECRET}-suffix" },
    { HOME: "/saved/home" },
    { TMPDIR: "/saved/tmp" },
    { "BAD=KEY": "value" },
    { VALUE: "bad\0value" },
    { "BAD\0KEY": "value" },
    { "": "value" },
  ])("rejects unsafe saved environment entries", async (environment) => {
    await expect(
      createInspectorSavedEnvironment(environment),
    ).rejects.toThrow();
  });

  it("treats prototype-named keys as literal own entries", async () => {
    const environment = await createInspectorSavedEnvironment(
      JSON.parse('{"__proto__":"literal","constructor":"literal"}') as Record<
        string,
        string
      >,
      {},
    );
    cleanups.push(environment.cleanup);
    expect(Object.getPrototypeOf(environment.env)).toBe(Object.prototype);
    expect(Object.hasOwn(environment.env, "__proto__")).toBe(true);
    expect(environment.env.__proto__).toBe("literal");
  });

  it("passes saved argv literally to a real child and reaps it without logging secrets", async () => {
    vi.stubEnv("METAMCP_HOST_SECRET_CANARY", "host-secret-canary");
    vi.stubEnv("DAV_PASSWORD", "wrong-host-password");
    const literalArguments = [
      "two words",
      "quote'and\"double",
      "${HOST_SECRET}",
      "semi;colon",
      "",
    ];
    const script =
      'require("node:fs").writeFileSync(process.env.HOME+"/probe.json",JSON.stringify({password:process.env.DAV_PASSWORD,hostSecret:process.env.METAMCP_HOST_SECRET_CANARY,args:process.argv.slice(1)}));setInterval(()=>{},1000)';
    const transport = await launchInspectorSavedStdioTransport(
      {
        configId: randomUUID(),
        command: process.execPath,
        args: ["-e", script, ...literalArguments],
        env: { DAV_PASSWORD: "virtual-saved-secret" },
      },
      "owner",
    );
    transports.push(transport);
    const details = getInspectorStdioLaunchDetails(transport);
    if (!details) throw new Error("Missing launch details");
    let probe: string | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        probe = await readFile(`${details.homeDirectory}/probe.json`, "utf8");
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (!probe) throw new Error("Child environment probe did not complete");
    expect(JSON.parse(probe)).toEqual({
      password: "virtual-saved-secret",
      args: literalArguments,
    });
    await transport.close();
    await expect(access(details.rootDirectory)).rejects.toThrow();
    const logs = JSON.stringify([
      vi.mocked(logger.info).mock.calls,
      vi.mocked(logger.error).mock.calls,
    ]);
    for (const secret of [
      "virtual-saved-secret",
      "host-secret-canary",
      script,
    ]) {
      expect(logs).not.toContain(secret);
    }
  });

  it("removes saved environment directories on spawn failure and preserves cooldown", async () => {
    const configuration = {
      configId: randomUUID(),
      command: `/missing-inspector-${randomUUID()}`,
      args: [],
      env: { DAV_PASSWORD: "virtual-secret" },
    };
    await expect(
      launchInspectorSavedStdioTransport(configuration, "owner"),
    ).rejects.toMatchObject({ reason: "spawn_failed", statusCode: 502 });
    await expect(
      launchInspectorSavedStdioTransport(configuration, "owner"),
    ).rejects.toMatchObject({ reason: "cooldown", statusCode: 429 });
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(
      "virtual-secret",
    );
  });
});
