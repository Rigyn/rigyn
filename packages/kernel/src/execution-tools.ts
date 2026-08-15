import { Type, type Static, type TSchema } from "@rigyn/models";

import {
  type AgentTool,
  type AgentToolResult,
  type ExecutionToolContext,
  type ToolFactoryOptions,
  getOrThrow,
} from "./harness/types.js";
import { base64, detectImageMimeType } from "./harness/tools/image.js";
import { executeShellWithCapture, type ShellCapture } from "./shell-capture.js";
import { truncateHead, type TruncationResult } from "./text-limits.js";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const OUTPUT_BYTES = 50 * 1024;
const OUTPUT_LINES = 2_000;

export interface BashToolDetails {
  command: string;
  exitCode?: number;
  fullOutputPath?: string;
  truncation?: TruncationResult;
}

export interface ReadToolDetails {
  path: string;
  truncation?: TruncationResult;
}

export interface WriteToolDetails { path: string; bytes: number }
export interface EditToolDetails { path: string; replacements: number }

const bashParameters = Type.Object({
  command: Type.String(),
  timeout: Type.Optional(Type.Number()),
});
const readParameters = Type.Object({ path: Type.String() });
const writeParameters = Type.Object({ path: Type.String(), content: Type.String() });
const editParameters = Type.Object({
  path: Type.String(),
  edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
});

function requireContext<TContext extends ExecutionToolContext>(context: TContext | undefined): TContext {
  if (context === undefined) throw new Error("Execution tool context is required");
  return context;
}

function captureText(capture: ShellCapture): string {
  const notes: string[] = [];
  if (capture.truncation.firstLineExceedsLimit || capture.lastLineBytes > OUTPUT_BYTES) {
    const largest = Math.max(capture.lastLineBytes, capture.truncation.totalBytes);
    notes.push(`[A complete line size is ${(largest / (1024 * 1024)).toFixed(1)}MB.]`);
  }
  if (capture.fullOutputPath !== undefined) notes.push(`[Complete output: ${capture.fullOutputPath}]`);
  return [capture.output, ...notes].filter((value) => value !== "").join("\n");
}

export function createBashTool<TContext extends ExecutionToolContext = ExecutionToolContext>(
  options: ToolFactoryOptions<TContext> = {},
): AgentTool<typeof bashParameters, BashToolDetails, TContext> {
  return {
    name: "bash",
    label: "Shell",
    description: "Run a shell command in the execution environment",
    parameters: bashParameters,
    async execute(_toolCallId, input, signal, onUpdate, context) {
      const selected = requireContext(context);
      const execution = {
        command: input.command,
        env: {} as Record<string, string>,
        ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
      };
      await options.prepare?.(execution, selected);
      const captured = await executeShellWithCapture(selected.env, execution.command, {
        env: execution.env,
        ...(signal === undefined ? {} : { abortSignal: signal }),
        ...(execution.timeout === undefined ? {} : { timeout: execution.timeout }),
        returnExecutionErrors: true,
        onChunk: (_chunk, snapshot) => {
          const progress = snapshot();
          onUpdate?.({
            content: [{ type: "text", text: progress.output }],
            details: {
              command: execution.command,
              ...(progress.fullOutputPath === undefined ? {} : { fullOutputPath: progress.fullOutputPath }),
              truncation: progress.truncation,
            },
          });
        },
      });
      const capture = getOrThrow(captured);
      const text = captureText(capture);
      if (capture.executionError !== undefined) {
        const failure = capture.executionError.code === "timeout" && execution.timeout !== undefined
          ? `Shell command exceeded its time limit of ${execution.timeout} seconds`
          : capture.executionError.message;
        throw new Error([text, failure].filter(Boolean).join("\n"));
      }
      return {
        content: [{ type: "text", text }],
        details: {
          command: execution.command,
          ...(capture.exitCode === undefined ? {} : { exitCode: capture.exitCode }),
          ...(capture.fullOutputPath === undefined ? {} : { fullOutputPath: capture.fullOutputPath }),
          ...(capture.truncated ? { truncation: capture.truncation } : {}),
        },
      };
    },
  };
}

