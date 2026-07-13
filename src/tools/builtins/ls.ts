import { opendir, realpath } from "node:fs/promises";

import type { JsonValue } from "../../core/json.js";
import { assertSchema } from "../schema.js";
import { inputObject, numberInput, stringInput } from "../input.js";
import { displayToolPath, resolveToolReadPath } from "../paths.js";
import type { HarnessTool, ResourceClaim, ToolContext, ToolResult } from "../types.js";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 10_000;
const MAX_SCANNED_ENTRIES = 100_000;
const MAX_RESULT_BYTES = 240 * 1024;

const schema: Record<string, JsonValue> = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", maxLength: 4096, description: "Directory to list; defaults to the starting workspace." },
    limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Maximum entries; defaults to ${DEFAULT_LIMIT}.` },
  },
};

interface DirectoryEntry {
  directory: boolean;
  name: string;
}

function compareNames(left: DirectoryEntry, right: DirectoryEntry): number {
  const leftFolded = left.name.toLocaleLowerCase();
  const rightFolded = right.name.toLocaleLowerCase();
  if (leftFolded < rightFolded) return -1;
  if (leftFolded > rightFolded) return 1;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

export class LsTool implements HarnessTool {
  readonly definition = {
    name: "ls",
    description: "List one directory, including dotfiles, with '/' after directory names. Paths may be relative or absolute.",
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
    const limit = numberInput(object, "limit", DEFAULT_LIMIT);
    const directory = await realpath(await resolveToolReadPath(requested, context.workspace.root));
    const handle = await opendir(directory);
    const entries: DirectoryEntry[] = [];
    let scanTruncated = false;
    try {
      while (entries.length < MAX_SCANNED_ENTRIES) {
        context.signal.throwIfAborted();
        const entry = await handle.read();
        if (entry === null) break;
        entries.push({ name: entry.name, directory: entry.isDirectory() });
      }
      if (entries.length === MAX_SCANNED_ENTRIES) {
        context.signal.throwIfAborted();
        scanTruncated = await handle.read() !== null;
      }
    } finally {
      await handle.close();
    }

    entries.sort(compareNames);
    const selected = entries.slice(0, limit);
    const lines: string[] = [];
    let resultBytes = 0;
    let outputTruncated = false;
    for (const entry of selected) {
      const line = `${entry.name}${entry.directory ? "/" : ""}`;
      const bytes = Buffer.byteLength(line, "utf8") + (lines.length === 0 ? 0 : 1);
      if (resultBytes + bytes > MAX_RESULT_BYTES) {
        outputTruncated = true;
        break;
      }
      lines.push(line);
      resultBytes += bytes;
    }
    const truncated = scanTruncated || entries.length > limit || outputTruncated;
    return {
      content: lines.length === 0 ? "(empty directory)" : lines.join("\n"),
      isError: false,
      metadata: {
        count: lines.length,
        path: displayToolPath(directory, context.workspace.root),
        truncated,
        outputTruncated,
        ...(scanTruncated ? { scannedEntries: MAX_SCANNED_ENTRIES } : {}),
      },
    };
  }
}
