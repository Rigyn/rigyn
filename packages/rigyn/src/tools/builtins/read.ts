import type { JsonValue } from "../../core/json.js";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "../../extensions/direct.js";
import { preprocessImage, sniffImageMediaType } from "../../images/preprocess.js";
import { inspectImage } from "../image-info.js";
import { createHarnessToolDefinition, wrapToolDefinition, type AgentTool } from "../direct-tool.js";
import { assertSchema } from "../schema.js";
import { inputObject, numberInput, stringInput } from "../input.js";
import {
  displayToolPath,
  MAX_TOOL_SOURCE_FILE_BYTES,
  readFileSnapshotBounded,
  resolveToolReadPath,
  snapshotRegularFile,
} from "../paths.js";
import {
  formatBytes,
  TOOL_MAX_BYTES,
  TOOL_MAX_LINES,
  truncateToolHead,
  type ToolTruncation,
} from "../truncate.js";
import type { HarnessTool, ResourceClaim, ToolContext, ToolResult } from "../types.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

const readParameters = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type ReadToolInput = Static<typeof readParameters>;
export interface ReadToolDetails { truncation?: ToolTruncation }
export interface ReadOperations {
  readFile(path: string): Promise<Buffer>;
  access(path: string): Promise<void>;
  detectImageMimeType?(path: string): Promise<string | null | undefined>;
}
export interface ReadToolOptions { autoResizeImages?: boolean; operations?: ReadOperations }

const schema: Record<string, JsonValue> = {
  type: "object",
  required: ["path"],
  properties: {
    path: { type: "string", description: "Path to the file to read (relative or absolute)" },
    offset: { type: "number" },
    limit: { type: "number" },
  },
};

function textMetadata(
  path: string,
  offset: number,
  totalLines: number,
  truncation: ToolTruncation,
  nextOffset?: number,
): JsonValue {
  return {
    path,
    offset,
    totalLines,
    totalBytes: truncation.totalBytes,
    shownLines: truncation.outputLines,
    truncated: truncation.truncated || nextOffset !== undefined,
    ...(nextOffset === undefined ? {} : { nextOffset }),
    ...(truncation.truncated ? { truncation: { ...truncation } } : {}),
  };
}

export class ReadTool implements HarnessTool {
  readonly #autoResizeImages: boolean;
  readonly #operations: ReadOperations | undefined;

  constructor(options: ReadToolOptions = {}) {
    this.#autoResizeImages = options.autoResizeImages ?? true;
    this.#operations = options.operations;
  }

