import { realpath, stat } from "node:fs/promises";
import { basename, dirname, relative, sep } from "node:path";

import type { JsonValue } from "../../core/json.js";
import { assertSchema } from "../schema.js";
import { booleanInput, inputObject, numberInput, stringInput } from "../input.js";
import { readFileBounded, resolveToolReadPath } from "../paths.js";
import { resolveRipgrep } from "../ripgrep.js";
import type { HarnessTool, ResourceClaim, ToolContext, ToolResult } from "../types.js";
import { walkWorkspace, type WorkspaceWalkEntry } from "../workspace-walker.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 5_000;
const MAX_CONTEXT_LINES = 100;
const MAX_SEARCH_FILES = 100_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_BYTES = 240 * 1024;
const MAX_LINE_CHARACTERS = 2_000;
const MAX_SEARCH_MS = 30_000;
const MAX_BATCH_FILES = 1_024;
const MAX_ARGUMENT_BYTES = process.platform === "win32" ? 24 * 1024 : 256 * 1024;

const schema: Record<string, JsonValue> = {
  type: "object",
  additionalProperties: false,
  required: ["pattern"],
  properties: {
    pattern: { type: "string", maxLength: 1024, description: "Regex, or exact text when literal is true." },
    path: { type: "string", maxLength: 4096, description: "File or directory to search; defaults to the starting workspace." },
    glob: { type: "string", minLength: 1, maxLength: 16 * 1024, description: "Optional file glob such as '**/*.ts'." },
    ignoreCase: { type: "boolean", description: "Match without letter-case sensitivity; defaults to false." },
    literal: { type: "boolean", description: "Treat pattern as literal text instead of a regex; defaults to false." },
    context: { type: "integer", minimum: 0, maximum: MAX_CONTEXT_LINES, description: "Lines before and after each match; defaults to 0." },
    limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Maximum matches; defaults to ${DEFAULT_LIMIT}.` },
  },
};

interface GrepMatch {
  absolutePath: string;
  lineNumber: number;
  lineText: string;
}

function portable(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

function checkActive(signal: AbortSignal, deadline: number): void {
  signal.throwIfAborted();
  if (Date.now() > deadline) throw new Error(`Grep timed out after ${MAX_SEARCH_MS}ms`);
}

function remainingTime(signal: AbortSignal, deadline: number): number {
  checkActive(signal, deadline);
  return Math.max(1, deadline - Date.now());
}

function batches(files: readonly WorkspaceWalkEntry[]): WorkspaceWalkEntry[][] {
  const result: WorkspaceWalkEntry[][] = [];
  let current: WorkspaceWalkEntry[] = [];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file.path, "utf8") + 1;
    if (current.length > 0 && (current.length >= MAX_BATCH_FILES || bytes + size > MAX_ARGUMENT_BYTES)) {
      result.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += size;
  }
  if (current.length > 0) result.push(current);
  return result;
}

function shortenedLine(value: string): { text: string; truncated: boolean } {
  const normalized = value.replace(/\r?\n$/u, "").replaceAll("\r", "");
  if (normalized.length <= MAX_LINE_CHARACTERS) return { text: normalized, truncated: false };
  let text = normalized.slice(0, MAX_LINE_CHARACTERS);
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  return { text: `${text}…`, truncated: true };
}

function displayPath(searchRoot: string, isDirectory: boolean, match: GrepMatch): string {
  if (!isDirectory) return basename(match.absolutePath);
  return portable(relative(searchRoot, match.absolutePath));
}

export class GrepTool implements HarnessTool {
  readonly definition = {
    name: "grep",
    description: "Search file contents by regex or literal text, with glob, case, and context controls. Paths may be relative or absolute.",
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
    const contextLines = numberInput(object, "context", 0);
    const limit = numberInput(object, "limit", DEFAULT_LIMIT);
    const deadline = Date.now() + MAX_SEARCH_MS;
    const searchRoot = await realpath(await resolveToolReadPath(requested, context.workspace.root));
    const directory = (await stat(searchRoot)).isDirectory();
    const scanRoot = directory ? searchRoot : dirname(searchRoot);
    const scanned = await walkWorkspace(scanRoot, {
      path: directory ? "." : basename(searchRoot),
      ...(glob === undefined ? {} : { pattern: glob }),
      limit: MAX_SEARCH_FILES,
      maxDepth: 64,
      includeHidden: true,
      signal: context.signal,
      timeoutMs: remainingTime(context.signal, deadline),
    });
    const files = scanned.entries.filter((entry) => entry.kind === "file");
    const executable = await resolveRipgrep({
      excludedRoot: context.workspace.root,
    });
    if (executable === undefined) {
      throw new Error(
        `grep requires ripgrep; the bundled binary is unavailable for ${process.platform}-${process.arch} and rg was not found on PATH`,
      );
    }
    if (files.length === 0 && !literal) {
      const validation = await context.runner.run({
        argv: [executable, "--json", ...(ignoreCase ? ["--ignore-case"] : []), "--", pattern],
        cwd: scanRoot,
        env: { LC_ALL: "C" },
        stdin: "",
        timeoutMs: remainingTime(context.signal, deadline),
        outputLimitBytes: 64 * 1024,
      }, context.signal);
      checkActive(context.signal, deadline);
      if (validation.timedOut) throw new Error("ripgrep timed out");
      if (validation.cancelled) throw new Error("ripgrep was cancelled");
      if (validation.signal !== null) throw new Error(`ripgrep terminated by ${validation.signal}`);
      if (validation.exitCode !== 0 && validation.exitCode !== 1) {
        const detail = validation.stderr.toString("utf8").trim().slice(0, 2_000);
        throw new Error(detail === ""
          ? `ripgrep failed with exit code ${validation.exitCode}`
          : `ripgrep failed: ${detail}`);
      }
    }

    const matches: GrepMatch[] = [];
    let processTruncated = false;
    outer: for (const batch of batches(files)) {
      checkActive(context.signal, deadline);
      const allowed = new Map(batch.map((entry) => [portable(entry.path), entry]));
      const result = await context.runner.run({
        argv: [
          executable,
          "--json",
          "--line-number",
          "--no-ignore",
          "--no-messages",
          "--sort",
          "path",
          "--max-filesize",
          `${MAX_FILE_BYTES}`,
          ...(ignoreCase ? ["--ignore-case"] : []),
          ...(literal ? ["--fixed-strings"] : []),
          "--",
          pattern,
          ...batch.map((entry) => entry.path),
        ],
        cwd: scanRoot,
        env: { LC_ALL: "C" },
        timeoutMs: remainingTime(context.signal, deadline),
        outputLimitBytes: MAX_PROCESS_OUTPUT_BYTES,
      }, context.signal);
      checkActive(context.signal, deadline);
      if (result.timedOut) throw new Error("ripgrep timed out");
      if (result.cancelled) throw new Error("ripgrep was cancelled");
      if (result.signal !== null) throw new Error(`ripgrep terminated by ${result.signal}`);
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        const detail = result.stderr.toString("utf8").trim().slice(0, 2_000);
        throw new Error(detail === "" ? `ripgrep failed with exit code ${result.exitCode}` : `ripgrep failed: ${detail}`);
      }
      if (result.stdoutBytes > result.stdout.length) processTruncated = true;
      for (const line of result.stdout.toString("utf8").split("\n")) {
        checkActive(context.signal, deadline);
        if (line === "") continue;
        try {
          const event = JSON.parse(line) as {
            type?: string;
            data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
          };
          if (event.type !== "match") continue;
          const rawPath = event.data?.path?.text;
          const lineNumber = event.data?.line_number;
          if (typeof rawPath !== "string" || !Number.isSafeInteger(lineNumber) || (lineNumber ?? 0) < 1) continue;
          const entry = allowed.get(portable(rawPath).replace(/^\.\//u, ""));
          if (entry === undefined) continue;
          if (matches.length >= limit) break outer;
          matches.push({
            absolutePath: entry.absolutePath,
            lineNumber: lineNumber ?? 1,
            lineText: event.data?.lines?.text ?? "",
          });
        } catch {
          processTruncated = true;
        }
      }
    }

    if (matches.length === 0) {
      return {
        content: "No matches found",
        isError: false,
        metadata: { count: 0, truncated: scanned.truncated || processTruncated },
      };
    }

    const fileCache = new Map<string, string[] | undefined>();
    const output: string[] = [];
    let outputBytes = 0;
    let outputTruncated = false;
    let linesTruncated = false;
    let contextUnavailable = false;
    const append = (value: string): boolean => {
      const bytes = Buffer.byteLength(value, "utf8") + (output.length === 0 ? 0 : 1);
      if (outputBytes + bytes > MAX_RESULT_BYTES) {
        outputTruncated = true;
        return false;
      }
      output.push(value);
      outputBytes += bytes;
      return true;
    };
    for (const match of matches) {
      checkActive(context.signal, deadline);
      const path = displayPath(searchRoot, directory, match);
      if (contextLines === 0) {
        const shortened = shortenedLine(match.lineText);
        linesTruncated ||= shortened.truncated;
        if (!append(`${path}:${match.lineNumber}: ${shortened.text}`)) break;
        continue;
      }
      let lines = fileCache.get(match.absolutePath);
      if (!fileCache.has(match.absolutePath)) {
        try {
          const contents = await readFileBounded(match.absolutePath, MAX_FILE_BYTES);
          lines = contents.truncated || contents.data.includes(0)
            ? undefined
            : contents.data.toString("utf8").replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
        } catch {
          lines = undefined;
        }
        context.signal.throwIfAborted();
        fileCache.set(match.absolutePath, lines);
      }
      if (lines === undefined) {
        contextUnavailable = true;
        const shortened = shortenedLine(match.lineText);
        linesTruncated ||= shortened.truncated;
        if (!append(`${path}:${match.lineNumber}: ${shortened.text}`)) break;
        continue;
      }
      const start = Math.max(1, match.lineNumber - contextLines);
      const end = Math.min(lines.length, match.lineNumber + contextLines);
      for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
        const shortened = shortenedLine(lines[lineNumber - 1] ?? "");
        linesTruncated ||= shortened.truncated;
        const marker = lineNumber === match.lineNumber ? ":" : "-";
        if (!append(`${path}${marker}${lineNumber}${marker} ${shortened.text}`)) break;
      }
      if (outputTruncated) break;
    }

    return {
      content: output.join("\n"),
      isError: false,
      metadata: {
        count: matches.length,
        truncated: scanned.truncated || processTruncated || outputTruncated || matches.length >= limit,
        outputTruncated,
        linesTruncated,
        contextUnavailable,
        engine: "ripgrep",
      },
    };
  }
}
