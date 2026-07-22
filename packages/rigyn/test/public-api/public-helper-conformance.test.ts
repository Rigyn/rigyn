import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  ProjectTrustStore,
  hasTrustRequiringProjectResources,
} from "../../src/config/project-trust.js";
import { parseFrontmatter, stripFrontmatter } from "../../src/core/frontmatter.js";
import { convertToPng, copyToClipboard, formatDimensionNote } from "../../src/images/helpers.js";
import { getShellConfig } from "../../src/process/shell-config.js";
import { truncateHead, truncateLine, truncateTail } from "../../src/tools/truncate.js";

test("project trust is synchronous, inherited, removable, and deterministically stored", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rigyn-project-trust-public-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const parent = join(root, "workspace");
  const child = join(parent, "nested");
  mkdirSync(child, { recursive: true });
  const store = new ProjectTrustStore(agentDir);

  assert.equal(store.get(child), null);
  assert.equal(store.set(parent, true), undefined);
  assert.equal(store.get(child), true);
  assert.deepEqual(store.getEntry(child), { path: resolve(parent), decision: true });
  store.set(child, false);
  assert.equal(store.get(child), false);
  store.set(child, null);
  assert.equal(store.get(child), true);
  store.setMany([
    { path: child, decision: false },
    { path: parent, decision: null },
  ]);
  assert.equal(store.get(child), false);
  assert.equal(readFileSync(join(agentDir, "trust.json"), "utf8"), `${JSON.stringify({ [resolve(child)]: false }, null, 2)}\n`);
});

test("project resource detection uses the public trust-gated resource set", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rigyn-project-resources-public-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  mkdirSync(join(project, ".rigyn"), { recursive: true });
  assert.equal(hasTrustRequiringProjectResources(project), false);
  writeFileSync(join(project, ".rigyn", "packages.json"), "{}\n");
  assert.equal(hasTrustRequiringProjectResources(project), false);
  writeFileSync(join(project, ".rigyn", "settings.json"), "{}\n");
  assert.equal(hasTrustRequiringProjectResources(project), true);
});

test("frontmatter normalizes line endings and trims only delimited bodies", () => {
  assert.deepEqual(parseFrontmatter<{ name: string }>("---\r\nname: probe\r\n---\r\n\r\n Body \r\n"), {
    frontmatter: { name: "probe" },
    body: "Body",
  });
  assert.deepEqual(parseFrontmatter("plain\r\n body \r"), {
    frontmatter: {},
    body: "plain\n body \n",
  });
  assert.equal(stripFrontmatter("---\n# comment\n---\n body \n"), "body");
  assert.throws(() => parseFrontmatter("---\nvalue: [broken\n---\nbody"));
});

test("image helpers preserve PNG payloads and expose coordinate scaling", async () => {
  assert.deepEqual(await convertToPng("opaque-payload", "image/png"), {
    data: "opaque-payload",
    mimeType: "image/png",
  });
  assert.equal(formatDimensionNote({
    data: "",
    mimeType: "image/png",
    originalWidth: 2000,
    originalHeight: 1000,
    width: 1000,
    height: 500,
    wasResized: true,
  }), "[Image: original 2000x1000, displayed at 1000x500. Multiply coordinates by 2.00 to map to original image.]");
  assert.equal(formatDimensionNote({
    data: "",
    mimeType: "image/png",
    originalWidth: 1,
    originalHeight: 1,
    width: 1,
    height: 1,
    wasResized: false,
  }), undefined);
});

test("clipboard helper uses a bounded terminal fallback", async () => {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    if (typeof chunk === "string" && chunk.startsWith("\u001b]52;c;")) {
      writes.push(chunk);
      return true;
    }
    return Reflect.apply(originalWrite, process.stdout, [chunk, ...args]);
  }) as typeof process.stdout.write;
  try {
    const options = { platform: "freebsd" as const, environment: {} };
    await copyToClipboard("hello", options);
    assert.deepEqual(writes, [`\u001b]52;c;${Buffer.from("hello").toString("base64")}\u0007`]);
    await assert.rejects(copyToClipboard("x".repeat(80_000), options), /Failed to copy to clipboard/u);
    await assert.rejects(
      copyToClipboard("hello", { ...options, signal: AbortSignal.abort(new Error("cancel clipboard")) }),
      /cancel clipboard/u,
    );
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("shell and truncation helpers retain the public command contract", () => {
  assert.throws(() => getShellConfig(join(tmpdir(), "missing-rigyn-shell")), /Custom shell path not found/u);
  assert.deepEqual(getShellConfig(process.execPath), { shell: process.execPath, args: ["-c"] });
  assert.deepEqual(truncateLine("abcdefghij", 8), {
    text: "abcdefgh... [truncated]",
    wasTruncated: true,
  });
  assert.equal(truncateHead("one\ntwo\nthree", { maxLines: 2 }).content, "one\ntwo");
  assert.equal(truncateTail("one\ntwo\nthree", { maxLines: 2 }).content, "two\nthree");
  assert.equal(truncateHead("a\n\n\nb", { maxBytes: 2 }).outputLines, 2);
  assert.equal(truncateTail("a", { maxBytes: 0 }).outputLines, 1);
});

test("Windows shell discovery fails with actionable installation guidance when bash is absent", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const path = process.env.PATH;
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  delete process.env.ProgramFiles;
  delete process.env["ProgramFiles(x86)"];
  process.env.PATH = "";
  try {
    assert.throws(
      () => getShellConfig(),
      /Install Git for Windows: https:\/\/git-scm\.com\/download\/win[\s\S]*Set shellPath in settings\.json/u,
    );
  } finally {
    if (platform !== undefined) Object.defineProperty(process, "platform", platform);
    if (programFiles === undefined) delete process.env.ProgramFiles;
    else process.env.ProgramFiles = programFiles;
    if (programFilesX86 === undefined) delete process.env["ProgramFiles(x86)"];
    else process.env["ProgramFiles(x86)"] = programFilesX86;
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
});
