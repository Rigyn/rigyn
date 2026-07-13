import assert from "node:assert/strict";
import test from "node:test";
import {
  ITERM_IMAGE_CHUNK_BYTES,
  KITTY_IMAGE_CHUNK_BYTES,
  TerminalImageRegistry,
  allocateTerminalImageId,
  calculateTerminalImageCells,
  composeTerminalImageOutput,
  deleteKittyImage,
  encodeITerm2Image,
  encodeKittyImage,
  trustedTerminalHyperlink,
  validateTerminalImage,
  type TerminalImagePlacement,
} from "../../src/tui/terminal-image.js";
import { cellWidth } from "../../src/tui/unicode.js";

function png(width: number, height: number, extra = 0): Buffer {
  const data = Buffer.alloc(24 + extra, 0x61);
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
  for (const [offset, value] of [[24, width - 1], [27, height - 1]] as const) {
    data[offset] = value & 0xff;
    data[offset + 1] = value >>> 8 & 0xff;
    data[offset + 2] = value >>> 16 & 0xff;
  }
  return data;
}

function placement(data = png(20, 10)): TerminalImagePlacement {
  const validated = validateTerminalImage({
    key: "message:image:0",
    block: { type: "image", mediaType: "image/png", data: data.toString("base64") },
  }, 42);
  return { ...validated, row: 1, column: 0, columns: 4, rows: 2 };
}

test("terminal image validation reuses the bounded inspector for all supported formats", () => {
  for (const [index, [mediaType, data, width, height]] of ([
    ["image/png", png(3, 2), 3, 2],
    ["image/jpeg", jpeg(5, 4), 5, 4],
    ["image/gif", gif(7, 6), 7, 6],
    ["image/webp", webp(9, 8), 9, 8],
  ] as const).entries()) {
    const image = validateTerminalImage({
      key: `image:${index}`,
      block: { type: "image", mediaType, data: data.toString("base64") },
    }, index + 1);
    assert.equal(image.mediaType, mediaType);
    assert.equal(image.widthPx, width);
    assert.equal(image.heightPx, height);
    assert.equal(image.data, data.toString("base64"));
  }
  assert.throws(() => validateTerminalImage({
    key: "remote",
    block: { type: "image", mediaType: "image/png", url: "https://example.test/private.png" },
  }, 1), /remote URLs are never fetched/u);
  assert.throws(() => validateTerminalImage({
    key: "mismatch",
    block: { type: "image", mediaType: "image/jpeg", data: png(1, 1).toString("base64") },
  }, 1), /does not match/u);
  assert.throws(() => validateTerminalImage({
    key: "noncanonical",
    block: { type: "image", mediaType: "image/png", data: `${png(1, 1).toString("base64")}\n` },
  }, 1), /base64/u);
  assert.throws(() => validateTerminalImage({
    key: "too-many-pixels",
    block: { type: "image", mediaType: "image/png", data: png(10_000, 10_000).toString("base64") },
  }, 1), /total pixels/u);
  assert.throws(() => validateTerminalImage({
    key: "bad\u001bkey",
    block: { type: "image", mediaType: "image/png", data: png(1, 1).toString("base64") },
  }, 1), /printable/u);
});

test("image cell sizing preserves aspect ratio under width and height bounds", () => {
  assert.deepEqual(
    calculateTerminalImageCells({ widthPx: 200, heightPx: 100 }, { maxColumns: 10, maxRows: 10 }, { widthPx: 10, heightPx: 10 }),
    { columns: 10, rows: 5 },
  );
  assert.deepEqual(
    calculateTerminalImageCells({ widthPx: 100, heightPx: 1_000 }, { maxColumns: 10, maxRows: 5 }, { widthPx: 10, heightPx: 10 }),
    { columns: 1, rows: 5 },
  );
  assert.equal(allocateTerminalImageId(() => 99), 99);
  assert.throws(() => allocateTerminalImageId(() => 0), /1 to/u);
});

