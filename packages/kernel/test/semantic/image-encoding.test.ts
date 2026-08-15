import assert from "node:assert/strict";
import test from "node:test";
import { base64, detectImageMimeType } from "../../src/harness/tools/image.js";

test("image encoding respects Uint8Array views and padding boundaries", () => {
  const storage = Uint8Array.from([99, 1, 2, 3, 4, 98]);
  for (const length of [0, 1, 2, 3, 4]) {
    const view = storage.subarray(1, 1 + length);
    assert.equal(base64(view), Buffer.from(view).toString("base64"));
  }
});

function png(chunkType: "IDAT" | "acTL"): Uint8Array {
  const bytes = Buffer.alloc(45);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(0, 33);
  bytes.write(chunkType, 37, "ascii");
  return bytes;
}

test("image detection accepts reviewed static formats and rejects animated PNG data", () => {
  assert.equal(detectImageMimeType(Uint8Array.of(255, 216, 255, 224)), "image/jpeg");
  assert.equal(detectImageMimeType(Uint8Array.of(255, 216, 255, 247)), undefined);
  assert.equal(detectImageMimeType(png("IDAT")), "image/png");
  assert.equal(detectImageMimeType(png("acTL")), undefined);
  assert.equal(detectImageMimeType(Buffer.from("GIF89a", "ascii")), "image/gif");

  const webp = Buffer.alloc(12);
  webp.write("RIFF", 0, "ascii");
  webp.write("WEBP", 8, "ascii");
  assert.equal(detectImageMimeType(webp), "image/webp");

  const bmp = Buffer.alloc(54);
  bmp.write("BM", 0, "ascii");
  bmp.writeUInt32LE(54, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  assert.equal(detectImageMimeType(bmp), "image/bmp");
  assert.equal(detectImageMimeType(Uint8Array.of(1, 2, 3)), undefined);
});
