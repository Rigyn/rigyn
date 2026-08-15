import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { runBoundedCommand } from "./bounded-command.mjs";

export const STANDALONE_PRODUCTION_CONTENT = "PRODUCTION-CONTENT.json";

const MAX_CONTENT_ENTRIES = 250_000;
const MAX_CONTENT_PATH_BYTES = 4_096;
const SHARP_SMOKE_PROGRAM = [
  'import assert from "node:assert/strict";',
  'import { pathToFileURL } from "node:url";',
  'const sharp = (await import(pathToFileURL(process.argv[1]).href)).default;',
  "const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();",
  'assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "sharp did not produce a PNG");',
].join("\n");
const RIPGREP_SMOKE_PROGRAM = [
  'import assert from "node:assert/strict";',
  'import { spawnSync } from "node:child_process";',
  'import { pathToFileURL } from "node:url";',
  'const module = await import(pathToFileURL(process.argv[1]).href);',
  'const binary = await module.resolveRipgrep({ environment: { PATH: "" } });',
  'assert.equal(typeof binary, "string", "Bundled ripgrep is unavailable");',
  'const result = spawnSync(binary, ["--version"], {',
  '  encoding: "utf8", env: { ...process.env, PATH: "" }, maxBuffer: 1024 * 1024, timeout: 15_000, windowsHide: true,',
  '});',
  'if (result.error !== undefined) throw result.error;',
  'assert.equal(result.signal, null, "Bundled ripgrep terminated by signal");',
  'assert.equal(result.status, 0, `Bundled ripgrep exited with ${result.status}: ${result.stderr}`);',
  'assert.match(result.stdout, /^ripgrep \\d+/u, "Bundled ripgrep version output is invalid");',
  'assert.equal(result.stderr, "");',
].join("\n");

const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

async function hashFile(path, expectedBytes) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.byteLength;
    assert.ok(Number.isSafeInteger(bytes), `Standalone production file is too large: ${path}`);
  }
  assert.equal(bytes, expectedBytes, `Standalone production file changed while hashing: ${path}`);
  return { bytes, sha256: hash.digest("hex") };
}

function addRecord(hash, record) {
  hash.update(JSON.stringify(record));
  hash.update("\n");
}

function assertContentShape(content) {
  assert.deepEqual(
    Object.keys(content ?? {}).sort(),
    ["algorithm", "bytes", "directories", "files", "schemaVersion", "sha256"].sort(),
    "Standalone production content attestation has an invalid shape",
  );
  assert.equal(content.schemaVersion, 1, "Standalone production content attestation has an invalid schema");
  assert.equal(content.algorithm, "sha256", "Standalone production content attestation has an invalid algorithm");
  assert.ok(Number.isSafeInteger(content.directories) && content.directories > 0,
    "Standalone production content attestation has an invalid directory count");
  assert.ok(Number.isSafeInteger(content.files) && content.files > 0,
    "Standalone production content attestation has an invalid file count");
  assert.ok(Number.isSafeInteger(content.bytes) && content.bytes > 0,
    "Standalone production content attestation has an invalid byte count");
  assert.ok(content.directories + content.files <= MAX_CONTENT_ENTRIES,
    "Standalone production content attestation exceeds the entry limit");
  assert.match(content.sha256 ?? "", /^[0-9a-f]{64}$/u,
    "Standalone production content attestation has an invalid digest");
}

export async function createStandaloneProductionContent(nodeModulesRoot) {
  const requestedRoot = resolve(nodeModulesRoot);
  const rootMetadata = await lstat(requestedRoot);
  assert.ok(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(),
    "Standalone production content root must be a real directory");
  const root = await realpath(requestedRoot);
  const digest = createHash("sha256");
  let directories = 0;
  let files = 0;
  let bytes = 0;

  const visit = async (directory) => {
    for (const name of (await readdir(directory)).sort(compare)) {
      const absolute = resolve(directory, name);
      const relativePath = relative(root, absolute);
      assert.ok(relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath), `Standalone production content path escapes its root: ${absolute}`);
      const path = relativePath.split(sep).join("/");
      assert.ok(!path.includes("\\") && !path.includes("\0")
        && Buffer.byteLength(path) <= MAX_CONTENT_PATH_BYTES,
      `Standalone production content path is not portable: ${path}`);
      const metadata = await lstat(absolute);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        directories += 1;
        assert.ok(directories + files <= MAX_CONTENT_ENTRIES,
          `Standalone production content exceeds ${MAX_CONTENT_ENTRIES} entries`);
        addRecord(digest, ["directory", path]);
        await visit(absolute);
        continue;
      }

      let source = absolute;
      let fileMetadata = metadata;
      if (metadata.isSymbolicLink()) {
        source = await realpath(absolute);
        const target = relative(root, source);
        assert.ok(target !== ".." && !target.startsWith(`..${sep}`) && !isAbsolute(target),
          `Standalone production content symlink escapes its root: ${absolute}`);
        fileMetadata = await stat(source);
      }
      assert.ok(fileMetadata.isFile(), `Standalone production content contains an unsupported entry: ${absolute}`);
      files += 1;
      assert.ok(directories + files <= MAX_CONTENT_ENTRIES,
        `Standalone production content exceeds ${MAX_CONTENT_ENTRIES} entries`);
      const file = await hashFile(source, fileMetadata.size);
      bytes += file.bytes;
      assert.ok(Number.isSafeInteger(bytes), "Standalone production content exceeds the byte limit");
      addRecord(digest, ["file", path, (fileMetadata.mode & 0o111) === 0 ? 0 : 1, file.bytes, file.sha256]);
    }
  };

  await visit(root);
  const content = {
    schemaVersion: 1,
    algorithm: "sha256",
    directories,
    files,
    bytes,
    sha256: digest.digest("hex"),
  };
  assertContentShape(content);
  return content;
}

export async function assertStandaloneProductionContent(nodeModulesRoot, expected) {
  assertContentShape(expected);
  const actual = await createStandaloneProductionContent(nodeModulesRoot);
  assert.deepEqual(actual, expected, "Standalone production content differs from its attestation");
  return actual;
}

export async function verifyStandaloneProductionCapabilities({
  runtime,
  packageRoot,
  cwd,
  environment,
  label = "standalone production",
}) {
  const requireFromPackage = createRequire(resolve(packageRoot, "package.json"));
  const sharpEntry = requireFromPackage.resolve("sharp");
  const sharp = await runBoundedCommand(runtime, [
    "--input-type=module",
    "--eval",
    SHARP_SMOKE_PROGRAM,
    sharpEntry,
  ], {
    cwd,
    env: environment,
    timeoutMs: 30_000,
    label: `${label} sharp capability check`,
  });
  assert.equal(sharp.stdout, "");
  assert.equal(sharp.stderr, "");

  const ripgrep = await runBoundedCommand(runtime, [
    "--input-type=module",
    "--eval",
    RIPGREP_SMOKE_PROGRAM,
    resolve(packageRoot, "dist/tools/ripgrep.js"),
  ], {
    cwd,
    env: environment,
    timeoutMs: 30_000,
    label: `${label} ripgrep capability check`,
  });
  assert.equal(ripgrep.stdout, "");
  assert.equal(ripgrep.stderr, "");
}
