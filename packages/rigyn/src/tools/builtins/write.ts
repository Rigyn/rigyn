import type { JsonValue } from "../../core/json.js";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "../../extensions/direct.js";
import { withFileMutation } from "../file-mutation-queue.js";
import { createHarnessToolDefinition, wrapToolDefinition, type AgentTool } from "../direct-tool.js";
import { inputObject, stringInput } from "../input.js";
import { displayToolPath, resolveToolPath } from "../paths.js";
import { assertSchema } from "../schema.js";
import type { HarnessTool, ResourceClaim, ToolContext, ToolResult } from "../types.js";

const schema: Record<string, JsonValue> = {
  type: "object",
  required: ["path", "content"],
  properties: {
    path: { type: "string", description: "Path to the file to write (relative or absolute)" },
    content: { type: "string", description: "Content to write to the file" },
  },
};

const writeParameters = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeParameters>;
export interface WriteOperations {
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}
export interface WriteToolOptions { operations?: WriteOperations }

const defaultWriteOperations: WriteOperations = {
  writeFile: (path, content) => fsWriteFile(path, content, "utf8"),
  mkdir: (path) => fsMkdir(path, { recursive: true }).then(() => undefined),
};

export class WriteTool implements HarnessTool {
  readonly #operations: WriteOperations | undefined;

  constructor(options: WriteToolOptions = {}) {
    this.#operations = options.operations;
  }

  readonly definition = {
    name: "write",
    description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    promptSnippet: "Create or overwrite files",
    promptGuidelines: ["Use write only for new files or complete rewrites."],
    inputSchema: schema,
  };

  validate(input: JsonValue): void {
    assertSchema(schema, input);
  }

  resources(input: JsonValue, context: ToolContext): ResourceClaim[] {
    const requested = stringInput(inputObject(input), "path");
    return [{ kind: "file", key: resolveToolPath(requested, context.workspace.root), mode: "write" }];
  }

  async execute(input: JsonValue, context: ToolContext): Promise<ToolResult> {
    this.validate(input);
    const object = inputObject(input);
    const requested = stringInput(object, "path");
    const content = stringInput(object, "content");
    const absolute = resolveToolPath(requested, context.workspace.root);
    const shownPath = displayToolPath(absolute, context.workspace.root);

    return await withFileMutation(absolute, async () => {
      const throwIfAborted = (): void => context.signal.throwIfAborted();
      const operations = this.#operations ?? defaultWriteOperations;
      throwIfAborted();
      await operations.mkdir(dirname(absolute));
      throwIfAborted();
      await operations.writeFile(absolute, content);
      throwIfAborted();
      return {
        content: `Successfully wrote ${content.length} bytes to ${requested}`,
        isError: false,
        metadata: { path: shownPath, bytes: Buffer.byteLength(content, "utf8") },
      };
    });
  }
}

export function createWriteToolDefinition(
  cwd: string,
  options?: WriteToolOptions,
): ToolDefinition<typeof writeParameters, undefined> {
  return createHarnessToolDefinition({
    cwd,
    tool: new WriteTool(options),
    label: "write",
    parameters: writeParameters,
    details: () => undefined,
  });
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeParameters, undefined> {
  return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
