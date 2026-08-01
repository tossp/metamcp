import { ChildProcess, IOType } from "node:child_process";
import process from "node:process";
import { PassThrough, Stream } from "node:stream";

import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import spawn from "cross-spawn";

import logger from "@/utils/logger";

import { ReadBuffer, serializeMessage } from "./shared";

export type StdioServerParameters = {
  /**
   * The executable to run to start the server.
   */
  command: string;

  /**
   * Command line arguments to pass to the executable.
   */
  args?: string[];

  /**
   * The environment to use when spawning the process.
   *
   * If not specified, the result of getDefaultEnvironment() will be used.
   */
  env?: Record<string, string>;

  /**
   * `merge-default` preserves the historical MetaMCP behavior. `exact` passes
   * only `env`, without adding any inherited variables.
   */
  envMode?: "merge-default" | "exact";

  /**
   * How to handle stderr of the child process. This matches the semantics of Node's `child_process.spawn`.
   *
   * The default is "inherit", meaning messages to stderr will be printed to the parent process's stderr.
   */
  stderr?: IOType | Stream | number;

  /**
   * The working directory to use when spawning the process.
   *
   * If not specified, the current working directory will be inherited.
   */
  cwd?: string;

  /** Disable generic process logs when the caller supplies redacted logs. */
  lifecycleLogging?: boolean;

  /** Grace period before close escalates from SIGTERM to SIGKILL. */
  terminationGracePeriodMs?: number;
};

export interface StdioProcessLifecycleEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  closeRequested: boolean;
}

/**
 * Environment variables to inherit by default, if an environment is not explicitly given.
 */
export const DEFAULT_INHERITED_ENV_VARS =
  process.platform === "win32"
    ? [
        "APPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PROCESSOR_ARCHITECTURE",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "USERNAME",
        "USERPROFILE",
        "PROGRAMFILES",
      ]
    : /* list inspired by the default env inheritance of sudo */
      [
        "HOME",
        "LOGNAME",
        "PATH",
        "SHELL",
        "TERM",
        "USER",
        // SSL/Certificate variables for corporate proxies and custom CA certificates
        "NODE_EXTRA_CA_CERTS",
        "NODE_TLS_REJECT_UNAUTHORIZED",
        "SSL_CERT_FILE",
        "CERT_FILE",
        "REQUESTS_CA_BUNDLE",
        "REQUESTS_CERT_FILE",
        "CURL_CA_BUNDLE",
        "PIP_CERT",
        "UV_CERT",
        "PYTHONHTTPSVERIFY",
        // Proxy variables
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
      ];

/**
 * Returns a default environment object including only environment variables deemed safe to inherit.
 */
export function getDefaultEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    const value = process.env[key];
    if (value === undefined) {
      continue;
    }

    if (value.startsWith("()")) {
      // Skip functions, which are a security risk.
      continue;
    }

    env[key] = value;
  }

  return env;
}

/**
 * Client transport for stdio: this will connect to a server by spawning a process and communicating with it over stdin/stdout.
 *
 * This transport is only available in Node.js environments.
 */
export class ProcessManagedStdioTransport implements Transport {
  private _process?: ChildProcess;
  private _readBuffer: ReadBuffer = new ReadBuffer();
  private _serverParams: StdioServerParameters;
  private _stderrStream: PassThrough | null = null;
  private _isCleanup: boolean = false;
  private _startAttempted: boolean = false;
  private _spawnError?: Error;
  private _nativeClosePromise?: Promise<void>;
  private _resolveNativeClose?: () => void;
  private _lifecyclePromise?: Promise<void>;
  private _resolveLifecycle?: () => void;
  private _closePromise?: Promise<void>;
  private _internalLifecycleListeners = new Set<
    (event: StdioProcessLifecycleEvent) => void | Promise<void>
  >();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  onprocesscrash?: (exitCode: number | null, signal: string | null) => void;

  constructor(server: StdioServerParameters) {
    this._serverParams = server;
    this.resetClosePromises();
    if (server.stderr === "pipe" || server.stderr === "overlapped") {
      this._stderrStream = new PassThrough();
    }
  }

  private resetClosePromises() {
    this._nativeClosePromise = new Promise((resolve) => {
      this._resolveNativeClose = resolve;
    });
    this._lifecyclePromise = new Promise((resolve) => {
      this._resolveLifecycle = resolve;
    });
  }

  addInternalLifecycleListener(
    listener: (event: StdioProcessLifecycleEvent) => void | Promise<void>,
  ): () => void {
    this._internalLifecycleListeners.add(listener);
    return () => this._internalLifecycleListeners.delete(listener);
  }

