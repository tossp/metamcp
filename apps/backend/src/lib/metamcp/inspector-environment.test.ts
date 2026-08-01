import { access, stat } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  createInspectorEnvironment,
  INSPECTOR_INHERITED_ENV_KEYS,
  InspectorEnvironmentError,
} from "./inspector-environment";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("createInspectorEnvironment", () => {
  it("inherits only the fixed allowlist and creates owner-only HOME/TMPDIR", async () => {
    const environment = await createInspectorEnvironment("{}", {
      AWS_SECRET_ACCESS_KEY: "canary-cloud-secret",
      HOME: "/host/home",
      HTTPS_PROXY: "http://proxy.invalid",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      NODE_EXTRA_CA_CERTS: "/host/ca.pem",
      NODE_OPTIONS: "--require canary",
      PATH: "/safe/server/path",
      SECRET_CANARY: "must-not-be-visible",
      TZ: "UTC",
    });
    cleanups.push(environment.cleanup);

    expect(INSPECTOR_INHERITED_ENV_KEYS).toEqual([
      "PATH",
      "LANG",
      "LC_ALL",
      "TZ",
    ]);
    expect(environment.env).toEqual({
      HOME: environment.homeDirectory,
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/safe/server/path",
      TMPDIR: environment.tempDirectory,
      TZ: "UTC",
    });
    expect(environment.env).not.toHaveProperty("HTTPS_PROXY");
    expect(environment.env).not.toHaveProperty("NODE_EXTRA_CA_CERTS");
    expect(environment.env).not.toHaveProperty("SECRET_CANARY");
    expect(environment.env.HOME).not.toBe("/host/home");
    expect((await stat(environment.rootDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(environment.homeDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(environment.tempDirectory)).mode & 0o777).toBe(0o700);

    await environment.cleanup();
    await expect(access(environment.rootDirectory)).rejects.toThrow();
  });

  it.each([
    ['{"PATH":"/request/path"}', "nonempty_env"],
    ['{"SECRET":"${CANARY}"}', "placeholder"],
  ] as const)(
    "rejects request env %s before creating a child",
    async (raw, reason) => {
      await expect(createInspectorEnvironment(raw, {})).rejects.toMatchObject({
        reason,
      } satisfies Partial<InspectorEnvironmentError>);
    },
  );

  it("allows a missing environment and omits absent inherited keys", async () => {
    const environment = await createInspectorEnvironment(undefined, {});
    cleanups.push(environment.cleanup);
    expect(environment.env).toEqual({
      HOME: environment.homeDirectory,
      TMPDIR: environment.tempDirectory,
    });
  });
});
