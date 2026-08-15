import type { JsonValue } from "../../core/json.js";
import { commandShellInvocation } from "../../process/command-shell.js";
import { DirectProcessRunner } from "../../process/runner.js";
import { scrubShellEnvironment } from "../../process/shell-environment.js";
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "../../extensions/direct.js";
import { createHarnessToolDefinition, wrapToolDefinition, type AgentTool } from "../direct-tool.js";
import { inputObject, numberInput, stringInput } from "../input.js";
import { ToolOutputAccumulator } from "../output-accumulator.js";
import { CoalescedOutputProgress } from "../progress.js";
import { assertSchema } from "../schema.js";
import { formatBytes, TOOL_MAX_BYTES, TOOL_MAX_LINES, type ToolTruncation } from "../truncate.js";
import type { HarnessTool, ResourceClaim, ToolContext, ToolResult } from "../types.js";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1_000;

const commandParameter = Type.String({ description: "Shell command to run." });
const bashParameters = Type.Object({
  command: commandParameter,
  timeout: Type.Optional(Type.Number({
    description: "Optional time limit in seconds. Omit it to allow an unbounded run.",
  })),
});

export type BashToolInput = Static<typeof bashParameters>;

export interface BashToolDetails {
  truncation?: ToolTruncation;
  fullOutputPath?: string;
}

