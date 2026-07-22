import { Worker } from "node:worker_threads";

import { inspectImage } from "../tools/image-info.js";
import {
  MAX_PREPROCESS_INPUT_BYTES,
  sniffImageMediaType,
  type ImageCoordinateMetadata,
  type ImagePreprocessOptions,
  type PreprocessedImage,
} from "./preprocess-core.js";

export {
  DEFAULT_PREPROCESS_MAX_HEIGHT,
  DEFAULT_PREPROCESS_MAX_WIDTH,
  DEFAULT_PREPROCESS_OUTPUT_BYTES,
  MAX_PREPROCESS_INPUT_BYTES,
  sniffImageMediaType,
} from "./preprocess-core.js";
export type {
  ImageCoordinateMetadata,
  ImagePreprocessOptions,
  PreprocessedImage,
  SniffedImageMediaType,
} from "./preprocess-core.js";

export interface ImagePreprocessExecutionOptions extends ImagePreprocessOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

type WorkerResponse =
  | { ok: true; image: PreprocessedImage }
  | { ok: false; error: string };

function workerResponse(value: unknown): value is WorkerResponse {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.ok === true ? record.image !== undefined : record.ok === false && typeof record.error === "string";
}

function executionTimeout(value: number | undefined): number {
  const selected = value ?? 15_000;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 60_000) {
    throw new RangeError("Image preprocessing timeout must be an integer from 1 to 60000 milliseconds");
  }
  return selected;
}

function validateWorkerImage(image: PreprocessedImage): PreprocessedImage {
  if (!(image.bytes instanceof Uint8Array) || image.bytes.byteLength < 1 || image.bytes.byteLength > 8 * 1024 * 1024) {
    throw new Error("Image preprocessing worker returned invalid bytes");
  }
  const sniffed = sniffImageMediaType(image.bytes);
  const info = inspectImage(image.bytes);
  if (info === undefined || sniffed !== image.mediaType || info.mediaType !== image.mediaType) {
    throw new Error("Image preprocessing worker returned mismatched image content");
  }
  const coordinates: ImageCoordinateMetadata = image.coordinates;
  if (
    info.width !== coordinates.width
    || info.height !== coordinates.height
    || !Number.isFinite(coordinates.scaleX)
    || !Number.isFinite(coordinates.scaleY)
    || coordinates.scaleX < 1
    || coordinates.scaleY < 1
  ) throw new Error("Image preprocessing worker returned invalid coordinate metadata");
  return image;
}

/** Converts, orients, and bounds image bytes on an isolated worker thread. */
export async function preprocessImage(
  input: Uint8Array,
  options: ImagePreprocessExecutionOptions = {},
): Promise<PreprocessedImage> {
  if (!(input instanceof Uint8Array) || input.byteLength < 1) throw new Error("Image input is empty");
  if (input.byteLength > MAX_PREPROCESS_INPUT_BYTES) throw new RangeError(`Image input exceeds ${MAX_PREPROCESS_INPUT_BYTES} bytes`);
  options.signal?.throwIfAborted();
  const timeoutMs = executionTimeout(options.timeoutMs);
  const { timeoutMs: _timeoutMs, signal, ...imageOptions } = options;
  const owned = new Uint8Array(input);
  const source = new URL(import.meta.url.endsWith(".ts") ? "./preprocess-worker.ts" : "./preprocess-worker.js", import.meta.url);
  const worker = new Worker(source);
  try {
    return await new Promise<PreprocessedImage>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error("Image preprocessing cancelled")));
      const timer = setTimeout(() => finish(() => reject(new Error(`Image preprocessing exceeded ${timeoutMs} milliseconds`))), timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
      worker.once("message", (message: unknown) => finish(() => {
        if (!workerResponse(message)) {
          reject(new Error("Image preprocessing worker returned an invalid response"));
          return;
        }
        if (!message.ok) {
          reject(new Error(message.error));
          return;
        }
        try {
          resolve(validateWorkerImage(message.image));
        } catch (error) {
          reject(error);
        }
      }));
      worker.once("error", (error) => finish(() => reject(error)));
      worker.once("exit", (code) => {
        if (code !== 0) finish(() => reject(new Error(`Image preprocessing worker exited with code ${code}`)));
      });
      worker.postMessage({ input: owned, options: imageOptions }, [owned.buffer]);
    });
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}

export function imageCoordinateHint(coordinates: ImageCoordinateMetadata): string | undefined {
  if (!coordinates.resized && !coordinates.orientationApplied) return undefined;
  const scale = coordinates.resized
    ? ` Scale model coordinates by x=${coordinates.scaleX.toFixed(3)}, y=${coordinates.scaleY.toFixed(3)} for the original.`
    : "";
  return `Attached image geometry: original ${coordinates.originalWidth}x${coordinates.originalHeight}, supplied ${coordinates.width}x${coordinates.height}.${scale}`;
}
