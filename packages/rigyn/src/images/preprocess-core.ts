import { createRequire } from "node:module";
import type sharp from "sharp";
import type { SharpOptions } from "sharp";

import { inspectImage, MAX_TOOL_IMAGE_PIXELS } from "../tools/image-info.js";

export const MAX_PREPROCESS_INPUT_BYTES = 32 * 1024 * 1024;
export const DEFAULT_PREPROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_PREPROCESS_MAX_WIDTH = 2_000;
export const DEFAULT_PREPROCESS_MAX_HEIGHT = 2_000;

export type SniffedImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/bmp"
  | "image/tiff";

export interface ImagePreprocessOptions {
  /** Preserve dimensions up to the compiled 16384-pixel edge guardrail. */
  autoResize?: boolean;
  maxWidth?: number;
  maxHeight?: number;
  maxOutputBytes?: number;
  maxInputPixels?: number;
  jpegQuality?: number;
}

export interface ImageCoordinateMetadata {
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  orientationApplied: boolean;
  resized: boolean;
  converted: boolean;
}

export interface PreprocessedImage {
  bytes: Uint8Array;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  sourceMediaType: SniffedImageMediaType;
  coordinates: ImageCoordinateMetadata;
}

interface NormalizedOptions {
  maxWidth: number;
  maxHeight: number;
  maxOutputBytes: number;
  maxInputPixels: number;
  jpegQuality: number;
}

interface EncodedCandidate {
  bytes: Buffer;
  mediaType: PreprocessedImage["mediaType"];
}

interface BmpDecodeResult {
  data: Buffer;
  width: number;
  height: number;
  bitPP: number;
}

type BmpDecoder = (input: Buffer) => BmpDecodeResult;

const require = createRequire(import.meta.url);
const decodeBmp = (require("bmp-js") as { decode: BmpDecoder }).decode;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function startsWith(data: Uint8Array, signature: Uint8Array): boolean {
  if (data.byteLength < signature.byteLength) return false;
  for (let index = 0; index < signature.byteLength; index += 1) {
    if (data[index] !== signature[index]) return false;
  }
  return true;
}

function ascii(data: Uint8Array, start: number, end: number): string {
  if (data.byteLength < end) return "";
  return Buffer.from(data.buffer, data.byteOffset + start, end - start).toString("ascii");
}

/** Identifies formats that the bounded converter deliberately accepts. */
export function sniffImageMediaType(data: Uint8Array): SniffedImageMediaType | undefined {
  if (startsWith(data, PNG_SIGNATURE)) return "image/png";
  if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  const gif = ascii(data, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  if (ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 12) === "WEBP") return "image/webp";
  if (ascii(data, 0, 2) === "BM") return "image/bmp";
  if (
    data.byteLength >= 4
    && ((data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2a && data[3] === 0x00)
      || (data[0] === 0x4d && data[1] === 0x4d && data[2] === 0x00 && data[3] === 0x2a))
  ) return "image/tiff";
  return undefined;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return selected;
}

function normalizeOptions(options: ImagePreprocessOptions | undefined): NormalizedOptions {
  if (options?.autoResize !== undefined && typeof options.autoResize !== "boolean") {
    throw new TypeError("autoResize must be a boolean");
  }
  const defaultMaxWidth = options?.autoResize === false ? 16_384 : DEFAULT_PREPROCESS_MAX_WIDTH;
  const defaultMaxHeight = options?.autoResize === false ? 16_384 : DEFAULT_PREPROCESS_MAX_HEIGHT;
  return {
    maxWidth: boundedInteger(options?.maxWidth, defaultMaxWidth, 1, 16_384, "Maximum image width"),
    maxHeight: boundedInteger(options?.maxHeight, defaultMaxHeight, 1, 16_384, "Maximum image height"),
    maxOutputBytes: boundedInteger(
      options?.maxOutputBytes,
      DEFAULT_PREPROCESS_OUTPUT_BYTES,
      256,
      8 * 1024 * 1024,
      "Maximum processed image bytes",
    ),
    maxInputPixels: boundedInteger(
      options?.maxInputPixels,
      MAX_TOOL_IMAGE_PIXELS,
      1,
      MAX_TOOL_IMAGE_PIXELS,
      "Maximum input image pixels",
    ),
    jpegQuality: boundedInteger(options?.jpegQuality, 85, 30, 95, "JPEG quality"),
  };
}

function targetDimensions(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function orientedDimensions(width: number, height: number, orientation: number | undefined): { width: number; height: number } {
  return orientation !== undefined && orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height };
}

