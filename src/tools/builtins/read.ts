import type { JsonValue } from "../../core/json.js";
import { preprocessImage, sniffImageMediaType } from "../../images/preprocess.js";
import { inspectImage } from "../image-info.js";
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

const schema: Record<string, JsonValue> = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 4096 },
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

  constructor(options: { autoResizeImages?: boolean } = {}) {
    this.#autoResizeImages = options.autoResizeImages ?? true;
  }

  readonly definition = {
    name: "read",
    description: `Read a text file or image. Text output is limited to ${TOOL_MAX_LINES} lines or ${TOOL_MAX_BYTES / 1024}KB; use offset/limit to continue. Source files larger than ${formatBytes(MAX_TOOL_SOURCE_FILE_BYTES)} are rejected. Paths may be relative or absolute.`,
    promptSnippet: "Read bounded text ranges and validated images from relative or absolute paths",
    promptGuidelines: [
      "When read reports truncated text, continue with offset and limit until the relevant range is inspected.",
    ],
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
    const initial = await snapshotRegularFile(absolute);
    if (initial.snapshot.size > MAX_TOOL_SOURCE_FILE_BYTES) {
      throw new Error(`File is too large to read safely (${formatBytes(initial.snapshot.size)}; limit ${formatBytes(MAX_TOOL_SOURCE_FILE_BYTES)})`);
    }
    const loaded = await readFileSnapshotBounded(absolute, MAX_TOOL_SOURCE_FILE_BYTES);
    if (loaded.truncated) {
      throw new Error(`File is too large to read safely (${formatBytes(loaded.totalBytes)}; limit ${formatBytes(MAX_TOOL_SOURCE_FILE_BYTES)})`);
    }
    const bytes = loaded.data;
    context.signal.throwIfAborted();

    const detected = sniffImageMediaType(bytes);
    if (detected !== undefined && IMAGE_TYPES.has(detected)) {
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
        return {
          content: `Read image file [${detected}]\nImage omitted: ${error instanceof Error ? error.message : String(error)}`,
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