test("Kitty transfer chunks canonical PNG payloads, identifies placements, and deletes by ID", () => {
  const image = placement(png(20, 10, 9_000));
  const encoded = encodeKittyImage(image);
  assert.match(encoded, /^\u001b_Ga=T,f=100,q=2,C=1,c=4,r=2,i=42,m=1;/u);
  const packets = encoded.split("\u001b\\").filter(Boolean);
  assert.ok(packets.length > 1);
  for (const packet of packets) {
    const payload = packet.slice(packet.indexOf(";") + 1);
    assert.ok(payload.length <= KITTY_IMAGE_CHUNK_BYTES);
  }
  assert.match(packets.at(-1) ?? "", /m=0;/u);
  assert.equal(deleteKittyImage(42), "\u001b_Ga=d,d=I,i=42,q=2\u001b\\");
  assert.throws(() => encodeKittyImage({ ...image, mediaType: "image/jpeg" }), /PNG/u);
});

test("iTerm transfer uses bounded multipart packets for large validated content", () => {
  const small = placement();
  assert.match(encodeITerm2Image(small), /^\u001b\]1337;File=inline=1;size=/u);
  const large = placement(png(20, 10, ITERM_IMAGE_CHUNK_BYTES + 64));
  const encoded = encodeITerm2Image(large);
  assert.match(encoded, /^\u001b\]1337;MultipartFile=/u);
  assert.match(encoded, /\u001b\]1337;FileEnd\u0007$/u);
  const parts = [...encoded.matchAll(/\u001b\]1337;FilePart=([^\u0007]+)\u0007/gu)].map((match) => match[1] ?? "");
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= ITERM_IMAGE_CHUNK_BYTES));
});

test("static image composition keeps payloads out of cell text and reserves physical rows", () => {
  const image = placement();
  const text = "caption\n\n\nafter";
  assert.equal(cellWidth(text.split("\n")[1] ?? ""), 0);
  assert.equal(text.includes(image.data), false);
  const output = composeTerminalImageOutput(text, [image], "kitty");
  assert.equal(output.includes(image.data), true);
  assert.match(output, /\u001b7\u001b_G/u);
  assert.match(output, /\u001b8/u);
  assert.equal(output.split("\n").length, 4);
});

test("registry emits readable fallbacks and never previews remote or non-PNG Kitty data", () => {
  const registry = new TerminalImageRegistry();
  const remote = registry.resolve({
    key: "remote",
    block: { type: "image", mediaType: "image/png", url: "https://example.test/private.png" },
  }, { protocol: "iterm2", maxColumns: 20, maxRows: 10 });
  assert.equal(remote.image, undefined);
  assert.match(remote.fallback, /preview unavailable/u);
  assert.doesNotMatch(remote.fallback, /example\.test/u);
  const jpegResult = registry.resolve({
    key: "jpeg",
    block: { type: "image", mediaType: "image/jpeg", data: jpeg(10, 10).toString("base64") },
  }, { protocol: "kitty", maxColumns: 20, maxRows: 10 });
  assert.equal(jpegResult.image, undefined);
  assert.match(jpegResult.fallback, /requires PNG/u);
});

test("trusted OSC 8 output accepts readable web links and rejects control or active schemes", () => {
  const linked = trustedTerminalHyperlink("docs", "https://example.test/a?q=1");
  assert.equal(linked, "\u001b]8;;https://example.test/a?q=1\u001b\\docs\u001b]8;;\u001b\\");
  assert.equal(trustedTerminalHyperlink("unsafe", "javascript:alert(1)"), "unsafe");
  assert.equal(trustedTerminalHyperlink("unsafe", "https://user:secret@example.test/"), "unsafe");
  assert.equal(trustedTerminalHyperlink("unsafe", "https://example.test/\u001b]2;owned"), "unsafe");
});
