import { readFile as fsReadFile, realpath, stat as fsStat } from "node:fs/promises";
import { basename, relative, sep } from "node:path";
import { Type, type Static } from "typebox";

import type { JsonValue } from "../../core/json.js";
import type { ToolDefinition } from "../../extensions/direct.js";
import { assertSchema } from "../schema.js";
import { createHarnessToolDefinition, wrapToolDefinition, type AgentTool } from "../direct-tool.js";
import { booleanInput, inputObject, numberInput, stringInput } from "../input.js";
import { resolveToolReadPath } from "../paths.js";
import { resolveRipgrep } from "../ripgrep.js";
import { TOOL_MAX_BYTES, truncateToolHead, type ToolTruncation } from "../truncate.js";
import type { HarnessTool, ResourceClaim, ToolContext, ToolResult } from "../types.js";

const DEFAULT_LIMIT = 100;
const MAX_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_LINE_CHARACTERS = 500;

const grepParameters = Type.Object({
  pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
  glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
  context: Type.Optional(Type.Number({ description: "Number of lines before and after each match (default: 0)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export type GrepToolInput = Static<typeof grepParameters>;
export interface GrepToolDetails {
  truncation?: ToolTruncation;
  matchLimitReached?: number;
  linesTruncated?: boolean;
}
export interface GrepOperations {
  isDirectory(path: string): Promise<boolean> | boolean;
  readFile(path: string): Promise<string> | string;
}
export interface GrepToolOptions { operations?: GrepOperations }

const defaultGrepOperations: GrepOperations = {
  isDirectory: async (path) => (await fsStat(path)).isDirectory(),
  readFile: async (path) => await fsReadFile(path, "utf8"),
};

const schema: Record<string, JsonValue> = {
  type: "object",
  required: ["pattern"],
  properties: {
    pattern: { type: "string", description: "Search pattern (regex or literal string)" },
    path: { type: "string", description: "Directory or file to search (default: current directory)" },
    glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
    ignoreCase: { type: "boolean", description: "Match without letter-case sensitivity; defaults to false." },
    literal: { type: "boolean", description: "Treat pattern as literal text instead of a regex; defaults to false." },
    context: { type: "number", description: "Number of lines to show before and after each match (default: 0)" },
    limit: { type: "number", description: `Maximum number of matches to return (default: ${DEFAULT_LIMIT})` },
  },
};

interface GrepMatch {
  path: string;
  lineNumber: number;
  lineText?: string;
}

function portable(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

function shortenedLine(value: string): { text: string; truncated: boolean } {
  const normalized = value.replace(/\r?\n$/u, "").replaceAll("\r", "");
  if (normalized.length <= MAX_LINE_CHARACTERS) return { text: normalized, truncated: false };
  let text = normalized.slice(0, MAX_LINE_CHARACTERS);
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  return { text: `${text}... [truncated]`, truncated: true };
}

function displayPath(searchRoot: string, isDirectory: boolean, matchPath: string): string {
  if (!isDirectory) return basename(matchPath);
  const local = relative(searchRoot, matchPath);
  return local !== "" && !local.startsWith("..") ? portable(local) : basename(matchPath);
}

export class GrepTool implements HarnessTool {
  readonly #operations: GrepOperations | undefined;

  constructor(options: GrepToolOptions = {}) {
    this.#operations = options.operations;
  }

  readonly definition = {
    name: "grep",
    description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${TOOL_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${MAX_LINE_CHARACTERS} chars.`,
    promptSnippet: "Search file contents for patterns (respects .gitignore)",
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
    const glob = object.glob === undefined ? undefined : stringInput(object, "glob");
    const ignoreCase = booleanInput(object, "ignoreCase", false);
    const literal = booleanInput(object, "literal", false);
    const contextLines = Math.max(0, numberInput(object, "context", 0));
    const limit = Math.max(1, numberInput(object, "limit", DEFAULT_LIMIT));
    const searchRoot = await resolveToolReadPath(requested, context.workspace.root);
    const operations = this.#operations ?? defaultGrepOperations;
    let directory: boolean;
    try {
      directory = await operations.isDirectory(searchRoot);
    } catch {
      throw new Error(`Path not found: ${searchRoot}`);
    }
    const executable = await resolveRipgrep({
      excludedRoot: context.workspace.root,
    });
    if (executable === undefined) {
      throw new Error(
        `grep requires ripgrep; the bundled binary is unavailable for ${process.platform}-${process.arch} and rg was not found on PATH`,
      );
    }
    const matches: GrepMatch[] = [];
    const processController = new AbortController();
    const abortProcess = (): void => processController.abort(context.signal.reason);
    if (context.signal.aborted) abortProcess();
    else context.signal.addEventListener("abort", abortProcess, { once: true });
    const decoder = new TextDecoder();
    let buffered = "";
    let matchCount = 0;
    let matchLimitReached = false;
    const consumeLine = (line: string): void => {
      if (line.trim() === "" || matchCount >= limit) return;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
        };
        if (event.type !== "match") return;
        matchCount += 1;
        const path = event.data?.path?.text;
        const lineNumber = event.data?.line_number;
        if (typeof path === "string" && typeof lineNumber === "number") {
          const lineText = event.data?.lines?.text;
          matches.push({ path, lineNumber, ...(typeof lineText === "string" ? { lineText } : {}) });
        }
        if (matchCount >= limit) {
          matchLimitReached = true;
          processController.abort();
        }
      } catch {
        // Ignore malformed diagnostic records; ripgrep's exit status remains authoritative.
      }
    };
    const consumeChunk = (chunk: Uint8Array): void => {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    };
    let processResult;
    try {
      processResult = await context.runner.run({
        argv: [
          executable,
          "--json",
          "--line-number",
          "--color=never",
          "--hidden",
          ...(ignoreCase ? ["--ignore-case"] : []),
          ...(literal ? ["--fixed-strings"] : []),
          ...(glob === undefined ? [] : ["--glob", glob]),
          "--",
          pattern,
          searchRoot,
        ],
        cwd: context.workspace.root,
        outputLimitBytes: MAX_PROCESS_OUTPUT_BYTES,
        onOutput: (stream, chunk) => {
          if (stream === "stdout") consumeChunk(chunk);
        },
      }, processController.signal);
      buffered += decoder.decode();
      if (buffered !== "") consumeLine(buffered);
    } finally {
      context.signal.removeEventListener("abort", abortProcess);
    }
    if (context.signal.aborted) throw new Error("Operation aborted");
    if (processResult.timedOut) throw new Error("ripgrep timed out");
    if (processResult.cancelled && !matchLimitReached) throw new Error("Operation aborted");
    if (!matchLimitReached && processResult.signal !== null) {
      throw new Error(`ripgrep terminated by ${processResult.signal}`);
    }
    if (!matchLimitReached && processResult.exitCode !== 0 && processResult.exitCode !== 1) {
      const detail = processResult.stderr.toString("utf8").trim();
      throw new Error(detail === "" ? `ripgrep exited with code ${processResult.exitCode}` : detail);
    }

    if (matches.length === 0) {
      return {
        content: "No matches found",
        isError: false,
        metadata: { count: 0, truncated: false },
      };
    }

    const fileCache = new Map<string, string[]>();
    const output: string[] = [];
    let outputTruncated = false;
    let linesTruncated = false;
    for (const match of matches) {
      context.signal.throwIfAborted();
      const path = displayPath(searchRoot, directory, match.path);
      if (contextLines === 0 && match.lineText !== undefined) {
        const shortened = shortenedLine(match.lineText);
        linesTruncated ||= shortened.truncated;
        output.push(`${path}:${match.lineNumber}: ${shortened.text}`);
        continue;
      }
      let lines = fileCache.get(match.path);
      if (!fileCache.has(match.path)) {
        try {
          lines = (await operations.readFile(match.path))
            .replaceAll("\r\n", "\n")
            .replaceAll("\r", "\n")
            .split("\n");
        } catch {
          lines = [];
        }
        context.signal.throwIfAborted();
        fileCache.set(match.path, lines);
      }
      const fileLines = lines ?? [];
      if (fileLines.length === 0) {
        output.push(`${path}:${match.lineNumber}: (unable to read file)`);
        continue;
      }
      const start = contextLines > 0 ? Math.max(1, match.lineNumber - contextLines) : match.lineNumber;
      const end = contextLines > 0 ? Math.min(fileLines.length, match.lineNumber + contextLines) : match.lineNumber;
      for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
        const shortened = shortenedLine(fileLines[lineNumber - 1] ?? "");
        linesTruncated ||= shortened.truncated;
        const marker = lineNumber === match.lineNumber ? ":" : "-";
        output.push(`${path}${marker}${lineNumber}${marker} ${shortened.text}`);
      }
    }

    const truncation = truncateToolHead(output.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
    outputTruncated ||= truncation.truncated;
    const notices: string[] = [];
    if (matchLimitReached) notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
    if (truncation.truncated) notices.push(`${TOOL_MAX_BYTES / 1024}KB limit reached`);
    if (linesTruncated) notices.push(`Some lines truncated to ${MAX_LINE_CHARACTERS} chars. Use read tool to see full lines`);
    return {
      content: `${truncation.content}${notices.length === 0 ? "" : `\n\n[${notices.join(". ")}]`}`,
      isError: false,
      metadata: {
        count: matches.length,
        truncated: outputTruncated || matchLimitReached,
        outputTruncated,
        linesTruncated,
        engine: "ripgrep",
        ...(matchLimitReached ? { matchLimitReached: limit } : {}),
        ...(truncation.truncated ? { truncation: { ...truncation } } : {}),
      },
    };
  }
}

function grepDetails(result: ToolResult): GrepToolDetails | undefined {
  const metadata = result.metadata as Record<string, unknown> | undefined;
  if (
    metadata?.truncation === undefined
    && typeof metadata?.matchLimitReached !== "number"
    && metadata?.linesTruncated !== true
  ) return undefined;
  return {
    ...(metadata.truncation === undefined ? {} : { truncation: metadata.truncation as ToolTruncation }),
    ...(typeof metadata.matchLimitReached === "number" ? { matchLimitReached: metadata.matchLimitReached } : {}),
    ...(metadata.linesTruncated === true ? { linesTruncated: true } : {}),
  };
}

export function createGrepToolDefinition(
  cwd: string,
  options?: GrepToolOptions,
): ToolDefinition<typeof grepParameters, GrepToolDetails | undefined> {
  return createHarnessToolDefinition({
    cwd,
    tool: new GrepTool(options),
    label: "grep",
    parameters: grepParameters,
    details: grepDetails,
  });
}

export function createGrepTool(
  cwd: string,
  options?: GrepToolOptions,
): AgentTool<typeof grepParameters, GrepToolDetails | undefined> {
  return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
