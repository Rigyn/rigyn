export const TOOL_IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type ToolImageMediaType = typeof TOOL_IMAGE_MEDIA_TYPES[number];

export interface ImageInfo {
  mediaType: ToolImageMediaType;
  width: number;
  height: number;
}

export const MAX_TOOL_IMAGE_DIMENSION = 16_384;
export const MAX_TOOL_IMAGE_PIXELS = 40_000_000;

export function looksLikeSupportedImage(data: Uint8Array): boolean {
  return isPng(data) || isJpeg(data) || isGif(data) || isWebp(data);
}

export function inspectImage(data: Uint8Array): ImageInfo | undefined {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let info: ImageInfo | undefined;
  if (isPng(buffer)) info = pngInfo(buffer);
  else if (isJpeg(buffer)) info = jpegInfo(buffer);
  else if (isGif(buffer)) info = gifInfo(buffer);
  else if (isWebp(buffer)) info = webpInfo(buffer);
  if (info === undefined) return undefined;
  validateDimensions(info);
  return info;
}

function isPng(data: Uint8Array): boolean {
  return data.length >= 8 && Buffer.from(data.buffer, data.byteOffset, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
}

function isJpeg(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0xff && data[1] === 0xd8;
}

function isGif(data: Uint8Array): boolean {
  if (data.length < 6) return false;
  const header = Buffer.from(data.buffer, data.byteOffset, 6).toString("ascii");
  return header === "GIF87a" || header === "GIF89a";
}

function isWebp(data: Uint8Array): boolean {
  if (data.length < 12) return false;
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
}

function pngInfo(data: Buffer): ImageInfo {
  if (data.length < 24 || data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("PNG image has a missing or invalid IHDR header");
  }
  return { mediaType: "image/png", width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function gifInfo(data: Buffer): ImageInfo {
  if (data.length < 10) throw new Error("GIF image has a truncated logical screen descriptor");
  return { mediaType: "image/gif", width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
}

function jpegInfo(data: Buffer): ImageInfo {
  let offset = 2;
  while (offset < data.length) {
    while (offset < data.length && data[offset] !== 0xff) offset += 1;
    while (offset < data.length && data[offset] === 0xff) offset += 1;
    if (offset >= data.length) break;
    const marker = data[offset]!;
    offset += 1;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (marker === 0xda || marker === 0xd9) break;
    if (offset + 2 > data.length) throw new Error("JPEG image has a truncated segment length");
    const segmentLength = data.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > data.length) {
      throw new Error("JPEG image has an invalid or truncated segment");
    }
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) throw new Error("JPEG image has a truncated frame header");
      return {
        mediaType: "image/jpeg",
        height: data.readUInt16BE(offset + 3),
        width: data.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  throw new Error("JPEG image does not contain a supported frame header");
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function webpInfo(data: Buffer): ImageInfo {
  if (data.length < 20) throw new Error("WebP image has a truncated RIFF header");
  const declaredEnd = data.readUInt32LE(4) + 8;
  if (declaredEnd > data.length || declaredEnd < 20) throw new Error("WebP image has an invalid RIFF size");
  let offset = 12;
  while (offset + 8 <= declaredEnd) {
    const type = data.toString("ascii", offset, offset + 4);
    const length = data.readUInt32LE(offset + 4);
    const payload = offset + 8;
    const end = payload + length;
    if (end > declaredEnd || end > data.length) throw new Error("WebP image has a truncated chunk");
    if (type === "VP8X") {
      if (length < 10) throw new Error("WebP VP8X image has a truncated header");
      return {
        mediaType: "image/webp",
        width: readUInt24LE(data, payload + 4) + 1,
        height: readUInt24LE(data, payload + 7) + 1,
      };
    }
    if (type === "VP8L") {
      if (length < 5 || data[payload] !== 0x2f) throw new Error("WebP VP8L image has an invalid header");
      const bits = data.readUInt32LE(payload + 1);
      return {
        mediaType: "image/webp",
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    if (type === "VP8 ") {
      if (
        length < 10 || data[payload + 3] !== 0x9d || data[payload + 4] !== 0x01 || data[payload + 5] !== 0x2a
      ) throw new Error("WebP VP8 image has an invalid frame header");
      return {
        mediaType: "image/webp",
        width: data.readUInt16LE(payload + 6) & 0x3fff,
        height: data.readUInt16LE(payload + 8) & 0x3fff,
      };
    }
    offset = end + (length % 2);
  }
  throw new Error("WebP image does not contain a supported image chunk");
}

function readUInt24LE(data: Buffer, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16);
}

function validateDimensions(info: ImageInfo): void {
  if (!Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width < 1 || info.height < 1) {
    throw new Error(`${info.mediaType} image dimensions must be positive integers`);
  }
  if (info.width > MAX_TOOL_IMAGE_DIMENSION || info.height > MAX_TOOL_IMAGE_DIMENSION) {
    throw new Error(`Image dimensions exceed ${MAX_TOOL_IMAGE_DIMENSION} pixels per side`);
  }
  if (info.width * info.height > MAX_TOOL_IMAGE_PIXELS) {
    throw new Error(`Image dimensions exceed ${MAX_TOOL_IMAGE_PIXELS} total pixels`);
  }
}
