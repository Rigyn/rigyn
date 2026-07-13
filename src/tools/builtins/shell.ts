import type { JsonValue } from "../../core/json.js";
import { commandShellArgv } from "../../process/command-shell.js";
import { inputObject, numberInput, stringInput } from "../input.js";
import { ToolOutputAccumulator } from "../output-accumulator.js";
import { CoalescedOutputProgress } from "../progress.js";
import { assertSchema } from "../schema.js";
import { formatBytes, TOOL_MAX_BYTES, TOOL_MAX_LINES } from "../truncate.js";
import type { HarnessTool, ResourceClaim, ToolContext, ToolResult } from "../types.js";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1_000;

const schema: Record<string, JsonValue> = {
  type: "object",
  additionalProperties: false,
  required: ["command"],
  properties: {
    command: { type: "string", minLength: 1, maxLength: 131072 },
    timeout: { type: "number" },
  },
};

function timeoutMilliseconds(value: number | undefined): number {
  if (value === undefined) return MAX_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
  const milliseconds = value * 1_000;
  if (milliseconds > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  return milliseconds;
}

export class ShellTool implements HarnessTool {
  readonly definition;
  readonly executionMode = "sequential" as const;
  readonly #shellPath: string | undefined;

  constructor(name: "shell" | "bash" = "shell", options: { shellPath?: string } = {}) {
    this.#shellPath = options.shellPath;
    this.definition = {
      name,
      description: `Execute a bash command in the current working directory. Output is limited to the final ${TOOL_MAX_LINES} lines or ${TOOL_MAX_BYTES / 1024}KB, with complete truncated output saved to a temporary file.`,
      promptSnippet: "Run commands, tests, builds, and repository tooling in the current workspace",
      promptGuidelines: [
        `Use ${name} for commands and verification; prefer active dedicated file or search tools when they provide a clearer bounded operation.`,
      ],
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
    const timeout = object.timeout === undefined ? undefined : numberInput(object, "timeout", 0);
    const output = new ToolOutputAccumulator({ prefix: "rigyn-bash" });
    const progress = context.reportProgress === undefined ? undefined : new CoalescedOutputProgress(context.reportProgress);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const observe = (stream: "stdout" | "stderr", chunk: Uint8Array, report: boolean): void => {
      if (stream === "stdout") stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
      output.append(chunk);
      if (report) progress?.push(stream, chunk);
    };

    let result: Awaited<ReturnType<ToolContext["runner"]["run"]>>;
    try {
      result = await context.runner.run(
        {
          argv: await commandShellArgv(command, this.#shellPath === undefined ? {} : { configuredPath: this.#shellPath }),
          cwd: context.workspace.root,
          timeoutMs: timeoutMilliseconds(timeout),
          outputLimitBytes: 512 * 1024,
          onOutput(stream, chunk) {
            observe(stream, chunk, true);
          },
        },
        context.signal,
      );
    } finally {
      progress?.close();
    }

    if (stdoutBytes === 0 && result.stdout.byteLength > 0) observe("stdout", result.stdout, false);
    if (stderrBytes === 0 && result.stderr.byteLength > 0) observe("stderr", result.stderr, false);
    output.finish();
    const snapshot = output.snapshot(true);
    await output.close();

    let content = snapshot.content || "(no output)";
    if (snapshot.truncation.truncated) {
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
    }

    let status: string | undefined;
    if (result.cancelled) status = "Command aborted";
    else if (result.timedOut) status = `Command timed out after ${timeout ?? MAX_TIMEOUT_SECONDS} seconds`;
    else if (result.signal !== null) status = `Command terminated by ${result.signal}`;
    else if (result.exitCode !== 0 && result.exitCode !== null) status = `Command exited with code ${result.exitCode}`;
    if (status !== undefined) content = `${content === "(no output)" ? "" : `${content}\n\n`}${status}`;

    return {
      content,
      isError: status !== undefined,
      metadata: {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        durationMs: result.durationMs,
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
        truncated: snapshot.truncation.truncated,
        fullOutputTruncated: snapshot.fullOutputTruncated === true,
        ...(snapshot.fullOutputPath === undefined ? {} : { fullOutputPath: snapshot.fullOutputPath }),
      },
    };
  }
}
