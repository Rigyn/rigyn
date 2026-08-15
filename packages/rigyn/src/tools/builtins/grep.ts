import { realpath, stat as fsStat } from "node:fs/promises";
import { basename, relative, sep } from "node:path";
import { Type, type Static } from "typebox";

import type { JsonValue } from "../../core/json.js";
import type { ToolDefinition } from "../../extensions/direct.js";
import { assertSchema } from "../schema.js";
import { createHarnessToolDefinition, wrapToolDefinition, type AgentTool } from "../direct-tool.js";
import { booleanInput, inputObject, stringInput } from "../input.js";
import { safeIntegerInput } from "../integer-input.js";
import { resolveToolReadPath } from "../paths.js";
import { resolveRipgrep } from "../ripgrep.js";
import { TOOL_MAX_BYTES, truncateToolHead, type ToolTruncation } from "../truncate.js";
import type { HarnessTool, ResourceClaim, ToolContext, ToolResult } from "../types.js";

const DEFAULT_LIMIT = 100;
const MAX_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_LINE_CHARACTERS = 500;
const grepPathParameter = Type.Optional(
  Type.String({ description: "File or directory to inspect. The default is the current directory." }),
);
const grepGlobParameter = Type.Optional(
  Type.String({ description: "Optional file glob, such as '*.ts' or '**/*.spec.ts'." }),
);

const grepParameters = Type.Object({
  pattern: Type.String({ description: "Regular expression, or plain text when literal is true." }),
  path: grepPathParameter,
  glob: grepGlobParameter,
  ignoreCase: Type.Optional(Type.Boolean({ description: "Ignore letter case. The default is false." })),
  literal: Type.Optional(Type.Boolean({ description: "Use pattern as plain text. The default is false." })),
  context: Type.Optional(Type.Integer({
    description: "Lines to show before and after a match. The default is 0.",
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  })),
  limit: Type.Optional(Type.Integer({
    description: "Largest match count. The default is 100.",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  })),
});

export type GrepToolInput = Static<typeof grepParameters>;
export interface GrepToolDetails {
  truncation?: ToolTruncation;
  matchLimitReached?: number;
  linesTruncated?: boolean;
}
export interface GrepOperations {
  isDirectory(path: string): Promise<boolean> | boolean;
}
export interface GrepToolOptions { operations?: GrepOperations }

const defaultGrepOperations: GrepOperations = {
  isDirectory: async (path) => (await fsStat(path)).isDirectory(),
};