  readonly definition = {
    name: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${TOOL_MAX_LINES} lines or ${TOOL_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    promptSnippet: "Read file contents",
    promptGuidelines: ["Use read to examine files instead of cat or sed."],
    inputSchema: schema,
  };

  validate(input: JsonValue): void {
    assertSchema(schema, input);
  }

  async resources(input: JsonValue, context: ToolContext): Promise<ResourceClaim[]> {
    const requested = stringInput(inputObject(input), "path");
    return [{ kind: "file", key: await resolveToolReadPath(requested, context.workspace.root), mode: "read" }];
  }

  async execute(input: JsonValue, context: ToolContext): Promise<ToolResult> {
    this.validate(input);
    const object = inputObject(input);
    const requested = stringInput(object, "path");
    const absolute = await resolveToolReadPath(requested, context.workspace.root);
    const shownPath = displayToolPath(absolute, context.workspace.root);
    context.signal.throwIfAborted();
    let bytes: Buffer;
    let detected: string | undefined;
    if (this.#operations !== undefined) {
      await this.#operations.access(absolute);
      context.signal.throwIfAborted();
      bytes = await this.#operations.readFile(absolute);
      if (bytes.byteLength > MAX_TOOL_SOURCE_FILE_BYTES) {
        throw new Error(`File is too large to read safely (${formatBytes(bytes.byteLength)}; limit ${formatBytes(MAX_TOOL_SOURCE_FILE_BYTES)})`);
      }
      detected = (await this.#operations.detectImageMimeType?.(absolute)) ?? undefined;
    } else {
      await fsAccess(absolute, constants.R_OK);
      context.signal.throwIfAborted();
      const initial = await snapshotRegularFile(absolute);
      if (initial.snapshot.size > MAX_TOOL_SOURCE_FILE_BYTES) {
        throw new Error(`File is too large to read safely (${formatBytes(initial.snapshot.size)}; limit ${formatBytes(MAX_TOOL_SOURCE_FILE_BYTES)})`);
      }
      const loaded = await readFileSnapshotBounded(absolute, MAX_TOOL_SOURCE_FILE_BYTES);
      if (loaded.truncated) {
        throw new Error(`File is too large to read safely (${formatBytes(loaded.totalBytes)}; limit ${formatBytes(MAX_TOOL_SOURCE_FILE_BYTES)})`);
      }
      bytes = loaded.data;
      detected = sniffImageMediaType(bytes);
    }
    context.signal.throwIfAborted();

    if (detected !== undefined && IMAGE_TYPES.has(detected)) {
      const modelImageNote = context.activeModel !== undefined && !context.activeModel.input.includes("image")
        ? "[Current model does not support images. The image will be omitted from this request.]"
        : undefined;
      try {
        const image = await preprocessImage(bytes, {
          signal: context.signal,
          autoResize: this.#autoResizeImages,
        });
        const info = inspectImage(image.bytes);
        if (info === undefined) throw new Error("Processed image could not be validated");
        const notes = [`Read image file [${image.mediaType}]`];
        if (image.sourceMediaType !== image.mediaType) {
          notes.push(`[Image converted from ${image.sourceMediaType} to ${image.mediaType}.]`);
        }
        if (image.coordinates.resized) {
          notes.push(`[Image resized from ${image.coordinates.originalWidth}x${image.coordinates.originalHeight} to ${image.coordinates.width}x${image.coordinates.height}.]`);
        }
        if (modelImageNote !== undefined) notes.push(modelImageNote);
        return {
          content: notes.join("\n"),
          isError: false,
          images: [{ type: "image", mediaType: image.mediaType, data: Buffer.from(image.bytes).toString("base64") }],
          metadata: {
            path: shownPath,
            mediaType: image.mediaType,
            width: info.width,
            height: info.height,
            totalBytes: bytes.byteLength,
            resized: image.coordinates.resized,
          },
        };
      } catch (error) {
        const notes = [
          `Read image file [${detected}]`,
          `Image omitted: ${error instanceof Error ? error.message : String(error)}`,
          ...(modelImageNote === undefined ? [] : [modelImageNote]),
        ];
        return {
          content: notes.join("\n"),
          isError: false,
          metadata: { path: shownPath, mediaType: detected, totalBytes: bytes.byteLength, omitted: true },
        };
      }
    }

    const text = bytes.toString("utf8");
    const allLines = text.split("\n");
    const offset = numberInput(object, "offset", 1);
    const start = offset ? Math.max(0, offset - 1) : 0;
    if (start >= allLines.length) {
      throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
    }
    const requestedLimit = object.limit === undefined ? undefined : numberInput(object, "limit", 0);
    const end = requestedLimit === undefined ? allLines.length : Math.min(start + requestedLimit, allLines.length);
    const selected = allLines.slice(start, end).join("\n");
    const truncated = truncateToolHead(selected);
    const firstShown = start + 1;
    let content: string;
    let nextOffset: number | undefined;

    if (truncated.firstLineExceedsLimit) {
      const size = formatBytes(Buffer.byteLength(allLines[start] ?? "", "utf8"));
      content = `[Line ${firstShown} is ${size}, exceeds ${formatBytes(TOOL_MAX_BYTES)} limit. Use bash: sed -n '${firstShown}p' ${requested} | head -c ${TOOL_MAX_BYTES}]`;
    } else if (truncated.truncated) {
      const lastShown = firstShown + truncated.outputLines - 1;
      nextOffset = lastShown + 1;
      const byteNote = truncated.truncatedBy === "bytes" ? ` (${formatBytes(TOOL_MAX_BYTES)} limit)` : "";
      content = `${truncated.content}\n\n[Showing lines ${firstShown}-${lastShown} of ${allLines.length}${byteNote}. Use offset=${nextOffset} to continue.]`;
    } else if (requestedLimit !== undefined && end < allLines.length) {
      nextOffset = end + 1;
      content = `${truncated.content}\n\n[${allLines.length - end} more lines in file. Use offset=${nextOffset} to continue.]`;
    } else {
      content = truncated.content;
    }

    return {
      content,
      isError: false,
      metadata: textMetadata(shownPath, firstShown, allLines.length, truncated, nextOffset),
    };
  }
}

function readDetails(result: ToolResult): ReadToolDetails | undefined {
  const metadata = result.metadata as Record<string, unknown> | undefined;
  if (metadata?.truncation === undefined) return undefined;
  return { truncation: metadata.truncation as ToolTruncation };
}

export function createReadToolDefinition(
  cwd: string,
  options?: ReadToolOptions,
): ToolDefinition<typeof readParameters, ReadToolDetails | undefined> {
  return createHarnessToolDefinition({
    cwd,
    tool: new ReadTool(options),
    label: "read",
    parameters: readParameters,
    details: readDetails,
  });
}

export function createReadTool(
  cwd: string,
  options?: ReadToolOptions,
): AgentTool<typeof readParameters, ReadToolDetails | undefined> {
  return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
