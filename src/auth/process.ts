import { spawn } from "node:child_process";

import { trackActiveProcessGroup } from "../process/active-groups.js";
import { defaultSecretRedactor, type SecretRedactor } from "./redaction.js";

export interface SafeProcessOptions {
  command: string;
  args?: readonly string[];
  input?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  redactor?: SecretRedactor;
}

export interface SafeProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class SafeProcessError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SafeProcessError";
  }
}

function validatePart(value: string, label: string): void {
  if (value.length === 0) throw new TypeError(`${label} must not be empty`);
  if (value.includes("\0")) throw new TypeError(`${label} must not contain NUL bytes`);
}

export async function runSafeProcess(options: SafeProcessOptions): Promise<SafeProcessResult> {
  validatePart(options.command, "Command");
  for (const argument of options.args ?? []) validatePart(argument, "Argument");
  options.signal?.throwIfAborted();

  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new TypeError("maxOutputBytes must be a positive integer");
  }

  const redactor = options.redactor ?? defaultSecretRedactor;
  const child = spawn(options.command, [...(options.args ?? [])], {
    cwd: undefined,
    env: options.environment ?? minimalProcessEnvironment(),
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const releaseProcessGroup = trackActiveProcessGroup(child.pid);

  return new Promise<SafeProcessResult>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let pendingError: Error | undefined;
    let escalation: NodeJS.Timeout | undefined;

    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      releaseProcessGroup();
      clearTimeout(timeout);
      if (escalation !== undefined) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", abort);
      operation();
    };
    const signalProcess = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const stopWithError = (error: Error): void => {
      if (settled || pendingError !== undefined) return;
      pendingError = error;
      try {
        signalProcess("SIGTERM");
      } catch (cause) {
        finish(() => reject(new SafeProcessError(error.message, { cause })));
        return;
      }
      escalation = setTimeout(() => {
        try {
          signalProcess("SIGKILL");
        } catch {
          // The original bounded-process error remains authoritative.
        }
      }, 1_000);
      escalation.unref();
    };
    const addOutput = (target: Buffer[], chunk: Buffer): void => {
      if (settled || pendingError !== undefined) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        stopWithError(new SafeProcessError("External command output exceeded configured limit"));
        return;
      }
      target.push(chunk);
    };
    const abort = (): void => {
      stopWithError(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Aborted"));
    };
    const timeout = setTimeout(() => {
      stopWithError(new SafeProcessError("External command timed out"));
    }, timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => addOutput(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => addOutput(stderr, chunk));
    child.once("error", (error) => {
      finish(() =>
        reject(
          new SafeProcessError(redactor.redact(`Unable to start external command: ${error.message}`), {
            cause: error,
          }),
        ),
      );
    });
    child.once("close", (code, signal) => {
      finish(() => {
        if (pendingError !== undefined) {
          reject(pendingError);
          return;
        }
        if (code === null) {
          reject(new SafeProcessError(`External command terminated by signal ${signal ?? "unknown"}`));
          return;
        }
        resolve({
          exitCode: code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: redactor.redact(Buffer.concat(stderr).toString("utf8")),
        });
      });
    });

    child.stdin.on("error", () => undefined);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted === true) {
      abort();
      return;
    }
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input, "utf8");
  });
}

export function minimalProcessEnvironment(
  additions: Readonly<Record<string, string>> = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "WINDIR",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
  ]) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(additions)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`Invalid environment name: ${name}`);
    if (
      new Set([
        "NODE_OPTIONS",
        "NODE_PATH",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "DYLD_INSERT_LIBRARIES",
        "DYLD_LIBRARY_PATH",
      ]).has(name)
    ) {
      throw new TypeError(`Unsafe external command environment name: ${name}`);
    }
    environment[name] = value;
  }
  return environment;
}