export interface BashOperations {
  exec(
    command: string,
    cwd: string,
    options: {
      onData(data: Buffer): void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<{
    exitCode: number | null;
    signal?: NodeJS.Signals | null;
    timedOut?: boolean;
    cancelled?: boolean;
    durationMs?: number;
    stdoutBytes?: number;
    stderrBytes?: number;
  }>;
}

export interface BashSpawnContext {
  env: NodeJS.ProcessEnv;
  cwd: string;
  command: string;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

export interface BashToolOptions {
  commandPrefix?: string;
  operations?: BashOperations;
  shellPath?: string;
  spawnHook?: BashSpawnHook;
  /** Add current-session metadata to the command environment unless disabled. */
  exposeSessionEnvironment?: boolean;
  /** @deprecated Use `exposeSessionEnvironment`. */
  sessionEnvironment?: boolean;
}

const schema: Record<string, JsonValue> = {
  type: "object",
  required: ["command"],
  properties: {
    command: { type: "string", description: "Shell command to run." },
    timeout: {
      type: "number",
      description: "Optional time limit in seconds. Omit it to allow an unbounded run.",
    },
  },
};

const SESSION_ENVIRONMENT_NAMES = [
  "RIGYN_SESSION_ID",
  "RIGYN_SESSION_FILE",
  "RIGYN_PROVIDER",
  "RIGYN_MODEL",
  "RIGYN_REASONING_LEVEL",
] as const;

function bashEnvironment(context: ToolContext, enabled: boolean): NodeJS.ProcessEnv {
  const environment = scrubShellEnvironment(process.env);
  for (const name of SESSION_ENVIRONMENT_NAMES) delete environment[name];
  if (!enabled) return environment;
  const values = {
    RIGYN_SESSION_ID: context.threadId,
    RIGYN_SESSION_FILE: context.sessionFile,
    RIGYN_PROVIDER: context.provider,
    RIGYN_MODEL: context.modelId,
    RIGYN_REASONING_LEVEL: context.reasoningLevel,
  } satisfies Record<(typeof SESSION_ENVIRONMENT_NAMES)[number], string | undefined>;
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && !value.includes("\0")) environment[name] = value;
  }
  return environment;
}

function timeoutMilliseconds(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Timeout must be a positive finite number of seconds");
  }
  const milliseconds = value * 1_000;
  if (milliseconds > MAX_TIMEOUT_MS) {
    throw new Error(`Timeout cannot exceed ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return milliseconds;
}

export class ShellTool implements HarnessTool {
  readonly recovery = { mode: "never_repeat" } as const;
  readonly definition;
  readonly executionMode = "sequential" as const;
  readonly #shellPath: string | undefined;
  readonly #commandPrefix: string | undefined;
  readonly #operations: BashOperations | undefined;
  readonly #spawnHook: BashSpawnHook | undefined;
  readonly #sessionEnvironment: boolean;

  constructor(name: "shell" | "bash" = "shell", options: BashToolOptions = {}) {
    if (options.commandPrefix !== undefined && (
      options.commandPrefix.includes("\0")
      || Buffer.byteLength(options.commandPrefix, "utf8") > 16 * 1_024
    )) throw new Error("Shell command prefix must contain at most 16384 bytes and no NUL");
    this.#shellPath = options.shellPath;
    this.#commandPrefix = options.commandPrefix;
    this.#operations = options.operations;
    this.#spawnHook = options.spawnHook;
    this.#sessionEnvironment = options.exposeSessionEnvironment
      ?? options.sessionEnvironment
      ?? true;
    this.definition = {
      name,
      description: `Run a shell command from the active workspace. Standard output and errors are returned together. The visible tail is limited to ${TOOL_MAX_LINES} lines or ${TOOL_MAX_BYTES / 1024} KiB. When that limit is reached, Rigyn attempts to retain up to 64 MiB in a private temporary artifact; if storage is unavailable, only the bounded tail is returned. Set timeout to limit the run time.`,
      promptSnippet: "Run shell commands in the workspace",
      ...(this.#sessionEnvironment
        ? {
            promptGuidelines: [
              "Use the RIGYN_* session environment when exact current model, reasoning, or session details are needed.",
            ],
          }
        : {}),
      inputSchema: schema,
    };
  }

  validate(input: JsonValue): void {
    assertSchema(schema, input);
    const object = inputObject(input);
    timeoutMilliseconds(object.timeout === undefined ? undefined : numberInput(object, "timeout", 0));
  }

  resources(_input: JsonValue, context: ToolContext): ResourceClaim[] {
    return [{ kind: "process", key: context.workspace.root, mode: "write" }];
  }

  async execute(input: JsonValue, context: ToolContext): Promise<ToolResult> {
    this.validate(input);
    const object = inputObject(input);
    const command = stringInput(object, "command");
    const selectedCommand = this.#commandPrefix === undefined ? command : `${this.#commandPrefix}\n${command}`;
    const defaultSpawnContext: BashSpawnContext = {
      command: selectedCommand,
      cwd: context.workspace.root,
      env: bashEnvironment(context, this.#sessionEnvironment),
    };
    const spawnContext = this.#spawnHook?.(defaultSpawnContext) ?? defaultSpawnContext;
    if (typeof spawnContext.command !== "string" || typeof spawnContext.cwd !== "string") {
      throw new Error("Bash spawn hook returned an invalid command context");
    }
    const timeout = object.timeout === undefined ? undefined : numberInput(object, "timeout", 0);
    const output = new ToolOutputAccumulator({ prefix: "rigyn-bash" });
    const progress = context.reportProgress === undefined ? undefined : new CoalescedOutputProgress(context.reportProgress);
    let acceptingOutput = true;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const observe = (stream: "stdout" | "stderr", chunk: Uint8Array, report: boolean): void => {
      if (!acceptingOutput) return;
      if (stream === "stdout") stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
      output.append(chunk);
      if (report) progress?.push(stream, chunk);
    };
    const formatSnapshot = (
      snapshot: ReturnType<ToolOutputAccumulator["snapshot"]>,
      emptyText = "(no output)",
    ): string => {
      let content = snapshot.content || emptyText;
      if (!snapshot.truncation.truncated) return content;
      const first = snapshot.truncation.totalLines - snapshot.truncation.outputLines + 1;
      const last = snapshot.truncation.totalLines;
      if (snapshot.fullOutputUnavailable === true) {
        if (snapshot.truncation.lastLinePartial) {
          content += `\n\n[Tail contains ${formatBytes(snapshot.truncation.outputBytes)} from line ${last}; complete line size is ${formatBytes(output.lastLineBytes())}.]`;
        } else if (snapshot.truncation.truncatedBy === "lines") {
          content += `\n\n[Tail contains lines ${first}-${last} of ${snapshot.truncation.totalLines}.]`;
        } else {
          content += `\n\n[Tail contains lines ${first}-${last} of ${snapshot.truncation.totalLines} within the ${formatBytes(TOOL_MAX_BYTES)} display limit.]`;
        }
        content += "\n[Complete output is unavailable because private artifact storage or admission was unavailable.]";
      } else if (snapshot.truncation.lastLinePartial) {
        content += `\n\n[Tail contains ${formatBytes(snapshot.truncation.outputBytes)} from line ${last}; complete line size is ${formatBytes(output.lastLineBytes())}. Complete output: ${snapshot.fullOutputPath}]`;
      } else if (snapshot.truncation.truncatedBy === "lines") {
        content += `\n\n[Tail contains lines ${first}-${last} of ${snapshot.truncation.totalLines}. Complete output: ${snapshot.fullOutputPath}]`;
      } else {
        content += `\n\n[Tail contains lines ${first}-${last} of ${snapshot.truncation.totalLines} within the ${formatBytes(TOOL_MAX_BYTES)} display limit. Complete output: ${snapshot.fullOutputPath}]`;
      }
      if (snapshot.fullOutputTruncated === true && snapshot.fullOutputUnavailable !== true) {
        content += `\n[The complete-output artifact reached the ${formatBytes(64 * 1024 * 1024)} storage limit.]`;
      }
      return content;
    };
    const metadataFor = (
      result: Awaited<ReturnType<ToolContext["runner"]["run"]>>,
      snapshot: ReturnType<ToolOutputAccumulator["snapshot"]>,
    ): JsonValue => {
      const truncation = {
        truncated: snapshot.truncation.truncated,
        wasTruncated: snapshot.truncation.wasTruncated,
        truncatedBy: snapshot.truncation.truncatedBy,
        totalLines: snapshot.truncation.totalLines,
        totalBytes: snapshot.truncation.totalBytes,
        outputLines: snapshot.truncation.outputLines,
        outputBytes: snapshot.truncation.outputBytes,
        maxLines: snapshot.truncation.maxLines,
        maxBytes: snapshot.truncation.maxBytes,
        firstLineExceedsLimit: snapshot.truncation.firstLineExceedsLimit,
        lastLinePartial: snapshot.truncation.lastLinePartial,
      };
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        durationMs: result.durationMs,
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
        truncated: snapshot.truncation.truncated,
        ...(snapshot.truncation.truncated ? { truncation } : {}),
        fullOutputTruncated: snapshot.fullOutputTruncated === true,
        fullOutputUnavailable: snapshot.fullOutputUnavailable === true,
        ...(snapshot.fullOutputPath === undefined ? {} : { fullOutputPath: snapshot.fullOutputPath }),
      };
    };
    const failureResult = (content: string, metadata: JsonValue): ToolResult => {
      const failure = `Tool failed: ${content}`;
      return {
        content: failure,
        isError: true,
        status: "error",
        summary: failure.split("\n", 1)[0] ?? "Tool failed",
        nextActions: ["Use the reported root cause to correct the request; stop if the failure is not safely retryable."],
        metadata,
      };
    };

    const timeoutMs = timeoutMilliseconds(timeout);
    let result: Awaited<ReturnType<ToolContext["runner"]["run"]>>;
    try {
      if (this.#operations !== undefined) {
        const custom = await this.#operations.exec(spawnContext.command, spawnContext.cwd, {
          onData(data) { observe("stdout", data, true); },
          signal: context.signal,
          ...(timeout === undefined ? {} : { timeout }),
          env: spawnContext.env,
        });
        result = {
          exitCode: custom.exitCode,
          signal: custom.signal ?? null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          stdoutBytes: custom.stdoutBytes ?? stdoutBytes,
          stderrBytes: custom.stderrBytes ?? stderrBytes,
          timedOut: custom.timedOut ?? false,
          cancelled: custom.cancelled ?? false,
          durationMs: custom.durationMs ?? 0,
        };
      } else {
        const invocation = await commandShellInvocation(
          spawnContext.command,
          this.#shellPath === undefined ? {} : { configuredPath: this.#shellPath },
        );
        result = await context.runner.run(
          {
            argv: invocation.argv,
            ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
            cwd: spawnContext.cwd,
            env: spawnContext.env as Record<string, string>,
            inheritEnv: false,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            outputLimitBytes: 512 * 1024,
            onOutput(stream, chunk) {
              observe(stream, chunk, true);
            },
          },
          context.signal,
        );
      }
    } catch (error) {
      acceptingOutput = false;
      output.finish();
      output.snapshot(true);
      await output.close();
      const snapshot = output.snapshot();
      let content = formatSnapshot(snapshot, "");
      if (error instanceof Error && error.message === "aborted") {
        context.signal.throwIfAborted();
        content += `${content === "" ? "" : "\n\n"}Shell command was cancelled`;
        return failureResult(content, metadataFor({
          exitCode: null,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          stdoutBytes,
          stderrBytes,
          timedOut: false,
          cancelled: true,
          durationMs: 0,
        }, snapshot));
      }
      else if (error instanceof Error && error.message.startsWith("timeout:")) {
        context.signal.throwIfAborted();
        content += `${content === "" ? "" : "\n\n"}Shell command exceeded its ${error.message.slice("timeout:".length)}-second time limit`;
        return failureResult(content, metadataFor({
          exitCode: null,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          stdoutBytes,
          stderrBytes,
          timedOut: true,
          cancelled: false,
          durationMs: 0,
        }, snapshot));
      }
      throw error;
    } finally {
      progress?.close();
    }

    if (stdoutBytes === 0 && result.stdout.byteLength > 0) observe("stdout", result.stdout, false);
    if (stderrBytes === 0 && result.stderr.byteLength > 0) observe("stderr", result.stderr, false);
    acceptingOutput = false;
    output.finish();
    output.snapshot(true);
    await output.close();
    const snapshot = output.snapshot();

    let content = formatSnapshot(snapshot);
    const metadata = metadataFor(result, snapshot);

    let status: string | undefined;
    if (result.cancelled) status = "Shell command was cancelled";
    else if (result.timedOut) status = timeout === undefined
      ? "Shell command timed out"
      : `Shell command exceeded its ${timeout}-second time limit`;
    else if (result.signal !== null) status = `Shell command stopped after signal ${result.signal}`;
    else if (result.exitCode !== 0 && result.exitCode !== null) status = `Shell command ended with status ${result.exitCode}`;
    if (status !== undefined) {
      content = `${content === "(no output)" ? "" : `${content}\n\n`}${status}`;
      return failureResult(content, metadata);
    }

    return {
      content,
      isError: false,
      metadata,
    };
  }
}

