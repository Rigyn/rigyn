import { createHash, randomInt } from "node:crypto";
import type { ImageBlock } from "../core/types.js";
import { MAX_IMAGE_BYTES, normalizeImageSource } from "../providers/images.js";
import { inspectImage, TOOL_IMAGE_MEDIA_TYPES, type ToolImageMediaType } from "../tools/image-info.js";

export type TerminalImageProtocol = "kitty" | "iterm2";

export interface TerminalCellDimensions {
  widthPx: number;
  heightPx: number;
}

export interface TranscriptImage {
  key: string;
  block: ImageBlock;
}

export interface ValidatedTerminalImage {
  key: string;
  fingerprint: string;
  imageId: number;
  mediaType: ToolImageMediaType;
  data: string;
  bytes: number;
  widthPx: number;
  heightPx: number;
}

export interface TerminalImagePlacement extends ValidatedTerminalImage {
  row: number;
  column: number;
  columns: number;
  rows: number;
}

export interface TerminalImageResolution {
  fallback: string;
  image?: Omit<TerminalImagePlacement, "row" | "column">;
}

export const MAX_TERMINAL_IMAGE_COUNT = 8;
export const MAX_TERMINAL_IMAGE_AGGREGATE_BYTES = 16 * 1024 * 1024;
export const MAX_TERMINAL_IMAGE_CHUNKS = 3_000;
export const KITTY_IMAGE_CHUNK_BYTES = 4_096;
export const ITERM_IMAGE_CHUNK_BYTES = 768 * 1024;
export const DEFAULT_TERMINAL_CELL_DIMENSIONS: TerminalCellDimensions = { widthPx: 9, heightPx: 18 };

const supportedMediaTypes = new Set<string>(TOOL_IMAGE_MEDIA_TYPES);
const canonicalBase64 = /^[a-z0-9+/]*={0,2}$/iu;
const MAX_IMAGE_ID = 0xffff_ffff;

function normalizedMediaType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function positiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function decodedByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor(value.length * 3 / 4) - padding;
}

function assertCanonicalBase64(value: string): number {
  if (
    value === ""
    || value.length % 4 === 1
    || !canonicalBase64.test(value)
    || /=/u.test(value.slice(0, -2))
  ) throw new Error("Terminal image data must be canonical base64 without whitespace");
  const bytes = decodedByteLength(value);
  if (bytes < 1 || bytes > MAX_IMAGE_BYTES) {
    throw new RangeError(`Terminal image data must encode 1 to ${MAX_IMAGE_BYTES} bytes`);
  }
  const normalized = Buffer.from(value, "base64").toString("base64").replace(/=+$/u, "");
  if (normalized !== value.replace(/=+$/u, "")) {
    throw new Error("Terminal image data must be canonical base64 without whitespace");
  }
  return bytes;
}

export function allocateTerminalImageId(random: (minimum: number, maximum: number) => number = randomInt): number {
  return positiveInteger(random(1, MAX_IMAGE_ID + 1), MAX_IMAGE_ID, "Terminal image ID");
}

export function validateTerminalImage(
  image: TranscriptImage,
  imageId = allocateTerminalImageId(),
): ValidatedTerminalImage {
  if (image === null || typeof image !== "object" || Array.isArray(image)) throw new Error("Terminal image must be an object");
  if (
    typeof image.key !== "string"
    || image.key === ""
    || Buffer.byteLength(image.key, "utf8") > 512
    || /[\u0000-\u001f\u007f-\u009f]/u.test(image.key)
  ) {
    throw new Error("Terminal image key must contain 1 to 512 printable UTF-8 bytes");
  }
  const source = normalizeImageSource(image.block, "Terminal");
  if (source.kind !== "base64" || image.block.url !== undefined) {
    throw new Error("Terminal images require embedded canonical data; remote URLs are never fetched");
  }
  if (!supportedMediaTypes.has(source.mediaType)) {
    throw new Error(`Terminal images support ${TOOL_IMAGE_MEDIA_TYPES.join(", ")}`);
  }
  const bytes = assertCanonicalBase64(source.data);
  const decoded = Buffer.from(source.data, "base64");
  const info = inspectImage(decoded);
  if (info === undefined || info.mediaType !== source.mediaType) {
    throw new Error("Terminal image content does not match its declared media type");
  }
  positiveInteger(imageId, MAX_IMAGE_ID, "Terminal image ID");
  return {
    key: image.key,
    fingerprint: createHash("sha256").update(decoded).digest("hex"),
    imageId,
    mediaType: info.mediaType,
    data: source.data,
    bytes,
    widthPx: info.width,
    heightPx: info.height,
  };
}