  /**
   * Starts the server process and prepares to communicate with it.
   */
  async start(): Promise<void> {
    if (this._process) {
      throw new Error(
        "StdioClientTransport already started! If using Client class, note that connect() calls start() automatically.",
      );
    }
    this._startAttempted = true;

    return new Promise((resolve, reject) => {
      const env =
        this._serverParams.envMode === "exact"
          ? { ...(this._serverParams.env ?? {}) }
          : {
              // Preserve the existing default behavior for normal MetaMCP servers.
              ...getDefaultEnvironment(),
              ...this._serverParams.env,
            };

      this._process = spawn(
        this._serverParams.command,
        this._serverParams.args ?? [],
        {
          env,
          stdio: ["pipe", "pipe", this._serverParams.stderr ?? "inherit"],
          shell: false,
          windowsHide: process.platform === "win32" && isElectron(),
          cwd: this._serverParams.cwd,
          detached: true,
        },
      );

      // Unref the child process so it doesn't keep the parent alive
      this._process.unref();

      this._process.on("error", (error) => {
        this._spawnError = error;
        if (error.name === "AbortError") {
          return;
        }

        reject(error);
        this.onerror?.(error);
      });

      this._process.on("spawn", () => {
        if (this._serverParams.lifecycleLogging !== false) {
          logger.info(`[transport.start] spawned PID ${this._process?.pid}`);
        }
        resolve();
      });

      this._process.on("close", (code, signal) => {
        const lifecycleEvent: StdioProcessLifecycleEvent = {
          closeRequested: this._isCleanup,
          code,
          error: this._spawnError,
          signal: signal as NodeJS.Signals | null,
        };
        this._resolveNativeClose?.();

        // Only emit crash event if this wasn't a clean shutdown
        if (!this._isCleanup && (code !== 0 || signal)) {
          if (this._serverParams.lifecycleLogging !== false) {
            logger.warn(
              `Process crashed with code: ${code}, signal: ${signal}`,
            );
          }
          try {
            this.onprocesscrash?.(code, signal);
          } catch (error) {
            if (this._serverParams.lifecycleLogging !== false) {
              logger.error("Process crash handler failed:", error);
            }
          }
        }

        this._process = undefined;
        void Promise.allSettled(
          [...this._internalLifecycleListeners].map(async (listener) => {
            await listener(lifecycleEvent);
          }),
        ).then(() => {
          try {
            this.onclose?.();
          } finally {
            this._resolveLifecycle?.();
          }
        });
      });

      this._process.stdin?.on("error", (error) => {
        this.onerror?.(error);
      });

      this._process.stdout?.on("data", (chunk) => {
        this._readBuffer.append(chunk);
        this.processReadBuffer();
      });

      this._process.stdout?.on("error", (error) => {
        this.onerror?.(error);
      });

      if (this._stderrStream && this._process.stderr) {
        this._process.stderr.pipe(this._stderrStream);
      }
    });
  }

  /**
   * The stderr stream of the child process, if `StdioServerParameters.stderr` was set to "pipe" or "overlapped".
   *
   * If stderr piping was requested, a PassThrough stream is returned _immediately_, allowing callers to
   * attach listeners before the start method is invoked. This prevents loss of any early
   * error output emitted by the child process.
   */
  get stderr(): Stream | null {
    if (this._stderrStream) {
      return this._stderrStream;
    }

    return this._process?.stderr ?? null;
  }

  /**
   * The child process pid spawned by this transport.
   *
   * This is only available after the transport has been started.
   */
  get pid(): number | null {
    return this._process?.pid ?? null;
  }

  /** Wait until the child has emitted close and internal lifecycle hooks finish. */
  async waitForClose(): Promise<void> {
    await this._lifecyclePromise;
  }

  private processReadBuffer() {
    while (true) {
      try {
        const message = this._readBuffer.readMessage();
        if (message === null) {
          break;
        }

        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error as Error);
      }
    }
  }

  close(): Promise<void> {
    this._closePromise ??= this.performClose();
    return this._closePromise;
  }

  private async performClose(): Promise<void> {
    this._isCleanup = true;

    const proc = this._process;
    const pid = proc?.pid ?? null;

    if (pid && proc) {
      // Register the "close" listener BEFORE sending any signal so a fast-exiting
      // child cannot emit "close" in between and cause the promise to time out.
      this.signalProcess(proc, pid, "SIGTERM");

      // Wait up to 5 seconds for graceful shutdown, then escalate to SIGKILL
      let timeout: NodeJS.Timeout | undefined;
      const exited = await Promise.race([
        this._nativeClosePromise?.then(() => true) ?? Promise.resolve(true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(
            () => resolve(false),
            this._serverParams.terminationGracePeriodMs ?? 5000,
          );
        }),
      ]);
      if (timeout) {
        clearTimeout(timeout);
      }

      if (!exited) {
        this.signalProcess(proc, pid, "SIGKILL");
      }

      // SIGKILL is not considered complete until Node reports child close/reap.
      await this._nativeClosePromise;
    } else if (proc) {
      // Spawn errors such as ENOENT have no PID, but still emit close after error.
      await this._nativeClosePromise;
    } else if (!this._startAttempted) {
      this._resolveNativeClose?.();
      this._resolveLifecycle?.();
    }

    await this._lifecyclePromise;
    this._readBuffer.clear();
  }

  private signalProcess(
    proc: ChildProcess,
    pid: number,
    signal: NodeJS.Signals,
  ) {
    try {
      if (process.platform === "win32") {
        proc.kill(signal);
      } else {
        process.kill(-pid, signal);
      }
      if (this._serverParams.lifecycleLogging !== false) {
        logger.info(`[transport.close] ${signal} sent to process ${pid}`);
      }
    } catch (error) {
      if (this._serverParams.lifecycleLogging !== false) {
        logger.warn(
          `[transport.close] ${signal} failed for process ${pid}:`,
          error,
        );
      }
    }
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve) => {
      if (!this._process?.stdin) {
        throw new Error("Not connected");
      }

      const json = serializeMessage(message);
      if (this._process.stdin.write(json)) {
        resolve();
      } else {
        this._process.stdin.once("drain", resolve);
      }
    });
  }
}

function isElectron() {
  return "type" in process;
}
