import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSourceMetadata } from "./verify-source-archive.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUTPUT_MARKER = ".rigyn-release-output.json";
const RELEASE_MANIFEST_KEYS = [
  "schemaVersion", "product", "version", "tag", "packaging", "node", "nodeRuntime", "archive", "archives",
  "source", "standalones", "checksumFile", "releaseNotes", "targets",
];
const MAX_SBOM_BYTES = 16 * 1024 * 1024;

function assertSpdxReleaseSbom(sbom, version) {
  assert.equal(sbom?.spdxVersion, "SPDX-2.3", "Release SBOM must use SPDX 2.3");
  assert.equal(sbom?.dataLicense, "CC0-1.0", "Release SBOM must use the SPDX CC0-1.0 data license");
  assert.equal(sbom?.name, `rigyn-workspace@${version}`, "Release SBOM must describe the matching workspace version");
  assert.equal(sbom?.SPDXID, "SPDXRef-DOCUMENT", "Release SBOM document identity is invalid");
  assert.ok(typeof sbom?.documentNamespace === "string" && sbom.documentNamespace !== "",
    "Release SBOM document namespace is invalid");
  assert.ok(Array.isArray(sbom?.packages) && sbom.packages.length > 0, "Release SBOM must contain packages");
  assert.ok(Array.isArray(sbom?.relationships) && sbom.relationships.length > 0,
    "Release SBOM must contain dependency relationships");
  const packageIds = new Set();
  const roots = [];
  for (const entry of sbom.packages) {
    assert.ok(entry !== null && typeof entry === "object" && !Array.isArray(entry)
      && typeof entry.SPDXID === "string" && /^SPDXRef-[0-9A-Za-z.-]+$/u.test(entry.SPDXID)
      && typeof entry.name === "string" && entry.name !== ""
      && typeof entry.versionInfo === "string" && entry.versionInfo !== "",
    "Release SBOM package identity is invalid");
    assert.equal(packageIds.has(entry.SPDXID), false, `Release SBOM contains duplicate package identity ${entry.SPDXID}`);
    packageIds.add(entry.SPDXID);
    if (entry.name === "rigyn-workspace" && entry.versionInfo === version) roots.push(entry.SPDXID);
  }
  assert.equal(roots.length, 1, "Release SBOM must contain exactly one matching workspace package");

  const knownIds = new Set([sbom.SPDXID, ...packageIds]);
  const graph = new Map([...knownIds].map((id) => [id, new Set()]));
  let describes = 0;
  for (const entry of sbom.relationships) {
    assert.ok(entry !== null && typeof entry === "object" && !Array.isArray(entry)
      && typeof entry.spdxElementId === "string"
      && typeof entry.relatedSpdxElement === "string"
      && typeof entry.relationshipType === "string" && entry.relationshipType !== "",
    "Release SBOM relationship identity is invalid");
    assert.ok(knownIds.has(entry.spdxElementId) && knownIds.has(entry.relatedSpdxElement),
      "Release SBOM relationship references an unknown SPDX element");
    assert.notEqual(entry.spdxElementId, entry.relatedSpdxElement,
      "Release SBOM relationship may not reference itself");
    if (entry.spdxElementId === sbom.SPDXID || entry.relatedSpdxElement === sbom.SPDXID) {
      assert.equal(entry.spdxElementId, sbom.SPDXID,
        "Release SBOM document relationship has an invalid direction");
      assert.equal(entry.relationshipType, "DESCRIBES",
        "Release SBOM document relationship must describe a package");
      assert.ok(packageIds.has(entry.relatedSpdxElement),
        "Release SBOM document relationship must describe a package");
      describes += 1;
      assert.equal(entry.relatedSpdxElement, roots[0],
        "Release SBOM document must describe the matching workspace package");
    } else {
      assert.ok(packageIds.has(entry.spdxElementId) && packageIds.has(entry.relatedSpdxElement),
        "Release SBOM dependency relationship must connect packages");
      assert.ok(["DEPENDENCY_OF", "DEV_DEPENDENCY_OF", "OPTIONAL_DEPENDENCY_OF"].includes(entry.relationshipType),
        "Release SBOM dependency relationship type is invalid");
    }
    graph.get(entry.spdxElementId).add(entry.relatedSpdxElement);
    graph.get(entry.relatedSpdxElement).add(entry.spdxElementId);
  }
  assert.equal(describes, 1, "Release SBOM document must contain one workspace description relationship");
  const reached = new Set([sbom.SPDXID]);
  const pending = [sbom.SPDXID];
  while (pending.length > 0) {
    for (const related of graph.get(pending.shift())) {
      if (reached.has(related)) continue;
      reached.add(related);
      pending.push(related);
    }
  }
  assert.equal(reached.size, knownIds.size, "Release SBOM relationship graph is incomplete");
}

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
  assert.deepEqual(Object.keys(manifest).sort(), [...RELEASE_MANIFEST_KEYS].sort(),
    "Release manifest must retain the schema 4 updater-compatible key set");
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
  const sbomFile = `rigyn-v${manifest.version}.spdx.json`;
  const sbomPath = resolve(directory, sbomFile);
  const rawSbomContents = await readFile(sbomPath);
  assert.ok(rawSbomContents.byteLength > 0 && rawSbomContents.byteLength <= MAX_SBOM_BYTES,
    "Release SBOM has an invalid size");
  const sbomDocument = JSON.parse(rawSbomContents.toString("utf8"));
  assertSpdxReleaseSbom(sbomDocument, manifest.version);
  const sbom = {
    file: sbomFile,
    sha256: createHash("sha256").update(rawSbomContents).digest("hex"),
  };
  const artifacts = [
    ...manifest.archives.map(({ file, sha256 }) => ({ file, sha256 })),
    { file: manifest.source.file, sha256: manifest.source.sha256 },
    ...standalones.map(({ file, sha256 }) => ({ file, sha256 })),
    { file: sbom.file, sha256: sbom.sha256 },
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
  writeFileSync(1,
    `Finalized ${manifest.archives.length} package archives, one source archive, ${standalones.length} standalone archives, and one SPDX SBOM.\n`);
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

export {
  assertSpdxReleaseSbom,
  finalize as finalizeRelease,
  parseArguments as parseFinalizeArguments,
};
