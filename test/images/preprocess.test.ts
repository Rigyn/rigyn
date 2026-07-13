import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import {
  imageCoordinateHint,
  preprocessImage,
  sniffImageMediaType,
} from "../../src/images/preprocess.js";
import { inspectImage } from "../../src/tools/image-info.js";

function tinyBmp(): Buffer {
  const data = Buffer.alloc(58);
  data.write("BM", 0, "ascii");
  data.writeUInt32LE(data.length, 2);
  data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14);
  data.writeInt32LE(1, 18);
  data.writeInt32LE(1, 22);
  data.writeUInt16LE(1, 26);
  data.writeUInt16LE(24, 28);
  data.writeUInt32LE(4, 34);
  data[56] = 0xff;
  return data;
}

test("signature sniffing covers provider formats plus BMP and TIFF conversion inputs", () => {
  assert.equal(sniffImageMediaType(tinyBmp()), "image/bmp");
  assert.equal(sniffImageMediaType(Buffer.from([0x49, 0x49, 0x2a, 0x00])), "image/tiff");
  assert.equal(sniffImageMediaType(Buffer.from("not an image")), undefined);
});

test("small provider-safe PNG bytes remain byte-for-byte intact off-thread", async () => {
  const input = await sharp({
    create: { width: 3, height: 2, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 0.5 } },
  }).png().toBuffer();
  const original = Buffer.from(input);
  const result = await preprocessImage(input);
  assert.equal(result.mediaType, "image/png");
  assert.deepEqual(Buffer.from(result.bytes), original);
  assert.deepEqual(result.coordinates, {
    originalWidth: 3,
    originalHeight: 2,
    width: 3,
    height: 2,
    scaleX: 1,
    scaleY: 1,
    orientationApplied: false,
    resized: false,
    converted: false,
  });
  assert.equal(input.equals(original), true);
});

test("BMP is converted to validated provider-safe content", async () => {
  const result = await preprocessImage(tinyBmp());
  assert.equal(["image/png", "image/jpeg", "image/webp"].includes(result.mediaType), true);
  assert.equal(result.sourceMediaType, "image/bmp");
  assert.equal(result.coordinates.converted, true);
  assert.deepEqual(inspectImage(result.bytes), { mediaType: result.mediaType, width: 1, height: 1 });
});

test("EXIF orientation is applied before dimensions and coordinate scales are reported", async () => {
  const input = await sharp({
    create: { width: 2, height: 3, channels: 3, background: { r: 200, g: 20, b: 10 } },
  }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const result = await preprocessImage(input);
  assert.equal(result.coordinates.orientationApplied, true);
  assert.equal(result.coordinates.originalWidth, 3);
  assert.equal(result.coordinates.originalHeight, 2);
  assert.equal(result.coordinates.width, 3);
  assert.equal(result.coordinates.height, 2);
  assert.equal(result.coordinates.converted, true);
  assert.match(imageCoordinateHint(result.coordinates) ?? "", /original 3x2, supplied 3x2/u);
});

test("pixel dimensions and encoded bytes are reduced within exact bounds", async () => {
  const pixels = Buffer.alloc(256 * 192 * 3);
  for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 31 + Math.floor(index / 17)) & 0xff;
  const input = await sharp(pixels, { raw: { width: 256, height: 192, channels: 3 } }).png().toBuffer();
  const result = await preprocessImage(input, { maxWidth: 80, maxHeight: 80, maxOutputBytes: 2_000 });
  assert.equal(result.bytes.byteLength <= 2_000, true);
  assert.equal(result.coordinates.width <= 80, true);
  assert.equal(result.coordinates.height <= 80, true);
  assert.equal(result.coordinates.resized, true);
  assert.equal(result.coordinates.scaleX, 256 / result.coordinates.width);
  assert.equal(result.coordinates.scaleY, 192 / result.coordinates.height);
  assert.match(imageCoordinateHint(result.coordinates) ?? "", /Scale model coordinates/u);
});

test("unrecognized, over-pixel, aborted, and timed-out work fails closed", async () => {
  await assert.rejects(preprocessImage(Buffer.from("not an image")), /recognized image format/u);
  const image = await sharp({
    create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).png().toBuffer();
  await assert.rejects(preprocessImage(image, { maxInputPixels: 100 }), /pixel|limit/iu);

  const abort = new AbortController();
  abort.abort(new Error("test cancellation"));
  await assert.rejects(preprocessImage(image, { signal: abort.signal }), /test cancellation/u);
  await assert.rejects(preprocessImage(image, { timeoutMs: 1 }), /exceeded 1 milliseconds/u);
});
