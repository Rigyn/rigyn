import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectImage,
  looksLikeSupportedImage,
  MAX_TOOL_IMAGE_DIMENSION,
} from "../../src/tools/image-info.js";

function png(width: number, height: number): Buffer {
  const data = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function jpeg(width: number, height: number): Buffer {
  const data = Buffer.alloc(21);
  data.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  data.writeUInt16BE(height, 7);
  data.writeUInt16BE(width, 9);
  return data;
}

function gif(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data.write("GIF89a", 0, "ascii");
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return data;
}

function webp(width: number, height: number): Buffer {
  const data = Buffer.alloc(30);
  data.write("RIFF", 0, "ascii");
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WEBP", 8, "ascii");
  data.write("VP8X", 12, "ascii");
  data.writeUInt32LE(10, 16);
  writeUInt24LE(data, 24, width - 1);
  writeUInt24LE(data, 27, height - 1);
  return data;
}

function writeUInt24LE(data: Buffer, offset: number, value: number): void {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >>> 8) & 0xff;
  data[offset + 2] = (value >>> 16) & 0xff;
}

test("image inspection identifies bounded PNG, JPEG, GIF, and WebP dimensions", () => {
  assert.deepEqual(inspectImage(png(3, 2)), { mediaType: "image/png", width: 3, height: 2 });
  assert.deepEqual(inspectImage(jpeg(5, 4)), { mediaType: "image/jpeg", width: 5, height: 4 });
  assert.deepEqual(inspectImage(gif(7, 6)), { mediaType: "image/gif", width: 7, height: 6 });
  assert.deepEqual(inspectImage(webp(9, 8)), { mediaType: "image/webp", width: 9, height: 8 });
  assert.equal(inspectImage(Buffer.from("plain text")), undefined);
});

test("image inspection rejects corrupt headers and decompression-scale dimensions", () => {
  const corrupt = png(1, 1);
  corrupt.write("NOPE", 12, "ascii");
  assert.equal(looksLikeSupportedImage(corrupt), true);
  assert.throws(() => inspectImage(corrupt), /IHDR/u);
  assert.throws(() => inspectImage(png(MAX_TOOL_IMAGE_DIMENSION + 1, 1)), /per side/u);
  assert.throws(() => inspectImage(png(10_000, 10_000)), /total pixels/u);
  assert.throws(() => inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), /frame header/u);
});