export function createReadTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentTool<typeof readParameters, ReadToolDetails | undefined, TContext> {
  return {
    name: "read",
    label: "Read",
    description: "Read a text or supported image file",
    parameters: readParameters,
    async execute(_toolCallId, input, signal, _onUpdate, context) {
      const { env } = requireContext(context);
      const info = getOrThrow(await env.fileInfo(input.path, signal));
      if (info.size > MAX_FILE_BYTES) throw new Error(`File is too large to read safely (${(info.size / (1024 * 1024)).toFixed(1)}MB; limit 16.0MB)`);
      const bytes = getOrThrow(await env.readBinaryFile(input.path, signal, MAX_FILE_BYTES));
      if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("File is too large to read safely (limit 16.0MB)");
      const mimeType = detectImageMimeType(bytes);
      if (mimeType !== undefined) {
        return {
          content: [{ type: "image", data: base64(bytes), mimeType }],
          details: { path: input.path },
        } as AgentToolResult<ReadToolDetails | undefined>;
      }
      let value: string;
      try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error(`Unsupported binary file: ${input.path}`); }
      if (value.endsWith("\n")) value = value.slice(0, -1);
      const truncated = truncateHead(value, { maxBytes: OUTPUT_BYTES, maxLines: OUTPUT_LINES });
      return {
        content: [{ type: "text", text: truncated.content }],
        details: truncated.truncated ? { path: input.path, truncation: truncated } : undefined,
      };
    },
  };
}

const mutations = new Map<string, Promise<void>>();

async function serialMutation<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = mutations.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((accept) => { release = accept; });
  mutations.set(path, previous.then(() => current));
  await previous;
  try { return await action(); } finally {
    release();
    if (mutations.get(path) === current) mutations.delete(path);
  }
}

export function createWriteTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentTool<typeof writeParameters, WriteToolDetails, TContext> {
  return {
    name: "write",
    label: "Write",
    description: "Atomically replace a text file",
    parameters: writeParameters,
    async execute(_toolCallId, input, signal, _onUpdate, context) {
      const { env } = requireContext(context);
      return serialMutation(input.path, async () => {
        getOrThrow(await env.replaceFile(input.path, input.content, signal));
        const bytes = Buffer.byteLength(input.content, "utf8");
        return {
          content: [{ type: "text", text: `Wrote ${bytes} bytes to ${input.path}` }],
          details: { path: input.path, bytes },
        };
      });
    },
  };
}

export function createEditTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentTool<typeof editParameters, EditToolDetails, TContext> {
  return {
    name: "edit",
    label: "Edit",
    description: "Apply exact replacements to a text file",
    parameters: editParameters,
    async execute(_toolCallId, input, signal, _onUpdate, context) {
      if (input.edits.length === 0) throw new Error("Provide at least one replacement edit");
      const { env } = requireContext(context);
      return serialMutation(input.path, async () => {
        let value = getOrThrow(await env.readTextFile(input.path, signal, MAX_FILE_BYTES));
        let replacements = 0;
        for (const edit of input.edits) {
          if (edit.oldText === "") throw new Error("Replacement source text must not be empty");
          if (!value.includes(edit.oldText)) throw new Error(`Text to replace was not found in ${input.path}`);
          const pieces = value.split(edit.oldText);
          replacements += pieces.length - 1;
          value = pieces.join(edit.newText);
        }
        getOrThrow(await env.replaceFile(input.path, value, signal));
        return {
          content: [{ type: "text", text: `Applied ${replacements} replacement${replacements === 1 ? "" : "s"} to ${input.path}` }],
          details: { path: input.path, replacements },
        };
      });
    },
  };
}

export function createExecutionTools<TContext extends ExecutionToolContext = ExecutionToolContext>(): Array<AgentTool<TSchema, unknown, TContext>> {
  return [
    createReadTool<TContext>(),
    createBashTool<TContext>(),
    createEditTool<TContext>(),
    createWriteTool<TContext>(),
  ] as Array<AgentTool<TSchema, unknown, TContext>>;
}

export type BashToolInput = Static<typeof bashParameters>;
export type ReadToolInput = Static<typeof readParameters>;
export type WriteToolInput = Static<typeof writeParameters>;
export type EditToolInput = Static<typeof editParameters>;
