import { extname } from "node:path";

import type { ImageBlock } from "../core/types.js";
import { imageCoordinateHint, preprocessImage, sniffImageMediaType } from "../images/index.js";
import { sensitiveWorkspacePath } from "../tools/sensitive-path.js";
import { MAX_IMAGE_BYTES } from "../providers/images.js";
import { readFileBounded, WorkspaceBoundary } from "../tools/paths.js";

const MAX_FILE_BYTES = MAX_IMAGE_BYTES;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"]);

export interface ExpandedPromptInput {
  text: string;
  images: ImageBlock[];
  files: string[];
}

export function combinePromptImages(
  transformed: boolean,
  submitted: readonly ImageBlock[],
  transformedImages: readonly ImageBlock[] | undefined,
  expanded: readonly ImageBlock[],
): ImageBlock[] {
  return [...(transformed ? transformedImages ?? [] : submitted), ...expanded];
}

function referencePattern(): RegExp {
  return /(?:^|\s)@(?:"([^"]+)"|([^\s@]+))/gu;
}

function xmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export async function expandPromptReferences(
  input: string,
  workspace: string,
  signal?: AbortSignal,
  autoResizeImages = true,
): Promise<ExpandedPromptInput> {
  const boundary = await WorkspaceBoundary.create(workspace);
  const references: Array<{ token: string; path: string; explicit: boolean }> = [];
  for (const match of input.matchAll(referencePattern())) {
    const path = match[1] ?? match[2];
    if (path !== undefined && path !== "") references.push({ token: match[0].trimStart(), path, explicit: match[1] !== undefined });
  }
  const unique = [...new Map(references.map((entry) => [entry.path, entry])).values()];
  const images: ImageBlock[] = [];
  const textFiles: string[] = [];
  const files: string[] = [];
  let total = 0;
  let outboundImageBytes = 0;
  for (const reference of unique) {
    signal?.throwIfAborted();
    if (sensitiveWorkspacePath(reference.path)) {
      throw new Error(`Sensitive files cannot be attached with @ references: ${reference.path}`);
    }
    let path: string;
    let local: string;
    try {
      if (reference.explicit) {
        const file = await boundary.readableFile(reference.path);
        path = file.path;
        local = file.relativePath;
      } else {
        path = await boundary.readable(reference.path);
        local = boundary.relative(reference.path);
      }
    } catch (error) {
      if (!reference.explicit && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (sensitiveWorkspacePath(local)) {
      throw new Error(`Sensitive files cannot be attached with @ references: ${local}`);
    }
    const bounded = await readFileBounded(path, MAX_FILE_BYTES);
    if (bounded.truncated) throw new Error(`Referenced file exceeds ${MAX_FILE_BYTES} bytes: ${reference.path}`);
    total += bounded.totalBytes;
    if (total > MAX_TOTAL_BYTES) throw new Error(`Referenced files exceed ${MAX_TOTAL_BYTES} total bytes`);
    files.push(local);
    if (sniffImageMediaType(bounded.data) !== undefined) {
      let processed;
      try {
        processed = await preprocessImage(bounded.data, {
          ...(signal === undefined ? {} : { signal }),
          autoResize: autoResizeImages,
        });
      } catch (error) {
        throw new Error(`Referenced image could not be processed safely: ${local}: ${error instanceof Error ? error.message : String(error)}`);
      }
      outboundImageBytes += processed.bytes.byteLength;
      if (outboundImageBytes > MAX_TOTAL_BYTES) throw new Error(`Processed image attachments exceed ${MAX_TOTAL_BYTES} total bytes`);
      images.push({ type: "image", mediaType: processed.mediaType, data: Buffer.from(processed.bytes).toString("base64") });
      const hint = imageCoordinateHint(processed.coordinates);
      if (hint !== undefined || processed.sourceMediaType !== processed.mediaType) {
        textFiles.push(`<file path="${xmlAttribute(local)}">${[
          processed.sourceMediaType === processed.mediaType ? undefined : `Converted ${processed.sourceMediaType} to ${processed.mediaType}.`,
          hint,
        ].filter((value): value is string => value !== undefined).join("\n")}</file>`);
      }
      continue;
    }
    if (IMAGE_EXTENSIONS.has(extname(local).toLowerCase())) {
      throw new Error(`Referenced image extension does not match valid PNG, JPEG, GIF, WebP, BMP, or TIFF content: ${local}`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bounded.data);
    } catch {
      throw new Error(`Referenced file is neither a supported image nor UTF-8 text: ${local}`);
    }
    textFiles.push(`<file path="${xmlAttribute(local)}">\n${text}\n</file>`);
  }
  return {
    text: [input, ...textFiles].filter((value) => value !== "").join("\n\n"),
    images,
    files,
  };
}