export function calculateTerminalImageCells(
  image: Pick<ValidatedTerminalImage, "widthPx" | "heightPx">,
  limits: { maxColumns: number; maxRows: number },
  cells: TerminalCellDimensions = DEFAULT_TERMINAL_CELL_DIMENSIONS,
): { columns: number; rows: number } {
  const maxColumns = positiveInteger(limits.maxColumns, 500, "Terminal image maximum columns");
  const maxRows = positiveInteger(limits.maxRows, 200, "Terminal image maximum rows");
  const cellWidth = positiveInteger(cells.widthPx, 10_000, "Terminal cell width");
  const cellHeight = positiveInteger(cells.heightPx, 10_000, "Terminal cell height");
  const width = positiveInteger(image.widthPx, 16_384, "Terminal image width");
  const height = positiveInteger(image.heightPx, 16_384, "Terminal image height");
  const scale = Math.min(maxColumns * cellWidth / width, maxRows * cellHeight / height);
  return {
    columns: Math.max(1, Math.min(maxColumns, Math.ceil(width * scale / cellWidth))),
    rows: Math.max(1, Math.min(maxRows, Math.ceil(height * scale / cellHeight))),
  };
}

export function terminalImageFallback(
  mediaType: string,
  dimensions?: { widthPx: number; heightPx: number },
  detail?: string,
): string {
  const safeMediaType = supportedMediaTypes.has(mediaType) ? mediaType : "image";
  const size = dimensions === undefined ? "" : ` ${dimensions.widthPx}x${dimensions.heightPx}`;
  const suffix = detail === undefined ? "" : ` — ${detail}`;
  return `[Image: ${safeMediaType}${size}${suffix}]`;
}

export class TerminalImageRegistry {
  readonly #validated = new Map<string, ValidatedTerminalImage>();

  #allocateImageId(): number {
    const used = new Set([...this.#validated.values()].map((image) => image.imageId));
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const imageId = allocateTerminalImageId();
      if (!used.has(imageId)) return imageId;
    }
    throw new Error("Unable to allocate a unique terminal image ID");
  }

