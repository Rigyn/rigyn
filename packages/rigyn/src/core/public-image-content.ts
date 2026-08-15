import { isProxy } from "node:util/types";

import { boundedJsonSnapshot } from "@rigyn/kernel/runtime/core/bounded-json";

import { errorMessage } from "./errors.js";
import { validateImageSource } from "./image-source.js";
import type { ImageBlock } from "./types.js";

const PUBLIC_IMAGE_FIELDS = new Set(["type", "data", "mimeType"]);
const MAX_PUBLIC_IMAGES = 20;
const MAX_IMAGE_LIST_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_LIST_VALUES = 1 + MAX_PUBLIC_IMAGES * 5;
const MAX_IMAGE_LIST_CONTAINERS = 1 + MAX_PUBLIC_IMAGES;

function imageRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an image object`);
  }
  return value as Record<string, unknown>;
}

function imageListSnapshot(value: unknown, label: string): Record<string, unknown>[] {
  if (value !== null && typeof value === "object" && isProxy(value)) {
    throw new TypeError(`${label} must not contain proxies`);
  }
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${label} must be a vanilla array`);
  const lengthValue = Reflect.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(lengthValue) || (lengthValue as number) < 0) {
    throw new TypeError(`${label} must be a dense vanilla array`);
  }
  const length = lengthValue as number;
  if (length > MAX_PUBLIC_IMAGES) throw new TypeError(`${label} must contain at most ${MAX_PUBLIC_IMAGES} images`);
  const selected = boundedJsonSnapshot(value, {
    label,
    maximumBytes: MAX_IMAGE_LIST_BYTES,
    maximumValues: MAX_IMAGE_LIST_VALUES,
    maximumContainers: MAX_IMAGE_LIST_CONTAINERS,
    maximumDepth: 2,
  }).value;
  if (!Array.isArray(selected)) throw new TypeError(`${label} must be an array`);
  return selected.map((image, index) => imageRecord(image, `${label}[${index}]`));
}

function canonicalPublicImageRecord(record: Record<string, unknown>, label: string): ImageBlock {
  for (const field of Object.keys(record)) {
    if (!PUBLIC_IMAGE_FIELDS.has(field)) throw new TypeError(`${label} contains unsupported field ${field}`);
  }
  if (record["type"] !== "image") throw new TypeError(`${label} type must be image`);
  if (typeof record["mimeType"] !== "string") throw new TypeError(`${label} mimeType must be a string`);
  if (typeof record["data"] !== "string") throw new TypeError(`${label} data must be a base64 string`);

  try {
    const source = validateImageSource({
      type: "image",
      mediaType: record["mimeType"],
      data: record["data"],
    });
    if (source.kind !== "base64") throw new TypeError(`${label} must contain base64 data`);
    return { type: "image", mediaType: source.mediaType, data: source.data };
  } catch (error) {
    throw new TypeError(`${label} is invalid: ${errorMessage(error).replaceAll("mediaType", "mimeType")}`);
  }
}

function canonicalInternalImage(record: Record<string, unknown>, label: string): ImageBlock {
  try {
    const source = validateImageSource(record as unknown as ImageBlock);
    return source.kind === "base64"
      ? { type: "image", mediaType: source.mediaType, data: source.data }
      : { type: "image", mediaType: source.mediaType, url: source.url };
  } catch (error) {
    throw new TypeError(`${label} is invalid: ${errorMessage(error)}`);
  }
}

/** Validate and copy a public image list before it crosses into the runtime. */
export function canonicalPublicImages(
  value: unknown,
  label: string,
): ImageBlock[] {
  return imageListSnapshot(value, label)
    .map((image, index) => canonicalPublicImageRecord(image, `${label}[${index}]`));
}

/** Canonicalize the SDK's legacy ImageBlock or public ImageContent list without inspecting caller objects. */
export function canonicalAgentInputImages(value: unknown, label: string): ImageBlock[] {
  const images = imageListSnapshot(value, label);
  const publicShape = images.some((image) => "mimeType" in image);
  return images.map((image, index) => publicShape
    ? canonicalPublicImageRecord(image, `${label}[${index}]`)
    : canonicalInternalImage(image, `${label}[${index}]`));
}