function providerMediaType(format: string | undefined): PreprocessedImage["mediaType"] | undefined {
  if (format === "png") return "image/png";
  if (format === "jpeg" || format === "jpg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  if (format === "gif") return "image/gif";
  return undefined;
}

async function encodeCandidates(
  sharpFactory: typeof sharp,
  input: Uint8Array,
  inputOptions: SharpOptions,
  width: number,
  height: number,
  hasAlpha: boolean,
  jpegQuality: number,
  limitInputPixels: number,
): Promise<EncodedCandidate[]> {
  const base = sharpFactory(input, { ...inputOptions, failOn: "warning", limitInputPixels, sequentialRead: true })
    .autoOrient()
    .resize({ width, height, fit: "fill", kernel: sharpFactory.kernel.lanczos3 });
  const candidates: EncodedCandidate[] = [];
  const png = await base.clone().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  candidates.push({ bytes: png, mediaType: "image/png" });
  if (!hasAlpha) {
    for (const quality of [...new Set([jpegQuality, 75, 60, 45])]) {
      candidates.push({
        bytes: await base.clone().jpeg({ quality, mozjpeg: true }).toBuffer(),
        mediaType: "image/jpeg",
      });
    }
  }
  for (const quality of [85, 70, 55]) {
    candidates.push({
      bytes: await base.clone().webp({ quality, alphaQuality: 90, effort: 4 }).toBuffer(),
      mediaType: "image/webp",
    });
  }
  return candidates;
}

function bmpRawInput(input: Uint8Array, maxInputPixels: number): { data: Uint8Array; options: SharpOptions } {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.byteLength < 54 || bytes.readUInt32LE(14) !== 40) {
    throw new Error("BMP must use a complete 40-byte information header");
  }
  const width = bytes.readInt32LE(18);
  const signedHeight = bytes.readInt32LE(22);
  const height = Math.abs(signedHeight);
  const planes = bytes.readUInt16LE(26);
  const bits = bytes.readUInt16LE(28);
  const compression = bytes.readUInt32LE(30);
  const pixelOffset = bytes.readUInt32LE(10);
  const declaredSize = bytes.readUInt32LE(2);
  if (width < 1 || height < 1 || planes !== 1 || ![1, 4, 8, 15, 16, 24, 32].includes(bits)) {
    throw new Error("BMP dimensions, planes, or bit depth are invalid");
  }
  if (width * height > maxInputPixels) throw new RangeError(`Image exceeds ${maxInputPixels} input pixels`);
  if (!((compression === 0) || (compression === 3 && (bits === 16 || bits === 32)))) {
    throw new Error("Compressed BMP clipboard images are not accepted");
  }
  if (pixelOffset < 54 || pixelOffset >= bytes.byteLength || (declaredSize !== 0 && declaredSize > bytes.byteLength)) {
    throw new Error("BMP pixel offset or declared size is invalid");
  }
  if (compression === 0) {
    const rowBytes = Math.ceil(width * bits / 32) * 4;
    if (pixelOffset + rowBytes * height > bytes.byteLength) throw new Error("BMP pixel data is truncated");
  }
  const decoded = decodeBmp(bytes);
  if (decoded.width !== width || decoded.height !== height || decoded.data.byteLength !== width * height * 4) {
    throw new Error("BMP decoder returned inconsistent dimensions");
  }
  let meaningfulAlpha = false;
  if (bits === 32) {
    for (let offset = 0; offset < decoded.data.byteLength; offset += 4) {
      if (decoded.data[offset] !== 0) {
        meaningfulAlpha = true;
        break;
      }
    }
  }
  const rgba = Buffer.allocUnsafe(decoded.data.byteLength);
  for (let offset = 0; offset < decoded.data.byteLength; offset += 4) {
    rgba[offset] = decoded.data[offset + 3]!;
    rgba[offset + 1] = decoded.data[offset + 2]!;
    rgba[offset + 2] = decoded.data[offset + 1]!;
    rgba[offset + 3] = meaningfulAlpha ? decoded.data[offset]! : 0xff;
  }
  return { data: rgba, options: { raw: { width, height, channels: 4 } } };
}

function validateInputBytes(input: Uint8Array): void {
  if (!(input instanceof Uint8Array) || input.byteLength === 0) throw new Error("Image input is empty");
  if (input.byteLength > MAX_PREPROCESS_INPUT_BYTES) {
    throw new RangeError(`Image input exceeds ${MAX_PREPROCESS_INPUT_BYTES} bytes`);
  }
}

