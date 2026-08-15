import { readdir as fsReaddir, realpath, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";

import { errorMessage } from "../../core/errors.js";
import type { JsonValue } from "../../core/json.js";
import type { ToolDefinition } from "../../extensions/direct.js";
import { assertSchema } from "../schema.js";
import { createHarnessToolDefinition, wrapToolDefinition, type AgentTool } from "../direct-tool.js";
import { inputObject, stringInput } from "../input.js";
import { safeIntegerInput } from "../integer-input.js";
import { displayToolPath, pathExists, resolveToolReadPath } from "../paths.js";
import { TOOL_MAX_BYTES, truncateToolHead, type ToolTruncation } from "../truncate.js";
import type { HarnessTool, ResourceClaim, ToolContext, ToolResult } from "../types.js";

const DEFAULT_LIMIT = 500;

const lsParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to inspect. The default is the current directory." })),
  limit: Type.Optional(Type.Integer({
    description: "Largest entry count. The default is 500.",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  })),
});

export type LsToolInput = Static<typeof lsParameters>;
export interface LsToolDetails { truncation?: ToolTruncation; entryLimitReached?: number }
export interface LsOperations {
  exists(path: string): Promise<boolean> | boolean;
  stat(path: string): Promise<{ isDirectory(): boolean }> | { isDirectory(): boolean };
  readdir(path: string): Promise<string[]> | string[];
}
export interface LsToolOptions { operations?: LsOperations }

const defaultLsOperations: LsOperations = {
  exists: pathExists,
  stat: fsStat,
  readdir: fsReaddir,
};

const schema: Record<string, JsonValue> = {
  type: "object",
  properties: {
    path: { type: "string", description: "Directory to inspect. The default is the current directory." },
    limit: {
      type: "integer",
      description: `Largest entry count. The default is ${DEFAULT_LIMIT}.`,
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
  },
};

export class LsTool implements HarnessTool {
  readonly recovery = { mode: "repeatable" } as const;
  readonly #operations: LsOperations | undefined;

  constructor(options: LsToolOptions = {}) {
    this.#operations = options.operations;
  }

  readonly definition = {
    name: "ls",
    description: `Show the direct children of a directory. Results include dotfiles and use alphabetical order. A directory name ends with '/'. Output stops at ${DEFAULT_LIMIT} entries or ${TOOL_MAX_BYTES / 1024} KiB.`,
    promptSnippet: "Show files and directories at one path",
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
    const requested = stringInput(object, "path", ".");
    const limit = safeIntegerInput(object, "limit", DEFAULT_LIMIT, 1);
    const directory = await resolveToolReadPath(requested, context.workspace.root);
    const operations = this.#operations ?? defaultLsOperations;
    if (!(await operations.exists(directory))) throw new Error(`Directory path does not exist: ${directory}`);
    if (!(await operations.stat(directory)).isDirectory()) {
      throw new Error(`Expected a directory but received: ${directory}`);
    }
    let entries: string[];
    try {
      entries = await operations.readdir(directory);
    } catch (error) {
      throw new Error(`Directory listing failed: ${errorMessage(error)}`);
    }
    entries.sort((left, right) => left.toLocaleLowerCase().localeCompare(right.toLocaleLowerCase()));
    const lines: string[] = [];
    let entryLimitReached = false;
    for (const entry of entries) {
      context.signal.throwIfAborted();
      if (lines.length >= limit) {
        entryLimitReached = true;
        break;
      }
      try {
        const suffix = (await operations.stat(join(directory, entry))).isDirectory() ? "/" : "";
        lines.push(`${entry}${suffix}`);
      } catch {
        // Entries that disappear or cannot be inspected are omitted.
      }
    }
    if (lines.length === 0) return { content: "(directory has no entries)", isError: false };
    const truncation = truncateToolHead(lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
    const notices: string[] = [];
    if (entryLimitReached) notices.push(`Returned the first ${limit} entries. Raise limit to ${limit * 2} for more`);
    if (truncation.truncated) notices.push(`${TOOL_MAX_BYTES / 1024}KB limit reached`);
    const content = `${truncation.content}${notices.length === 0 ? "" : `\n\n[${notices.join(". ")}]`}`;
    return {
      content,
      isError: false,
      metadata: {
        count: lines.length,
        path: displayToolPath(directory, context.workspace.root),
        truncated: entryLimitReached || truncation.truncated,
        ...(entryLimitReached ? { entryLimitReached: limit } : {}),
        ...(truncation.truncated ? { truncation: { ...truncation } } : {}),
      },
    };
  }
}

function lsDetails(result: ToolResult): LsToolDetails | undefined {
  const metadata = result.metadata as Record<string, unknown> | undefined;
  if (metadata?.truncation === undefined && typeof metadata?.entryLimitReached !== "number") return undefined;
  return {
    ...(metadata.truncation === undefined ? {} : { truncation: metadata.truncation as ToolTruncation }),
    ...(typeof metadata.entryLimitReached === "number" ? { entryLimitReached: metadata.entryLimitReached } : {}),
  };
}

export function createLsToolDefinition(
  cwd: string,
  options?: LsToolOptions,
): ToolDefinition<typeof lsParameters, LsToolDetails | undefined> {
  return createHarnessToolDefinition({
    cwd,
    tool: new LsTool(options),
    label: "ls",
    parameters: lsParameters,
    details: lsDetails,
  });
}

export function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsParameters, LsToolDetails | undefined> {
  return wrapToolDefinition(createLsToolDefinition(cwd, options));
}
