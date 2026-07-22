import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { errorMessage } from "../core/errors.js";
import { isJsonValue } from "../core/json.js";
import { DirectProcessRunner } from "../process/runner.js";
import type { ProcessRunner } from "../process/types.js";
import type { ResourceClaim, ResourceMode, ToolContext, ToolInvocation, ToolResult } from "./types.js";

const BACKEND_PROTOCOL_VERSION = 1;
const DEFAULT_BACKEND_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_BACKEND_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const MAX_BACKEND_ERROR_BYTES = 4 * 1024;

export interface ToolBackendRequest {
  invocation: Readonly<ToolInvocation>;
  workspace: string;
}

/**
 * A host-owned boundary for explicitly selected tools. Implementations must
 * fail instead of falling back to local execution when their boundary is not
 * available.
 */
export interface ToolExecutionBackend {
  readonly id: string;
  handles(toolName: string): boolean;
  resources(request: ToolBackendRequest, context: ToolContext): Promise<ResourceClaim[]> | ResourceClaim[];
  execute(request: ToolBackendRequest, context: ToolContext): Promise<ToolResult>;
}

export interface ExternalToolBackendOptions {
  id: string;
  /** Fixed executable plus argv. The executable must be absolute. */
  argv: [string, ...string[]];
  /** Host directory used only to launch the boundary command. */
  cwd: string;
  /** Workspace path visible inside the isolated or remote executor. */
  workspace: string;
  /** Explicit tool authority and scheduler mode. */
  tools: Readonly<Record<string, ResourceMode>>;
  timeoutMs?: number;
  outputLimitBytes?: number;
  runner?: ProcessRunner;
}

interface ExternalResponse {
  schemaVersion: number;
  result: ToolResult;
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function boundedError(value: Buffer): string {
  const text = value.subarray(0, MAX_BACKEND_ERROR_BYTES).toString("utf8").replaceAll("\0", "�").trim();
  return text === "" ? "no diagnostic output" : text;
}

function parseResponse(value: Buffer): ExternalResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString("utf8"));
  } catch {
    throw new Error("External tool backend returned malformed JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("External tool backend returned a non-object response");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "schemaVersion" && key !== "result") ||
    record.schemaVersion !== BACKEND_PROTOCOL_VERSION ||
    record.result === null ||
    typeof record.result !== "object" ||
    Array.isArray(record.result) ||
    !isJsonValue(record.result)
  ) {
    throw new Error("External tool backend returned an invalid protocol response");
  }
  return { schemaVersion: BACKEND_PROTOCOL_VERSION, result: record.result as unknown as ToolResult };
}

/**
 * Executes one bounded JSON request per tool call through a fixed command.
 * No parent environment is inherited, so credentials and ambient tokens do
 * not cross the boundary accidentally.
 */
export class ExternalToolBackend implements ToolExecutionBackend {
  readonly id: string;
  readonly #argv: [string, ...string[]];
  readonly #cwd: string;
  readonly #workspace: string;
  readonly #tools: ReadonlyMap<string, ResourceMode>;
  readonly #timeoutMs: number;
  readonly #outputLimitBytes: number;
  readonly #runner: ProcessRunner;

  static async create(options: ExternalToolBackendOptions): Promise<ExternalToolBackend> {
    const executable = await realpath(options.argv[0]);
    await access(executable, constants.X_OK);
    if (!(await stat(executable)).isFile()) throw new Error("External tool backend executable is not a regular file");
    const cwd = await realpath(options.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error("External tool backend cwd is not a directory");
    return new ExternalToolBackend({
      ...options,
      argv: [executable, ...options.argv.slice(1)],
      cwd,
    });
  }

  constructor(options: ExternalToolBackendOptions) {
    if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(options.id)) throw new Error("External tool backend id is invalid");
    if (!isAbsolute(options.argv[0])) throw new Error("External tool backend executable must be absolute");
    if (options.argv.some((entry) => typeof entry !== "string" || entry.includes("\0"))) {
      throw new Error("External tool backend argv must contain strings without NUL bytes");
    }
    if (!isAbsolute(options.cwd)) throw new Error("External tool backend cwd must be absolute");
    if (typeof options.workspace !== "string" || options.workspace === "" || options.workspace.includes("\0")) {
      throw new Error("External tool backend workspace is invalid");
    }
    const tools = new Map<string, ResourceMode>();
    for (const [name, mode] of Object.entries(options.tools)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/u.test(name)) throw new Error(`External tool backend tool name is invalid: ${name}`);
      if (mode !== "read" && mode !== "write") throw new Error(`External tool backend mode is invalid for ${name}`);
      tools.set(name, mode);
    }
    if (tools.size === 0) throw new Error("External tool backend must claim at least one tool");
    this.id = options.id;
    this.#argv = [...options.argv];
    this.#cwd = options.cwd;
    this.#workspace = options.workspace;
    this.#tools = tools;
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_BACKEND_TIMEOUT_MS, "External tool backend timeoutMs", 60 * 60_000);
    this.#outputLimitBytes = positiveInteger(
      options.outputLimitBytes ?? DEFAULT_BACKEND_OUTPUT_LIMIT_BYTES,
      "External tool backend outputLimitBytes",
      16 * 1024 * 1024,
    );
    this.#runner = options.runner ?? new DirectProcessRunner();
  }

  handles(toolName: string): boolean {
    return this.#tools.has(toolName);
  }

  resources(request: ToolBackendRequest): ResourceClaim[] {
    const mode = this.#tools.get(request.invocation.name);
    if (mode === undefined) throw new Error(`Tool backend ${this.id} does not own ${request.invocation.name}`);
    return [{ kind: "workspace", key: "workspace", mode }];
  }

  async execute(request: ToolBackendRequest, context: ToolContext): Promise<ToolResult> {
    if (!this.handles(request.invocation.name)) {
      throw new Error(`Tool backend ${this.id} does not own ${request.invocation.name}`);
    }
    context.signal.throwIfAborted();
    const input = JSON.stringify({
      schemaVersion: BACKEND_PROTOCOL_VERSION,
      tool: request.invocation.name,
      input: request.invocation.input,
      workspace: this.#workspace,
    });
    let result;
    try {
      result = await this.#runner.run({
        argv: [...this.#argv],
        cwd: this.#cwd,
        inheritEnv: false,
        stdin: input,
        timeoutMs: this.#timeoutMs,
        outputLimitBytes: this.#outputLimitBytes,
      }, context.signal);
    } catch (error) {
      throw new Error(`External tool backend ${this.id} could not start: ${errorMessage(error)}`);
    }
    if (result.cancelled) throw new Error(`External tool backend ${this.id} was cancelled`);
    if (result.timedOut) throw new Error(`External tool backend ${this.id} timed out`);
    if (result.signal !== null) throw new Error(`External tool backend ${this.id} terminated by ${result.signal}`);
    if (result.exitCode !== 0) {
      throw new Error(`External tool backend ${this.id} exited with code ${result.exitCode}: ${boundedError(result.stderr)}`);
    }
    if (result.stdoutBytes > result.stdout.byteLength) {
      throw new Error(`External tool backend ${this.id} response exceeded ${this.#outputLimitBytes} bytes`);
    }
    return parseResponse(result.stdout).result;
  }
}