const schema: Record<string, JsonValue> = {
  type: "object",
  required: ["pattern"],
  properties: {
    pattern: { type: "string", description: "Regular expression, or plain text when literal is true." },
    path: { type: "string", description: "File or directory to inspect. The default is the current directory." },
    glob: { type: "string", description: "Optional file glob, such as '*.ts' or '**/*.spec.ts'." },
    ignoreCase: { type: "boolean", description: "Ignore letter case. The default is false." },
    literal: { type: "boolean", description: "Use pattern as plain text. The default is false." },
    context: {
      type: "integer",
      description: "Lines to show before and after a match. The default is 0.",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    limit: {
      type: "integer",
      description: `Largest match count. The default is ${DEFAULT_LIMIT}.`,
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
  },
};

interface GrepMatch {
  path: string;
  lineNumber: number;
  lineText?: string;
}

interface RipgrepLines {
  text?: string;
  bytes?: string;
}

interface RipgrepLine {
  text: string;
  byteLength: number;
}

function portable(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

function ripgrepLine(lines: RipgrepLines | undefined): RipgrepLine | undefined {
  if (typeof lines?.text === "string") {
    return { text: lines.text, byteLength: Buffer.byteLength(lines.text) };
  }
  if (typeof lines?.bytes !== "string") return undefined;
  const bytes = Buffer.from(lines.bytes, "base64");
  return { text: bytes.toString("utf8"), byteLength: bytes.length };
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
  readonly recovery = { mode: "repeatable" } as const;
  readonly #operations: GrepOperations | undefined;

  constructor(options: GrepToolOptions = {}) {
    this.#operations = options.operations;
  }

  readonly definition = {
    name: "grep",
    description: `Find text inside files. Results identify the file and line number. Git ignore rules apply. Output stops at ${DEFAULT_LIMIT} matches or ${TOOL_MAX_BYTES / 1024} KiB. Each displayed line stops at ${MAX_LINE_CHARACTERS} characters.`,
    promptSnippet: "Find text in files with Git ignore rules",
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
    const contextLines = safeIntegerInput(object, "context", 0, 0);
    const limit = safeIntegerInput(object, "limit", DEFAULT_LIMIT, 1);
    const searchRoot = await resolveToolReadPath(requested, context.workspace.root);
    const operations = this.#operations ?? defaultGrepOperations;
    let directory: boolean;
    try {
      directory = await operations.isDirectory(searchRoot);
    } catch {
      throw new Error(`Search path does not exist: ${searchRoot}`);
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
    let limitedContextComplete = false;
    let trailingContext: { path: string; lastLineNumber: number } | undefined;
    const contextRecords = new Map<string, Map<number, string>>();
    const lastContextRecords = new Map<string, {
      absoluteEnd: number;
      endsWithLineBreak: boolean;
      lineNumber: number;
    }>();
    const cacheContextRecord = (path: string, lineNumber: number, lineText: string): void => {
      let records = contextRecords.get(path);
      if (records === undefined) {
        records = new Map();
        contextRecords.set(path, records);
      }
      records.set(lineNumber, lineText);
    };
    const completeLimitedContext = (): void => {
      if (limitedContextComplete) return;
      limitedContextComplete = true;
      processController.abort();
    };
    const consumeLine = (line: string): void => {
      if (line.trim() === "" || limitedContextComplete) return;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          data?: {
            path?: { text?: string };
            line_number?: number;
            absolute_offset?: number;
            binary_offset?: number | null;
            lines?: RipgrepLines;
            stats?: { bytes_searched?: number };
          };
        };
        const path = event.data?.path?.text;
        if (event.type === "end") {
          if (typeof path === "string") {
            const lastRecord = lastContextRecords.get(path);
            if (
              event.data?.binary_offset === null
              && typeof event.data.stats?.bytes_searched === "number"
              && lastRecord?.absoluteEnd === event.data.stats.bytes_searched
              && lastRecord.endsWithLineBreak
            ) {
              cacheContextRecord(path, lastRecord.lineNumber + 1, "");
            }
            if (trailingContext?.path === path) completeLimitedContext();
          }
          return;
        }
        if (event.type !== "match" && event.type !== "context") return;
        const lineNumber = event.data?.line_number;
        const record = ripgrepLine(event.data?.lines);
        if (typeof path === "string" && typeof lineNumber === "number" && record !== undefined) {
          cacheContextRecord(path, lineNumber, record.text);
          if (typeof event.data?.absolute_offset === "number") {
            lastContextRecords.set(path, {
              absoluteEnd: event.data.absolute_offset + record.byteLength,
              endsWithLineBreak: record.text.endsWith("\n"),
              lineNumber,
            });
          }
        }
        if (event.type === "match" && matchCount < limit) {
          matchCount += 1;
          if (typeof path === "string" && typeof lineNumber === "number") {
            matches.push({ path, lineNumber, ...(record === undefined ? {} : { lineText: record.text }) });
          }
          if (matchCount >= limit) {
            matchLimitReached = true;
            if (contextLines > 0 && typeof path === "string" && typeof lineNumber === "number") {
              trailingContext = {
                path,
                lastLineNumber: Math.min(Number.MAX_SAFE_INTEGER, lineNumber + contextLines),
              };
            } else {
              completeLimitedContext();
            }
          }
        }
        if (typeof path === "string" && typeof lineNumber === "number") {
          if (trailingContext?.path === path && lineNumber >= trailingContext.lastLineNumber) {
            completeLimitedContext();
          }
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
          "--no-mmap",
          "--json",
          "--line-number",
          "--color=never",
          "--hidden",
          ...(ignoreCase ? ["--ignore-case"] : []),
          ...(literal ? ["--fixed-strings"] : []),
          ...(glob === undefined ? [] : ["--glob", glob]),
          ...(contextLines === 0 ? [] : ["--context", String(contextLines)]),
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
    if (context.signal.aborted) throw new Error("Content search was cancelled");
    if (processResult.timedOut) throw new Error("ripgrep timed out");
    if (processResult.cancelled && !matchLimitReached) throw new Error("Content search was cancelled");
    if (!matchLimitReached && processResult.signal !== null) {
      throw new Error(`ripgrep terminated by ${processResult.signal}`);
    }
    if (!matchLimitReached && processResult.exitCode !== 0 && processResult.exitCode !== 1) {
      const detail = processResult.stderr.toString("utf8").trim();
      throw new Error(detail === "" ? `ripgrep returned status ${processResult.exitCode}` : detail);
    }

    if (matches.length === 0) {
      return {
        content: "Search found no matching lines",
        isError: false,
        metadata: { count: 0, truncated: false },
      };
    }

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
      const records = contextRecords.get(match.path);
      if (records === undefined) {
        output.push(`${path}:${match.lineNumber}: (file context unavailable)`);
        continue;
      }
      const start = contextLines > 0 ? Math.max(1, match.lineNumber - contextLines) : match.lineNumber;
      const end = contextLines > 0
        ? Math.min(Number.MAX_SAFE_INTEGER, match.lineNumber + contextLines)
        : match.lineNumber;
      let rendered = false;
      for (const [lineNumber, lineText] of records) {
        if (lineNumber < start) continue;
        if (lineNumber > end) break;
        rendered = true;
        const shortened = shortenedLine(lineText);
        linesTruncated ||= shortened.truncated;
        const marker = lineNumber === match.lineNumber ? ":" : "-";
        output.push(`${path}${marker}${lineNumber}${marker} ${shortened.text}`);
      }
      if (!rendered) output.push(`${path}:${match.lineNumber}: (file context unavailable)`);
    }

    const truncation = truncateToolHead(output.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
    outputTruncated ||= truncation.truncated;
    const notices: string[] = [];
    if (matchLimitReached) notices.push(`Returned the first ${limit} matches. Raise limit to ${limit * 2} or narrow the search`);
    if (truncation.truncated) notices.push(`${TOOL_MAX_BYTES / 1024}KB limit reached`);
    if (linesTruncated) notices.push(`Long lines were shortened to ${MAX_LINE_CHARACTERS} characters. Read the file to inspect them fully`);
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
