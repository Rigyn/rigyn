import { realpath, stat } from "node:fs/promises";
import { relative, sep } from "node:path";

import type { JsonValue } from "../../core/json.js";
import { assertSchema } from "../schema.js";
import { inputObject, numberInput, stringInput } from "../input.js";
import { displayToolPath, resolveToolReadPath } from "../paths.js";
import type { HarnessTool, ResourceClaim, ToolContext, ToolResult } from "../types.js";
import { walkWorkspace } from "../workspace-walker.js";

const DEFAULT_LIMIT = 1_000;
const MAX_LIMIT = 10_000;
const MAX_RESULT_BYTES = 240 * 1024;

const schema: Record<string, JsonValue> = {
  type: "object",
  additionalProperties: false,
  required: ["pattern"],
  properties: {
    pattern: { type: "string", minLength: 1, maxLength: 16 * 1024, description: "File glob such as '*.ts' or 'src/**/*.spec.ts'." },
    path: { type: "string", maxLength: 4096, description: "Directory to search; defaults to the starting workspace." },
    limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Maximum paths; defaults to ${DEFAULT_LIMIT}.` },
  },
};

function portable(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

export class FindTool implements HarnessTool {
  readonly definition = {
    name: "find",
    description: "Find files by glob pattern, including hidden files and respecting ignore files. Paths may be relative or absolute.",
    inputSchema: schema,
  };

  validate(input: JsonValue): void {
    assertSchema(schema, input);
  }

  async resources(input: JsonValue, context: ToolContext): Promise<ResourceClaim[]> {
    const requested = stringInput(inputObject(input), "path", ".");
    const resolved = await realpath(await resolveToolReadPath(requested, context.workspace.root));
    return [{ kind: "file", key: resolved, mode: "read" }];
  }

  async execute(input: JsonValue, context: ToolContext): Promise<ToolResult> {
    const object = inputObject(input);
    const pattern = stringInput(object, "pattern");
    const requested = stringInput(object, "path", ".");
    const limit = numberInput(object, "limit", DEFAULT_LIMIT);
    const searchRoot = await realpath(await resolveToolReadPath(requested, context.workspace.root));
    if (!(await stat(searchRoot)).isDirectory()) throw new Error("Find path is not a directory");

    const scanned = await walkWorkspace(searchRoot, {
      pattern,
      limit: limit + 1,
      maxDepth: 64,
      includeHidden: true,
      signal: context.signal,
    });
    const matches: string[] = [];
    let resultBytes = 0;
    let outputTruncated = false;
    for (const entry of scanned.entries.slice(0, limit)) {
      const match = portable(relative(searchRoot, entry.absolutePath));
      const bytes = Buffer.byteLength(match, "utf8") + (matches.length === 0 ? 0 : 1);
      if (resultBytes + bytes > MAX_RESULT_BYTES) {
        outputTruncated = true;
        break;
      }
      matches.push(match);
      resultBytes += bytes;
    }
    const truncated = scanned.truncated || scanned.entries.length > limit || outputTruncated;
    return {
      content: matches.length === 0 ? "No files found matching pattern" : matches.join("\n"),
      isError: false,
      metadata: {
        count: matches.length,
        path: displayToolPath(searchRoot, context.workspace.root),
        pattern,
        truncated,
        outputTruncated,
      },
    };
  }
}