/** Runs only inside the image worker (or a focused unit test). */
export async function preprocessImageInProcess(
  input: Uint8Array,
  options?: ImagePreprocessOptions,
): Promise<PreprocessedImage> {
  validateInputBytes(input);
  const selected = normalizeOptions(options);
  const sourceMediaType = sniffImageMediaType(input);
  if (sourceMediaType === undefined) throw new Error("Clipboard data is not a recognized image format");
  const { default: sharpFactory } = await import("sharp");

  const prepared = sourceMediaType === "image/bmp"
    ? bmpRawInput(input, selected.maxInputPixels)
    : { data: input, options: {} as SharpOptions };

  const metadata = await sharpFactory(prepared.data, {
    ...prepared.options,
    failOn: "warning",
    limitInputPixels: selected.maxInputPixels,
    sequentialRead: true,
  }).metadata();
  if (metadata.width === undefined || metadata.height === undefined || metadata.width < 1 || metadata.height < 1) {
    throw new Error("Image dimensions are unavailable");
  }
  if (metadata.width * metadata.height > selected.maxInputPixels) {
    throw new RangeError(`Image exceeds ${selected.maxInputPixels} input pixels`);
  }
  const orientation = metadata.orientation;
  const visual = orientedDimensions(metadata.width, metadata.height, orientation);
  const target = targetDimensions(visual.width, visual.height, selected.maxWidth, selected.maxHeight);
  const orientationApplied = orientation !== undefined && orientation >= 2 && orientation <= 8;
  const sourceProviderType = sourceMediaType === "image/bmp" ? undefined : providerMediaType(metadata.format);

  if (
    sourceProviderType !== undefined
    && !orientationApplied
    && target.width === visual.width
    && target.height === visual.height
    && input.byteLength <= selected.maxOutputBytes
  ) {
    const info = inspectImage(input);
    if (info === undefined || info.mediaType !== sourceProviderType) throw new Error("Image content does not match its decoded format");
    return {
      bytes: new Uint8Array(input),
      mediaType: sourceProviderType,
      sourceMediaType,
      coordinates: {
        originalWidth: visual.width,
        originalHeight: visual.height,
        width: visual.width,
        height: visual.height,
        scaleX: 1,
        scaleY: 1,
        orientationApplied: false,
        resized: false,
        converted: false,
      },
    };
  }

  let width = target.width;
  let height = target.height;
  let selectedCandidate: EncodedCandidate | undefined;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidates = await encodeCandidates(
      sharpFactory,
      prepared.data,
      prepared.options,
      width,
      height,
      metadata.hasAlpha === true,
      selected.jpegQuality,
      selected.maxInputPixels,
    );
    selectedCandidate = candidates.find((candidate) => candidate.bytes.byteLength <= selected.maxOutputBytes);
    if (selectedCandidate !== undefined) break;
    const smallest = candidates.reduce((best, candidate) => candidate.bytes.byteLength < best.bytes.byteLength ? candidate : best);
    if (width === 1 && height === 1) break;
    const estimated = Math.sqrt(selected.maxOutputBytes / smallest.bytes.byteLength) * 0.9;
    const scale = Math.max(0.5, Math.min(0.82, Number.isFinite(estimated) ? estimated : 0.75));
    const nextWidth = width === 1 ? 1 : Math.max(1, Math.floor(width * scale));
    const nextHeight = height === 1 ? 1 : Math.max(1, Math.floor(height * scale));
    if (nextWidth === width && nextHeight === height) break;
    width = nextWidth;
    height = nextHeight;
  }
  if (selectedCandidate === undefined) {
    throw new Error(`Image could not be reduced below ${selected.maxOutputBytes} bytes`);
  }
  const info = inspectImage(selectedCandidate.bytes);
  if (info === undefined || info.mediaType !== selectedCandidate.mediaType || info.width !== width || info.height !== height) {
    throw new Error("Processed image failed content validation");
  }
  return {
    bytes: new Uint8Array(selectedCandidate.bytes),
    mediaType: selectedCandidate.mediaType,
    sourceMediaType,
    coordinates: {
      originalWidth: visual.width,
      originalHeight: visual.height,
      width,
      height,
      scaleX: visual.width / width,
      scaleY: visual.height / height,
      orientationApplied,
      resized: width !== visual.width || height !== visual.height,
      converted: sourceProviderType !== selectedCandidate.mediaType || orientationApplied,
    },
  };
}
