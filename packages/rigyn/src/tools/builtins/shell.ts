import type { JsonValue } from "../../core/json.js";
import { commandShellArgv } from "../../process/command-shell.js";
import { DirectProcessRunner } from "../../process/runner.js";
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

const bashParameters = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
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
  ): Promise<{ exitCode: number | null }>;
}

export interface BashSpawnContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

export interface BashToolOptions {
  operations?: BashOperations;
  commandPrefix?: string;
  shellPath?: string;
  spawnHook?: BashSpawnHook;
}

const schema: Record<string, JsonValue> = {
  type: "object",
  required: ["command"],
  properties: {
    command: { type: "string", description: "Bash command to execute" },
    timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
  },
};

function timeoutMilliseconds(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
  const milliseconds = value * 1_000;
  if (milliseconds > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  return milliseconds;
}

export class ShellTool implements HarnessTool {
  readonly definition;
  readonly executionMode = "sequential" as const;
  readonly #shellPath: string | undefined;
  readonly #commandPrefix: string | undefined;
  readonly #operations: BashOperations | undefined;
  readonly #spawnHook: BashSpawnHook | undefined;

  constructor(name: "shell" | "bash" = "shell", options: BashToolOptions = {}) {
    if (options.commandPrefix !== undefined && (
      options.commandPrefix.includes("\0")
      || Buffer.byteLength(options.commandPrefix, "utf8") > 16 * 1_024
    )) throw new Error("Shell command prefix must contain at most 16384 bytes and no NUL");
    this.#shellPath = options.shellPath;
    this.#commandPrefix = options.commandPrefix;
    this.#operations = options.operations;
    this.#spawnHook = options.spawnHook;
    this.definition = {
      name,
      description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${TOOL_MAX_LINES} lines or ${TOOL_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
      promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
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
    const spawnContext = this.#spawnHook?.({
      command: selectedCommand,
      cwd: context.workspace.root,
      env: { ...process.env },
    }) ?? { command: selectedCommand, cwd: context.workspace.root, env: { ...process.env } };
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
      if (snapshot.truncation.lastLinePartial) {
        content += `\n\n[Showing last ${formatBytes(snapshot.truncation.outputBytes)} of line ${last} (line is ${formatBytes(output.lastLineBytes())}). Full output: ${snapshot.fullOutputPath}]`;
      } else if (snapshot.truncation.truncatedBy === "lines") {
        content += `\n\n[Showing lines ${first}-${last} of ${snapshot.truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
      } else {
        content += `\n\n[Showing lines ${first}-${last} of ${snapshot.truncation.totalLines} (${formatBytes(TOOL_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
      }
      if (snapshot.fullOutputTruncated === true) {
        content += `\n[Full-output artifact reached its ${formatBytes(64 * 1024 * 1024)} safety limit.]`;
      }
      return content;
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
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          stdoutBytes,
          stderrBytes,
          timedOut: false,
          cancelled: false,
          durationMs: 0,
        };
      } else {
        result = await context.runner.run(
          {
            argv: await commandShellArgv(spawnContext.command, this.#shellPath === undefined ? {} : { configuredPath: this.#shellPath }),
            cwd: spawnContext.cwd,
            env: spawnContext.env as Record<string, string>,
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
      const snapshot = output.snapshot(true);
      await output.close();
      let content = formatSnapshot(snapshot, "");
      if (error instanceof Error && error.message === "aborted") {
        content += `${content === "" ? "" : "\n\n"}Command aborted`;
        throw new Error(content);
      }
      else if (error instanceof Error && error.message.startsWith("timeout:")) {
        content += `${content === "" ? "" : "\n\n"}Command timed out after ${error.message.slice("timeout:".length)} seconds`;
        throw new Error(content);
      }
      throw error;
    } finally {
      progress?.close();
    }

    if (stdoutBytes === 0 && result.stdout.byteLength > 0) observe("stdout", result.stdout, false);
    if (stderrBytes === 0 && result.stderr.byteLength > 0) observe("stderr", result.stderr, false);
    acceptingOutput = false;
    output.finish();
    const snapshot = output.snapshot(true);
    await output.close();

    let content = formatSnapshot(snapshot);

    let status: string | undefined;
    if (result.cancelled) status = "Command aborted";
    else if (result.timedOut) status = `Command timed out after ${timeout} seconds`;
    else if (result.signal !== null) status = `Command terminated by ${result.signal}`;
    else if (result.exitCode !== 0 && result.exitCode !== null) status = `Command exited with code ${result.exitCode}`;
    if (status !== undefined) {
      content = `${content === "(no output)" ? "" : `${content}\n\n`}${status}`;
      throw new Error(content);
    }

    return {
      content,
      isError: false,
      metadata: {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        durationMs: result.durationMs,
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
        truncated: snapshot.truncation.truncated,
        ...(snapshot.truncation.truncated ? { truncation: { ...snapshot.truncation } } : {}),
        fullOutputTruncated: snapshot.fullOutputTruncated === true,
        ...(snapshot.fullOutputPath === undefined ? {} : { fullOutputPath: snapshot.fullOutputPath }),
      },
    };
  }
}

function bashDetails(result: ToolResult): BashToolDetails | undefined {
  const metadata = result.metadata as Record<string, unknown> | undefined;
  if (metadata?.truncation === undefined && typeof metadata?.fullOutputPath !== "string") return undefined;
  return {
    ...(metadata.truncation === undefined ? {} : { truncation: metadata.truncation as ToolTruncation }),
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
      const result = await runner.run({
        argv: await commandShellArgv(command, options.shellPath === undefined ? {} : { configuredPath: options.shellPath }),
        cwd,
        ...(execution.env === undefined ? {} : { env: execution.env as Record<string, string> }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        outputLimitBytes: 512 * 1024,
        onOutput(_stream, data) { execution.onData(Buffer.from(data)); },
      }, execution.signal ?? new AbortController().signal);
      if (result.cancelled) throw new Error("aborted");
      if (result.timedOut) throw new Error(`timeout:${execution.timeout}`);
      return { exitCode: result.exitCode };
    },
  };
}
