import type { JsonValue } from "../../core/json.js";
import { withFileMutation } from "../file-mutation-queue.js";
import { inputObject, stringInput } from "../input.js";
import { atomicWritePath, displayToolPath, resolveToolPath } from "../paths.js";
import { assertSchema } from "../schema.js";
import type { HarnessTool, ResourceClaim, ToolContext, ToolResult } from "../types.js";

const schema: Record<string, JsonValue> = {
  type: "object",
  additionalProperties: false,
  required: ["path", "content"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 4096 },
    content: { type: "string", maxLength: 8388608 },
  },
};

export class WriteTool implements HarnessTool {
  readonly definition = {
    name: "write",
    description: "Create or overwrite a file and automatically create missing parent directories. Paths may be relative or absolute.",
    promptSnippet: "Create a new file or deliberately replace an entire file",
    promptGuidelines: [
      "Use write for new files or intentional full replacement; inspect an existing file before overwriting it.",
    ],
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
      throwIfAborted();
      await atomicWritePath(absolute, Buffer.from(content, "utf8"), { createParents: true });
      return {
        content: `Successfully wrote ${content.length} bytes to ${requested}`,
        isError: false,
        metadata: { path: shownPath, bytes: Buffer.byteLength(content, "utf8") },
      };
    });
  }
}
