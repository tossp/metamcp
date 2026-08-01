import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const INSPECTOR_INHERITED_ENV_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
] as const;

const ENV_PLACEHOLDER_PATTERN = /\$\{[^}]+\}/;

export class InspectorEnvironmentError extends Error {
  constructor(
    message: string,
    readonly reason: "invalid_env" | "nonempty_env" | "placeholder",
  ) {
    super(message);
    this.name = "InspectorEnvironmentError";
  }
}

export interface InspectorEnvironment {
  env: Record<string, string>;
  rootDirectory: string;
  homeDirectory: string;
  tempDirectory: string;
  cleanup: () => Promise<void>;
}

function parseQueryEnvironment(
  rawEnvironment: unknown,
): Record<string, string> {
  if (rawEnvironment === undefined || rawEnvironment === "") {
    return {};
  }

  if (typeof rawEnvironment !== "string") {
    throw new InspectorEnvironmentError(
      "Inspector environment must be a JSON object",
      "invalid_env",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEnvironment);
  } catch {
    throw new InspectorEnvironmentError(
      "Inspector environment must be valid JSON",
      "invalid_env",
    );
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new InspectorEnvironmentError(
      "Inspector environment must be a JSON object",
      "invalid_env",
    );
  }

  const entries = Object.entries(parsed);
  for (const [key, value] of entries) {
    if (ENV_PLACEHOLDER_PATTERN.test(key)) {
      throw new InspectorEnvironmentError(
        "Host environment placeholders are not allowed for Inspector children",
        "placeholder",
      );
    }
    if (typeof value !== "string") {
      throw new InspectorEnvironmentError(
        "Inspector environment values must be strings",
        "invalid_env",
      );
    }
    if (ENV_PLACEHOLDER_PATTERN.test(value)) {
      throw new InspectorEnvironmentError(
        "Host environment placeholders are not allowed for Inspector children",
        "placeholder",
      );
    }
  }

  if (entries.length > 0) {
    throw new InspectorEnvironmentError(
      "Inspector request environment is not allowed",
      "nonempty_env",
    );
  }

  return parsed as Record<string, string>;
}

export async function createInspectorEnvironment(
  rawEnvironment: unknown,
  hostEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<InspectorEnvironment> {
  parseQueryEnvironment(rawEnvironment);

  const rootDirectory = await mkdtemp(join(tmpdir(), "metamcp-inspector-"));
  const homeDirectory = join(rootDirectory, "home");
  const tempDirectory = join(rootDirectory, "tmp");

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    await rm(rootDirectory, { force: true, recursive: true });
  };

  try {
    await mkdir(homeDirectory, { mode: 0o700 });
    await mkdir(tempDirectory, { mode: 0o700 });

    const env: Record<string, string> = {};
    for (const key of INSPECTOR_INHERITED_ENV_KEYS) {
      const value = hostEnvironment[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }
    env.HOME = homeDirectory;
    env.TMPDIR = tempDirectory;

    return {
      env,
      rootDirectory,
      homeDirectory,
      tempDirectory,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
