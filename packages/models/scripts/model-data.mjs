import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const MODEL_DATA_MANIFEST_FILE = ".manifest.json";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function providerFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

function validateStructure(structure) {
  assert.ok(structure !== null && typeof structure === "object" && !Array.isArray(structure),
    "Model data structure must be an object");
  for (const [provider, models] of Object.entries(structure)) {
    assert.match(provider, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "Model data contains an invalid provider ID");
    assert.ok(models !== null && typeof models === "object" && !Array.isArray(models),
      `Model data structure for ${provider} must be an object`);
    for (const [id, api] of Object.entries(models)) {
      assert.ok(id !== "" && typeof api === "string" && api !== "", `Model data structure contains an invalid ${provider} model`);
    }
  }
}

function canonicalStructure(structure) {
  return Object.fromEntries(Object.entries(structure).sort(([left], [right]) => left.localeCompare(right)));
}

function modelStructure(directory, files) {
  const structure = {};
  for (const file of files) {
    const provider = file.slice(0, -".json".length);
    const models = JSON.parse(readFileSync(join(directory, file), "utf8"));
    assert.ok(models !== null && typeof models === "object" && !Array.isArray(models), `${file} must contain an object`);
    structure[provider] = Object.fromEntries(Object.entries(models).map(([id, value]) => {
      assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${file}:${id} must contain an object`);
      assert.equal(value.id, id, `${file}:${id} id must match its key`);
      assert.equal(value.provider, provider, `${file}:${id} provider must match its file`);
      assert.ok(typeof value.api === "string" && value.api !== "", `${file}:${id} must contain an API`);
      return [id, value.api];
    }));
  }
  validateStructure(structure);
  return structure;
}

export function createModelDataManifest(structure, data, generatedAt) {
  validateStructure(structure);
  assert.ok(typeof generatedAt === "string" && Number.isFinite(Date.parse(generatedAt)),
    "Model data generation time must be an ISO timestamp");
  const expectedFiles = Object.keys(structure).map((provider) => `${provider}.json`).sort((left, right) => left.localeCompare(right));
  const actualFiles = Object.keys(data).sort((left, right) => left.localeCompare(right));
  assert.deepEqual(actualFiles, expectedFiles, "Model data files must match the provider structure");
  return {
    schemaVersion: 1,
    generatedAt,
    structureHash: sha256(JSON.stringify(canonicalStructure(structure))),
    files: Object.fromEntries(actualFiles.map((file) => [file, sha256(data[file])])),
  };
}

export function readModelDataStructure(packageRoot) {
  const directory = resolve(packageRoot, "src/providers/data");
  return modelStructure(directory, providerFiles(directory));
}

export function validateModelDataDirectory(expectedStructure, directory) {
  validateStructure(expectedStructure);
  const files = providerFiles(directory);
  assert.deepEqual(files, Object.keys(expectedStructure).map((provider) => `${provider}.json`).sort(),
    "Generated provider model files do not match the projected structure");
  assert.deepEqual(modelStructure(directory, files), expectedStructure,
    "Generated provider model data does not match the projected structure");
  const manifest = JSON.parse(readFileSync(join(directory, MODEL_DATA_MANIFEST_FILE), "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), ["files", "generatedAt", "schemaVersion", "structureHash"],
    "Model data manifest contains unsupported fields");
  assert.deepEqual(
    manifest,
    createModelDataManifest(
      expectedStructure,
      Object.fromEntries(files.map((file) => [file, readFileSync(join(directory, file), "utf8")])),
      manifest.generatedAt,
    ),
    "Model data manifest does not match the generated provider data",
  );
}

export function validateGeneratedModelData(packageRoot) {
  const directory = resolve(packageRoot, "src/providers/data");
  validateModelDataDirectory(readModelDataStructure(packageRoot), directory);
}
