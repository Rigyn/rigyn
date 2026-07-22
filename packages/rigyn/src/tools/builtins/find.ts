import { realpath } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { Type, type Static } from "typebox";

import type { JsonValue } from "../../core/json.js";
import type { ToolDefinition } from "../../extensions/direct.js";
import { assertSchema } from "../schema.js";
import { createHarnessToolDefinition, wrapToolDefinition, type AgentTool } from "../direct-tool.js";
import { inputObject, numberInput, stringInput } from "../input.js";
import { displayToolPath, pathExists, resolveToolReadPath } from "../paths.js";
import { ensureExternalTool } from "../external-tools.js";
import { TOOL_MAX_BYTES, truncateToolHead, type ToolTruncation } from "../truncate.js";
import type { HarnessTool, ResourceClaim, ToolContext, ToolResult } from "../types.js";
import { walkWorkspace } from "../workspace-walker.js";

const DEFAULT_LIMIT = 1_000;
const MAX_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;

const findParameters = Type.Object({
  pattern: Type.String({ description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" }),
  path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

export type FindToolInput = Static<typeof findParameters>;
export interface FindToolDetails { truncation?: ToolTruncation; resultLimitReached?: number }
export interface FindOperations {
  exists(path: string): Promise<boolean> | boolean;
  glob(pattern: string, cwd: string, options: { ignore: string[]; limit: number }): Promise<string[]> | string[];
}
export interface FindToolOptions { operations?: FindOperations }

const schema: Record<string, JsonValue> = {
  type: "object",
  required: ["pattern"],
  properties: {
    pattern: { type: "string", description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" },
    path: { type: "string", description: "Directory to search in (default: current directory)" },
    limit: { type: "number", description: `Maximum number of results (default: ${DEFAULT_LIMIT})` },
  },
};

function portable(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

function assertCompatibleGlob(pattern: string): void {
  let escaped = false;
  let open = false;
  for (const character of pattern) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[" && !open) {
      open = true;
      continue;
    }
    if (character === "]" && open) open = false;
  }
  if (open) throw new Error("Invalid glob pattern: unclosed character class");
}

export class FindTool implements HarnessTool {
  readonly #operations: FindOperations | undefined;

  constructor(options: FindToolOptions = {}) {
    this.#operations = options.operations;
  }

  readonly definition = {
    name: "find",
    description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${TOOL_MAX_BYTES / 1024}KB (whichever is hit first).`,
    promptSnippet: "Find files by glob pattern (respects .gitignore)",
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
    assertCompatibleGlob(pattern);
    const requested = stringInput(object, "path", ".");
    const limit = numberInput(object, "limit", DEFAULT_LIMIT);
    const searchRoot = await resolveToolReadPath(requested, context.workspace.root);
    if (this.#operations !== undefined) {
      if (!(await this.#operations.exists(searchRoot))) throw new Error(`Path not found: ${searchRoot}`);
      context.signal.throwIfAborted();
      const results = await this.#operations.glob(pattern, searchRoot, {
        ignore: ["**/node_modules/**", "**/.git/**"],
        limit,
      });
      context.signal.throwIfAborted();
      const normalized = results.map((path) => portable(relative(searchRoot, path))).slice(0, limit);
      if (normalized.length === 0) return { content: "No files found matching pattern", isError: false };
      const resultLimitReached = results.length >= limit;
      const truncation = truncateToolHead(normalized.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
      const notices: string[] = [];
      if (resultLimitReached) notices.push(`${limit} results limit reached`);
      if (truncation.truncated) notices.push(`${TOOL_MAX_BYTES / 1024}KB limit reached`);
      return {
        content: `${truncation.content}${notices.length === 0 ? "" : `\n\n[${notices.join(". ")}]`}`,
        isError: false,
        metadata: {
          ...(resultLimitReached ? { resultLimitReached: limit } : {}),
          ...(truncation.truncated ? { truncation: { ...truncation } } : {}),
        },
      };
    }
    const executable = await ensureExternalTool("fd", { silent: true });
    if (executable === undefined) {
      const walked = await walkWorkspace(context.workspace.root, {
        path: requested,
        pattern,
        includeHidden: true,
        limit,
        signal: context.signal,
      });
      const matches = walked.entries.map((entry) => entry.path);
      if (matches.length === 0) return { content: "No files found matching pattern", isError: false };
      const resultLimitReached = walked.truncated || matches.length >= limit;
      const truncation = truncateToolHead(matches.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
      const notices: string[] = [];
      if (resultLimitReached) notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`);
      if (truncation.truncated) notices.push(`${TOOL_MAX_BYTES / 1024}KB limit reached`);
      return {
        content: `${truncation.content}${notices.length === 0 ? "" : `\n\n[${notices.join(". ")}]`}`,
        isError: false,
        metadata: {
          count: matches.length,
          path: displayToolPath(searchRoot, context.workspace.root),
          pattern,
          truncated: resultLimitReached || truncation.truncated,
          ...(resultLimitReached ? { resultLimitReached: limit } : {}),
          ...(truncation.truncated ? { truncation: { ...truncation } } : {}),
        },
      };
    }
    const argv = [executable, "--glob", "--color=never", "--hidden"];
    let insideGitRepository = false;
    for (let cursor = searchRoot; ; ) {
      if (await pathExists(join(cursor, ".git"))) {
        insideGitRepository = true;
        break;
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (!insideGitRepository) argv.push("--no-require-git");
    argv.push("--max-results", String(limit));
    let effectivePattern = pattern;
    if (pattern.includes("/")) {
      argv.push("--full-path");
      if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
        effectivePattern = `**/${pattern}`;
      }
    }
    argv.push("--", effectivePattern, searchRoot);
    const result = await context.runner.run({
      argv: argv as [string, ...string[]],
      cwd: context.workspace.root,
      outputLimitBytes: MAX_PROCESS_OUTPUT_BYTES,
    }, context.signal);
    if (context.signal.aborted || result.cancelled) throw new Error("Operation aborted");
    if (result.timedOut) throw new Error("fd timed out");
    const rawLines = result.stdout.toString("utf8").split("\n");
    if (result.exitCode !== 0 && rawLines.every((line) => line.trim() === "")) {
      const detail = result.stderr.toString("utf8").trim();
      throw new Error(detail === "" ? `fd exited with code ${String(result.exitCode)}` : detail);
    }
    const matches: string[] = [];
    for (const rawLine of rawLines) {
      const line = rawLine.replace(/\r$/u, "").trim();
      if (line === "") continue;
      const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
      let local = line.startsWith(searchRoot) ? line.slice(searchRoot.length + 1) : relative(searchRoot, line);
      if (hadTrailingSlash && !local.endsWith("/")) local += "/";
      matches.push(portable(local));
    }
    if (matches.length === 0) return { content: "No files found matching pattern", isError: false };
    const resultLimitReached = matches.length >= limit;
    const truncation = truncateToolHead(matches.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
    const notices: string[] = [];
    if (resultLimitReached) notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`);
    if (truncation.truncated) notices.push(`${TOOL_MAX_BYTES / 1024}KB limit reached`);
    return {
      content: `${truncation.content}${notices.length === 0 ? "" : `\n\n[${notices.join(". ")}]`}`,
      isError: false,
      metadata: {
        count: matches.length,
        path: displayToolPath(searchRoot, context.workspace.root),
        pattern,
        truncated: resultLimitReached || truncation.truncated,
        ...(resultLimitReached ? { resultLimitReached: limit } : {}),
        ...(truncation.truncated ? { truncation: { ...truncation } } : {}),
      },
    };
  }
}

function findDetails(result: ToolResult): FindToolDetails | undefined {
  const metadata = result.metadata as Record<string, unknown> | undefined;
  if (metadata?.truncation === undefined && typeof metadata?.resultLimitReached !== "number") return undefined;
  return {
    ...(metadata.truncation === undefined ? {} : { truncation: metadata.truncation as ToolTruncation }),
    ...(typeof metadata.resultLimitReached === "number" ? { resultLimitReached: metadata.resultLimitReached } : {}),
  };
}

export function createFindToolDefinition(
  cwd: string,
  options?: FindToolOptions,
): ToolDefinition<typeof findParameters, FindToolDetails | undefined> {
  return createHarnessToolDefinition({
    cwd,
    tool: new FindTool(options),
    label: "find",
    parameters: findParameters,
    details: findDetails,
  });
}

export function createFindTool(
  cwd: string,
  options?: FindToolOptions,
): AgentTool<typeof findParameters, FindToolDetails | undefined> {
  return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
