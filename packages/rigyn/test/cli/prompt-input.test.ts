import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";

import { expandPromptReferences } from "../../src/cli/prompt-input.js";
import { inspectImage } from "../../src/tools/image-info.js";

async function png(width = 1, height = 1): Promise<Buffer> {
  return await sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 40, b: 60 } },
  }).png().toBuffer();
}

function bmp(): Buffer {
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

test("prompt references load UTF-8 files once and attach supported images", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-prompt-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "note.txt"), "hello context");
  const pixel = await png();
  await writeFile(join(root, "pixel.png"), pixel);

  const expanded = await expandPromptReferences("review @docs/note.txt and @\"pixel.png\" @docs/note.txt", root);
  assert.match(expanded.text, /<file path="docs\/note.txt">\nhello context\n<\/file>/u);
  assert.equal(expanded.text.match(/<file /gu)?.length, 1);
  assert.deepEqual(expanded.files, ["docs/note.txt", "pixel.png"]);
  assert.deepEqual(expanded.images, [{ type: "image", mediaType: "image/png", data: pixel.toString("base64") }]);
});

test("prompt image references trust bounded signatures and dimensions instead of extensions", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-prompt-images-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const disguised = await png(2, 3);
  await writeFile(join(root, "image.data"), disguised);
  await writeFile(join(root, "wrong.png"), "not an image");
  await writeFile(join(root, "huge.bin"), await png(20_000, 1));

  const expanded = await expandPromptReferences('inspect @"image.data"', root);
  assert.deepEqual(expanded.images, [{ type: "image", mediaType: "image/png", data: disguised.toString("base64") }]);
  await assert.rejects(expandPromptReferences('inspect @"wrong.png"', root), /extension does not match valid/u);
  const resized = await expandPromptReferences('inspect @"huge.bin"', root);
  const resizedBytes = Buffer.from(resized.images[0]?.data ?? "", "base64");
  assert.deepEqual(inspectImage(resizedBytes), { mediaType: resized.images[0]?.mediaType, width: 2_000, height: 1 });
  assert.match(resized.text, /Scale model coordinates by x=10\.000/u);
});

test("prompt references convert bounded BMP content and disclose the provider-safe format", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-prompt-bmp-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "clipboard.bmp"), bmp());
  const expanded = await expandPromptReferences('inspect @"clipboard.bmp"', root);
  assert.equal(expanded.images.length, 1);
  assert.equal(expanded.images[0]?.mediaType, "image/png");
  assert.match(expanded.text, /Converted image\/bmp to image\/png/u);
});

test("explicit prompt references recover one Unicode-equivalent filename", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-prompt-unicode-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const actual = "caf\u00e9\u2019s\u202fnotes.txt";
  await writeFile(join(root, actual), "recovered context");

  const expanded = await expandPromptReferences('review @"cafe\u0301\'s notes.txt"', root);
  assert.deepEqual(expanded.files, [actual]);
  assert.match(expanded.text, /<file path="caf\u00e9\u2019s\u202fnotes\.txt">\nrecovered context\n<\/file>/u);
});

test("prompt references reject workspace escapes and binary text", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-prompt-"));
  const outside = await mkdtemp(join(tmpdir(), "harness-outside-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await writeFile(join(outside, "secret.txt"), "outside");
  await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
  await writeFile(join(root, "binary.dat"), Buffer.from([0xff, 0xfe]));
  await assert.rejects(expandPromptReferences("@escape.txt", root), /escapes workspace|symbolic/u);
  await assert.rejects(expandPromptReferences("@binary.dat", root), /neither a supported image nor UTF-8/u);
});

test("prompt references ignore ordinary missing handles and block sensitive files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-prompt-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".env.local"), "SECRET=not-loaded");
  await mkdir(join(root, ".SSH"));
  await writeFile(join(root, ".SSH", "config"), "SECRET=also-not-loaded");
  await writeFile(join(root, "ID_RSA"), "SECRET=uppercase-name");
  await symlink(join(root, ".env.local"), join(root, "notes.txt"), "file");

  const ordinary = await expandPromptReferences("ask @reviewer for feedback", root);
  assert.equal(ordinary.text, "ask @reviewer for feedback");
  assert.deepEqual(ordinary.files, []);
  await assert.rejects(expandPromptReferences("review @.env.local", root), /Sensitive files cannot be attached/u);
  await assert.rejects(expandPromptReferences('review @".SSH/config"', root), /Sensitive files cannot be attached/u);
  await assert.rejects(expandPromptReferences("review @ID_RSA", root), /Sensitive files cannot be attached/u);
  await assert.rejects(expandPromptReferences('review @"notes.txt"', root), /Sensitive files cannot be attached/u);
  await assert.rejects(expandPromptReferences('review @"missing file.txt"', root), /ENOENT/u);
});