function bashDetails(result: ToolResult): BashToolDetails | undefined {
  const metadata = result.metadata as Record<string, unknown> | undefined;
  if (metadata?.truncation === undefined && typeof metadata?.fullOutputPath !== "string") return undefined;
  const compact = metadata.truncation;
  const truncation = compact !== null && typeof compact === "object" && !Array.isArray(compact)
    && typeof (compact as Record<string, unknown>).outputBytes === "number"
    ? {
        ...(compact as Omit<ToolTruncation, "content">),
        content: Buffer.from(result.content, "utf8")
          .subarray(0, (compact as Record<string, number>).outputBytes)
          .toString("utf8"),
      }
    : undefined;
  return {
    ...(truncation === undefined ? {} : { truncation }),
    ...(typeof metadata.fullOutputPath === "string" ? { fullOutputPath: metadata.fullOutputPath } : {}),
  };
}

export function createBashToolDefinition(
  cwd: string,
  options?: BashToolOptions,
): ToolDefinition<typeof bashParameters, BashToolDetails | undefined> {
  return createHarnessToolDefinition({
    cwd,
    tool: new ShellTool("bash", options),
    label: "bash",
    parameters: bashParameters,
    details: bashDetails,
  });
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashParameters, BashToolDetails | undefined> {
  return wrapToolDefinition(createBashToolDefinition(cwd, options));
}

export function createLocalBashOperations(options: { shellPath?: string } = {}): BashOperations {
  return {
    async exec(command, cwd, execution) {
      const runner = new DirectProcessRunner();
      const timeoutMs = timeoutMilliseconds(execution.timeout);
      const invocation = await commandShellInvocation(
        command,
        options.shellPath === undefined ? {} : { configuredPath: options.shellPath },
      );
      const result = await runner.run({
        argv: invocation.argv,
        ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
        cwd,
        ...(execution.env === undefined ? {} : { env: execution.env as Record<string, string> }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        outputLimitBytes: 512 * 1024,
        onOutput(_stream, data) { execution.onData(Buffer.from(data)); },
      }, execution.signal ?? new AbortController().signal);
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        durationMs: result.durationMs,
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
      };
    },
  };
}
