import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSourceMetadata } from "./verify-source-archive.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUTPUT_MARKER = ".rigyn-release-output.json";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--directory", "--standalone-directory"].includes(name)) throw new Error(`Unknown argument: ${name ?? ""}`);
    if (value === undefined || value === "") throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} may be specified only once`);
    values.set(name, value);
  }
  for (const name of ["--directory", "--standalone-directory"]) {
    if (!values.has(name)) throw new Error(`${name} is required`);
  }
  return {
    directory: resolve(REPOSITORY_ROOT, values.get("--directory")),
    standaloneDirectory: resolve(REPOSITORY_ROOT, values.get("--standalone-directory")),
  };
}

async function finalize({ directory, standaloneDirectory }) {
  const manifestPath = resolve(directory, "release-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 4, "Unsupported release manifest schema");
  assert.deepEqual(manifest.standalones, [], "Release manifest was already finalized");
  assertSourceMetadata(manifest.source, manifest.version);
  const sourceContents = await readFile(resolve(directory, manifest.source.file));
  assert.equal(sourceContents.byteLength, manifest.source.bytes, "Source archive byte size does not match metadata");
  assert.equal(createHash("sha256").update(sourceContents).digest("hex"), manifest.source.sha256,
    "Source archive checksum does not match metadata");
  const standalones = [];
  for (const target of manifest.targets) {
    const file = `rigyn-v${manifest.version}-${target.platform}-${target.arch}.tar.gz`;
    const metadata = JSON.parse(await readFile(resolve(standaloneDirectory, `${file}.json`), "utf8"));
    assert.deepEqual(Object.keys(metadata).sort(), [
      "arch", "bytes", "entrypoint", "file", "node", "platform", "product", "schemaVersion", "sha256", "version",
    ].sort(), `Standalone metadata has an unexpected schema: ${file}`);
    assert.equal(metadata.schemaVersion, 1);
    assert.equal(metadata.product, manifest.product);
    assert.equal(metadata.version, manifest.version);
    assert.equal(metadata.platform, target.platform);
    assert.equal(metadata.arch, target.arch);
    assert.equal(metadata.node, manifest.nodeRuntime);
    assert.equal(metadata.file, file);
    assert.equal(basename(metadata.file), metadata.file);
    assert.match(metadata.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(metadata.bytes) && metadata.bytes > 0);
    const source = resolve(standaloneDirectory, file);
    const contents = await readFile(source);
    assert.equal(contents.byteLength, metadata.bytes, `${file} byte size does not match metadata`);
    assert.equal(createHash("sha256").update(contents).digest("hex"), metadata.sha256, `${file} checksum does not match metadata`);
    await copyFile(source, resolve(directory, file));
    standalones.push(metadata);
  }
  manifest.standalones = standalones;
  const artifacts = [
    ...manifest.archives.map(({ file, sha256 }) => ({ file, sha256 })),
    { file: manifest.source.file, sha256: manifest.source.sha256 },
    ...standalones.map(({ file, sha256 }) => ({ file, sha256 })),
  ];
  await Promise.all([
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }),
    writeFile(resolve(directory, manifest.checksumFile), artifacts.map(({ file, sha256 }) => `${sha256}  ${file}\n`).join(""), { mode: 0o600 }),
    writeFile(resolve(directory, OUTPUT_MARKER), `${JSON.stringify({
      product: manifest.product,
      schemaVersion: 2,
      version: manifest.version,
      archives: artifacts,
    }, null, 2)}\n`, { mode: 0o600 }),
  ]);
  writeFileSync(1, `Finalized ${manifest.archives.length} package archives, one source archive, and ${standalones.length} standalone archives.\n`);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await finalize(parseArguments(process.argv.slice(2)));
  } catch (error) {
    writeFileSync(2, `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export { finalize as finalizeRelease, parseArguments as parseFinalizeArguments };
