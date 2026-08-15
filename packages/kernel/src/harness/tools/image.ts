import { Buffer } from "node:buffer";

const PNG_MAGIC = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const JPEG_MAGIC = Uint8Array.of(255, 216, 255);
const BMP_BITS_PER_PIXEL = new Set([1, 4, 8, 16, 24, 32]);

class BinaryImage {
  readonly bytes: Uint8Array;
  readonly #view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  contains(offset: number, expected: Uint8Array): boolean {
    if (offset < 0 || offset + expected.byteLength > this.bytes.byteLength) return false;
    return expected.every((byte, index) => this.bytes[offset + index] === byte);
  }

  containsText(offset: number, expected: string): boolean {
    if (offset < 0 || offset + expected.length > this.bytes.byteLength) return false;
    for (let index = 0; index < expected.length; index += 1) {
      if (this.bytes[offset + index] !== expected.charCodeAt(index)) return false;
    }
    return true;
  }

  uint16(offset: number): number | undefined {
    return offset >= 0 && offset + 2 <= this.bytes.byteLength
      ? this.#view.getUint16(offset, true)
      : undefined;
  }

  uint32(offset: number, littleEndian: boolean): number | undefined {
    return offset >= 0 && offset + 4 <= this.bytes.byteLength
      ? this.#view.getUint32(offset, littleEndian)
      : undefined;
  }
}

function isAnimatedPng(image: BinaryImage): boolean {
  let chunk = PNG_MAGIC.byteLength;
  while (chunk + 8 <= image.bytes.byteLength) {
    const payloadBytes = image.uint32(chunk, false);
    if (payloadBytes === undefined) return false;
    if (image.containsText(chunk + 4, "acTL")) return true;
    if (image.containsText(chunk + 4, "IDAT")) return false;
    const followingChunk = chunk + 12 + payloadBytes;
    if (!Number.isSafeInteger(followingChunk)
      || followingChunk <= chunk
      || followingChunk > image.bytes.byteLength) return false;
    chunk = followingChunk;
  }
  return false;
}

function isSupportedPng(image: BinaryImage): boolean {
  return image.bytes.byteLength >= 16
    && image.uint32(PNG_MAGIC.byteLength, false) === 13
    && image.containsText(12, "IHDR")
    && !isAnimatedPng(image);
}

function isSupportedBmp(image: BinaryImage): boolean {
  if (image.bytes.byteLength < 26) return false;
  const declaredBytes = image.uint32(2, true) ?? 0;
  const pixelsAt = image.uint32(10, true);
  const headerBytes = image.uint32(14, true);
  if (pixelsAt === undefined || headerBytes === undefined) return false;
  if (declaredBytes !== 0 && declaredBytes < 26) return false;
  if (pixelsAt < 14 + headerBytes || declaredBytes !== 0 && pixelsAt > declaredBytes) return false;

  const compactHeader = headerBytes === 12;
  const standardHeader = headerBytes >= 40 && headerBytes <= 124;
  if (!compactHeader && !standardHeader) return false;
  const planes = image.uint16(compactHeader ? 22 : 26);
  const bitsPerPixel = image.uint16(compactHeader ? 24 : 28);
  return planes === 1
    && bitsPerPixel !== undefined
    && BMP_BITS_PER_PIXEL.has(bitsPerPixel);
}

export function detectImageMimeType(bytes: Uint8Array): string | undefined {
  const image = new BinaryImage(bytes);
  if (image.contains(0, JPEG_MAGIC)) {
    return bytes[3] === 247 ? undefined : "image/jpeg";
  }
  if (image.contains(0, PNG_MAGIC)) {
    return isSupportedPng(image) ? "image/png" : undefined;
  }
  if (image.containsText(0, "GIF")) return "image/gif";
  if (image.containsText(0, "RIFF") && image.containsText(8, "WEBP")) return "image/webp";
  if (image.containsText(0, "BM")) return isSupportedBmp(image) ? "image/bmp" : undefined;
  return undefined;
}

export function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}
