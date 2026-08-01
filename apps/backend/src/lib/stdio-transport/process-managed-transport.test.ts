/* eslint-disable turbo/no-undeclared-env-vars */
import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  ProcessManagedStdioTransport,
  StdioProcessLifecycleEvent,
} from "./process-managed-transport";

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
});

function nodeTransport(
  script: string,
  options: ConstructorParameters<typeof ProcessManagedStdioTransport>[0] = {
    command: process.execPath,
  },
) {
  const transport = new ProcessManagedStdioTransport({
    ...options,
    args: ["-e", script],
    command: process.execPath,
    lifecycleLogging: false,
  });
  transports.push(transport);
  return transport;
}

function nextMessage(transport: ProcessManagedStdioTransport) {
  return new Promise<Record<string, unknown>>((resolve) => {
    transport.onmessage = (message) =>
      resolve(message as Record<string, unknown>);
  });
}

describe("ProcessManagedStdioTransport environment modes", () => {
  it("keeps merge-default as the default behavior", async () => {
    process.env.METAMCP_TRANSPORT_CANARY = "inherited-by-explicit-env";
    process.env.HOME = "/host-default-home";
    const transport = nodeTransport(
      'console.log(JSON.stringify({jsonrpc:"2.0",method:"probe",params:{home:process.env.HOME,value:process.env.METAMCP_TRANSPORT_CANARY}}));setInterval(()=>{},1000)',
      {
        command: process.execPath,
        env: { METAMCP_TRANSPORT_CANARY: "explicit" },
      },
    );
    const message = nextMessage(transport);
    await transport.start();
    await expect(message).resolves.toMatchObject({
      params: { home: "/host-default-home", value: "explicit" },
    });
  });

  it("passes only the supplied environment in exact mode", async () => {
    process.env.METAMCP_TRANSPORT_CANARY = "host-secret";
    const transport = nodeTransport(
      'console.log(JSON.stringify({jsonrpc:"2.0",method:"probe",params:{canary:process.env.METAMCP_TRANSPORT_CANARY,path:process.env.PATH}}));setInterval(()=>{},1000)',
      {
        command: process.execPath,
        env: { PATH: "/inspector/path" },
        envMode: "exact",
      },
    );
    const message = nextMessage(transport);
    await transport.start();
    await expect(message).resolves.toMatchObject({
      params: { path: "/inspector/path" },
    });
    expect((await message).params).not.toHaveProperty("canary");
  });

  it("waits for SIGKILL close/reap when a child ignores SIGTERM", async () => {
    const events: StdioProcessLifecycleEvent[] = [];
    const transport = nodeTransport(
      'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
      {
        command: process.execPath,
        envMode: "exact",
        terminationGracePeriodMs: 50,
      },
    );
    transport.addInternalLifecycleListener((event) => {
      events.push(event);
    });
    await transport.start();
    const pid = transport.pid;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await transport.close();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      closeRequested: true,
      signal: "SIGKILL",
    });
    expect(pid).not.toBeNull();
    expect(() => process.kill(pid as number, 0)).toThrow();
  });

  it("reports and reaps a nonexistent executable", async () => {
    const transport = new ProcessManagedStdioTransport({
      command: `/definitely-missing-metamcp-${Date.now()}`,
      env: {},
      envMode: "exact",
      lifecycleLogging: false,
    });
    transports.push(transport);
    const events: StdioProcessLifecycleEvent[] = [];
    transport.addInternalLifecycleListener((event) => {
      events.push(event);
    });

    await expect(transport.start()).rejects.toThrow();
    await transport.close();
    expect(events).toHaveLength(1);
    expect(events[0]?.error).toBeInstanceOf(Error);
  });
});