  resolve(
    value: TranscriptImage,
    options: {
      protocol: TerminalImageProtocol | null;
      maxColumns: number;
      maxRows: number;
      cells?: TerminalCellDimensions;
    },
  ): TerminalImageResolution {
    let selected = this.#validated.get(value.key);
    try {
      if (selected === undefined) {
        selected = validateTerminalImage(value, this.#allocateImageId());
        this.#validated.set(value.key, selected);
      } else {
        if (
          value.block.type !== "image"
          || value.block.url !== undefined
          || value.block.data !== selected.data
          || normalizedMediaType(value.block.mediaType) !== selected.mediaType
        ) {
          selected = validateTerminalImage(value, this.#allocateImageId());
          this.#validated.set(value.key, selected);
        }
      }
    } catch {
      this.#validated.delete(value.key);
      return { fallback: terminalImageFallback(value.block.mediaType, undefined, "preview unavailable") };
    }
    const fallback = terminalImageFallback(selected.mediaType, selected);
    if (options.protocol === null) return { fallback };
    if (options.protocol === "kitty" && selected.mediaType !== "image/png") {
      return { fallback: terminalImageFallback(selected.mediaType, selected, "Kitty preview requires PNG") };
    }
    const size = calculateTerminalImageCells(selected, options, options.cells);
    return { fallback, image: { ...selected, ...size } };
  }

  prune(keys: ReadonlySet<string>): void {
    for (const key of this.#validated.keys()) if (!keys.has(key)) this.#validated.delete(key);
  }

  clear(): void {
    this.#validated.clear();
  }
}

function imageChunks(data: string, size: number): string[] {
  if (!Number.isSafeInteger(size) || size < 4 || size % 4 !== 0) throw new RangeError("Terminal image chunk size must be a positive multiple of four");
  const chunks: string[] = [];
  for (let offset = 0; offset < data.length; offset += size) chunks.push(data.slice(offset, offset + size));
  if (chunks.length < 1 || chunks.length > MAX_TERMINAL_IMAGE_CHUNKS) {
    throw new RangeError(`Terminal image transfer requires 1 to ${MAX_TERMINAL_IMAGE_CHUNKS} chunks`);
  }
  return chunks;
}

export function encodeKittyImage(image: Omit<TerminalImagePlacement, "row" | "column">): string {
  if (image.mediaType !== "image/png") throw new Error("Kitty direct image transfer accepts validated PNG data only");
  assertCanonicalBase64(image.data);
  const columns = positiveInteger(image.columns, 500, "Kitty image columns");
  const rows = positiveInteger(image.rows, 200, "Kitty image rows");
  const imageId = positiveInteger(image.imageId, MAX_IMAGE_ID, "Kitty image ID");
  const chunks = imageChunks(image.data, KITTY_IMAGE_CHUNK_BYTES);
  const firstParameters = `a=T,f=100,q=2,C=1,c=${columns},r=${rows},i=${imageId}`;
  if (chunks.length === 1) return `\u001b_G${firstParameters};${chunks[0]}\u001b\\`;
  return chunks.map((chunk, index) => {
    const more = index + 1 < chunks.length ? 1 : 0;
    return index === 0
      ? `\u001b_G${firstParameters},m=${more};${chunk}\u001b\\`
      : `\u001b_Gq=2,m=${more};${chunk}\u001b\\`;
  }).join("");
}

export function deleteKittyImage(imageId: number): string {
  return `\u001b_Ga=d,d=I,i=${positiveInteger(imageId, MAX_IMAGE_ID, "Kitty image ID")},q=2\u001b\\`;
}

export function encodeITerm2Image(image: Omit<TerminalImagePlacement, "row" | "column">): string {
  assertCanonicalBase64(image.data);
  const columns = positiveInteger(image.columns, 500, "iTerm image columns");
  const rows = positiveInteger(image.rows, 200, "iTerm image rows");
  const parameters = `inline=1;size=${image.bytes};width=${columns};height=${rows};preserveAspectRatio=1`;
  if (image.data.length <= ITERM_IMAGE_CHUNK_BYTES) {
    return `\u001b]1337;File=${parameters}:${image.data}\u0007`;
  }
  const chunks = imageChunks(image.data, ITERM_IMAGE_CHUNK_BYTES);
  return [
    `\u001b]1337;MultipartFile=${parameters}\u0007`,
    ...chunks.map((chunk) => `\u001b]1337;FilePart=${chunk}\u0007`),
    "\u001b]1337;FileEnd\u0007",
  ].join("");
}

export function encodeTerminalImage(
  protocol: TerminalImageProtocol,
  image: Omit<TerminalImagePlacement, "row" | "column">,
): string {
  return protocol === "kitty" ? encodeKittyImage(image) : encodeITerm2Image(image);
}

export function composeTerminalImageOutput(
  text: string,
  images: readonly TerminalImagePlacement[] | undefined,
  protocol: TerminalImageProtocol | null,
): string {
  if (images === undefined || images.length === 0) return text;
  if (protocol === null) throw new Error("Terminal image output requires an active image protocol");
  if (images.length > MAX_TERMINAL_IMAGE_COUNT) {
    throw new RangeError(`Terminal output accepts at most ${MAX_TERMINAL_IMAGE_COUNT} images`);
  }
  const lines = text === "" ? [] : text.split("\n");
  let aggregateBytes = 0;
  const ids = new Set<number>();
  for (const image of images) {
    validateTerminalImagePlacement(image);
    if (protocol === "kitty" && image.mediaType !== "image/png") {
      throw new Error("Kitty terminal output accepts validated PNG images only");
    }
    if (image.row + image.rows > lines.length || image.column + image.columns > 500) {
      throw new RangeError("Terminal image output exceeds its reserved rows or columns");
    }
    if (ids.has(image.imageId)) throw new Error("Terminal image IDs must be unique within an output block");
    ids.add(image.imageId);
    aggregateBytes += image.bytes;
    if (aggregateBytes > MAX_TERMINAL_IMAGE_AGGREGATE_BYTES) {
      throw new RangeError(`Terminal images exceed ${MAX_TERMINAL_IMAGE_AGGREGATE_BYTES} aggregate bytes`);
    }
    const selected = lines[image.row];
    if (selected === undefined) throw new RangeError("Terminal image output row is unavailable");
    const move = image.column === 0 ? "" : `\u001b[${image.column}C`;
    lines[image.row] = `\u001b7${move}${encodeTerminalImage(protocol, image)}\u001b8${selected}`;
  }
  return lines.join("\n");
}

export function trustedTerminalHyperlink(text: string, url: string): string {
  const target = trustedHyperlinkTarget(url);
  if (target === undefined) return text;
  return `\u001b]8;;${target}\u001b\\${text}\u001b]8;;\u001b\\`;
}

export function trustedHyperlinkTarget(value: string): string | undefined {
  if (value.length < 1 || value.length > 4_096 || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) return undefined;
    if (parsed.username !== "" || parsed.password !== "") return undefined;
    const normalized = parsed.href;
    return normalized.length <= 4_096 && !/[\u0000-\u0020\u007f-\u009f]/u.test(normalized) ? normalized : undefined;
  } catch {
    return undefined;
  }
}

export function validateTerminalImagePlacement(value: TerminalImagePlacement): void {
  const validated = validateTerminalImage(
    { key: value.key, block: { type: "image", mediaType: value.mediaType, data: value.data } },
    value.imageId,
  );
  if (
    validated.fingerprint !== value.fingerprint
    || validated.bytes !== value.bytes
    || validated.widthPx !== value.widthPx
    || validated.heightPx !== value.heightPx
  ) throw new Error("Terminal image placement metadata does not match its content");
  positiveInteger(value.row + 1, 200, "Terminal image row");
  positiveInteger(value.column + 1, 500, "Terminal image column");
  positiveInteger(value.rows, 200, "Terminal image rows");
  positiveInteger(value.columns, 500, "Terminal image columns");
}
