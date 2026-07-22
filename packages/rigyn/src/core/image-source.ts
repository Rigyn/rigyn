import type { ImageBlock } from "./types.js";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_BASE64_LENGTH = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
export const MAX_IMAGE_MEDIA_TYPE_LENGTH = 127;
export const MAX_IMAGE_URL_LENGTH = 16 * 1024;
export const MAX_IMAGE_DATA_URL_LENGTH = MAX_IMAGE_BASE64_LENGTH + MAX_IMAGE_MEDIA_TYPE_LENGTH + 13;

export type NormalizedImageSource =
  | { kind: "base64"; mediaType: string; data: string }
  | { kind: "url"; mediaType: string; url: string };

export class ImageSourceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageSourceValidationError";
  }
}

function invalid(detail: string): ImageSourceValidationError {
  return new ImageSourceValidationError(detail);
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim() === "" ? undefined : value;
}

function normalizeImageMediaType(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function assertBase64(value: string): void {
  if (value.length > MAX_IMAGE_BASE64_LENGTH) {
    throw invalid(`base64 data exceeds ${MAX_IMAGE_BASE64_LENGTH} encoded characters`);
  }
  if (value === "" || !/^[a-z0-9+/]*={0,2}$/iu.test(value) || value.length % 4 === 1 || /=/u.test(value.slice(0, -2))) {
    throw invalid("image data must be valid base64 without whitespace");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedBytes = Math.floor(value.length * 3 / 4) - padding;
  if (decodedBytes > MAX_IMAGE_BYTES) throw invalid(`base64 data exceeds ${MAX_IMAGE_BYTES} decoded bytes`);
  const canonical = Buffer.from(value, "base64").toString("base64").replace(/=+$/u, "");
  if (canonical !== value.replace(/=+$/u, "")) {
    throw invalid("image data must be valid base64 without whitespace");
  }
}

export function validateImageSource(block: ImageBlock): NormalizedImageSource {
  if (typeof block.mediaType !== "string") throw invalid("mediaType must be a string");
  if (block.mediaType.length > MAX_IMAGE_MEDIA_TYPE_LENGTH) {
    throw invalid(`mediaType exceeds ${MAX_IMAGE_MEDIA_TYPE_LENGTH} characters`);
  }
  if (block.data !== undefined && typeof block.data !== "string") throw invalid("data must be a string");
  if (block.url !== undefined && typeof block.url !== "string") throw invalid("URL must be a string");
  if (block.data !== undefined && block.data.length > MAX_IMAGE_BASE64_LENGTH) {
    throw invalid(`base64 data exceeds ${MAX_IMAGE_BASE64_LENGTH} encoded characters`);
  }
  const mediaType = normalizeImageMediaType(block.mediaType);
  if (!/^image\/[a-z0-9][a-z0-9.+-]*$/u.test(mediaType)) {
    throw invalid("mediaType must be a valid image MIME type");
  }

  const data = nonEmpty(block.data);
  const url = nonEmpty(block.url);
  if (data !== undefined && url !== undefined) throw invalid("must contain exactly one of data or url");
  if (data !== undefined) {
    assertBase64(data);
    return { kind: "base64", mediaType, data };
  }
  if (url === undefined) throw invalid("requires non-empty base64 data or a URL");
  if (url !== url.trim()) throw invalid("URL must not contain surrounding whitespace");

  const dataUrl = url.slice(0, 5).toLowerCase() === "data:";
  if (dataUrl) {
    if (url.length > MAX_IMAGE_DATA_URL_LENGTH) {
      throw invalid(`data URL exceeds ${MAX_IMAGE_DATA_URL_LENGTH} characters`);
    }
    const parsed = /^data:([^;,]+);base64,([a-z0-9+/]*={0,2})$/iu.exec(url);
    if (parsed === null) throw invalid("data URL must use the data:image/...;base64,... form");
    if (parsed[1]!.length > MAX_IMAGE_MEDIA_TYPE_LENGTH) {
      throw invalid(`data URL media type exceeds ${MAX_IMAGE_MEDIA_TYPE_LENGTH} characters`);
    }
    const encodedMediaType = normalizeImageMediaType(parsed[1]!);
    const encodedData = parsed[2]!;
    if (encodedMediaType !== mediaType) {
      throw invalid(`data URL MIME type ${encodedMediaType} does not match ${mediaType}`);
    }
    assertBase64(encodedData);
    return { kind: "base64", mediaType, data: encodedData };
  }

  if (url.length > MAX_IMAGE_URL_LENGTH) throw invalid(`URL exceeds ${MAX_IMAGE_URL_LENGTH} characters`);
  if (/[\u0000-\u0020\u007f]/u.test(url) || url.includes("\\")) {
    throw invalid("URL must not contain controls, whitespace, or backslashes");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalid("URL must be fully qualified");
  }
  if (!/^[a-z][a-z0-9+.-]*:$/u.test(parsed.protocol)) throw invalid("URL has an invalid scheme");
  if (["http:", "https:", "gs:", "s3:"].includes(parsed.protocol)) {
    const prefix = `${parsed.protocol}//`;
    const authority = url.startsWith(prefix) ? url.slice(prefix.length).split(/[/?#]/u, 1)[0] : "";
    if (!url.startsWith(prefix) || authority === "" || parsed.hostname === "") {
      throw invalid(`${parsed.protocol} URL requires an explicit authority and host`);
    }
  }
  if (parsed.username !== "" || parsed.password !== "") throw invalid("URL must not contain credentials");
  return { kind: "url", mediaType, url };
}
